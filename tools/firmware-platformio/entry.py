#!/usr/bin/env python3
"""WireHub tool pack `firmware-platformio`: compile a PlatformIO project.

Contract: docs/tool-packs.md (native tool-pack contract v0).

    wirehub-firmware compile /work/in/request.json

Reads the request, copies the project into a scratch directory (the image is
read-only), builds one environment offline and writes the binaries, a size
report, the build log and /work/out/manifest.json. A build that fails is an
honest `failed` manifest with exit code 0; only a crash of this script exits
non-zero. Compiling never touches a device: there is no upload/flash op.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

PACK_CONFIG = json.loads(Path(os.environ.get("WIREHUB_PACK_JSON", "/etc/wirehub/pack.json")).read_text())
PACK = PACK_CONFIG["pack"]
PACK_VERSION = PACK_CONFIG["packVersion"]
IN = Path("/work/in")
OUT = Path(os.environ.get("WIREHUB_OUT", "/work/out"))
CORE = Path(os.environ.get("PLATFORMIO_CORE_DIR", "/opt/pio"))
SCRATCH = Path("/tmp/wirehub-firmware")
TIMEOUT_S = int(os.environ.get("WIREHUB_FIRMWARE_TIMEOUT", "900"))

# Targets installed in this image: declared in pack.json (also the source of the UI's target list).
TARGETS = {t["id"]: t for t in PACK_CONFIG["targets"]}
ARTIFACTS = {
    "firmware.bin": ("firmware", "application/octet-stream"),
    "firmware.hex": ("firmware", "text/x-hex"),
    "firmware.uf2": ("firmware", "application/x-uf2"),
    "firmware.elf": ("debug-image", "application/x-elf"),
}
DEFINE_NAME = re.compile(r"^[A-Z_][A-Z0-9_]{0,63}$")
STRING_VALUE = re.compile(r"^[A-Za-z0-9 _.,:/+@#-]{0,128}$")
ENV_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_rel(path: str) -> PurePosixPath:
    p = PurePosixPath(path)
    if path == "" or p.is_absolute() or ".." in p.parts:
        raise ValueError(f"unsafe path {path!r}")
    return p


def extract(archive: Path, dest: Path) -> None:
    """Unpack a .zip / .tar(.gz) project, refusing links and paths that escape."""
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                rel = safe_rel(info.filename)
                if info.is_dir():
                    continue
                target = dest / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(info) as src, target.open("wb") as dst:
                    shutil.copyfileobj(src, dst)
        return
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError(f"archive entry {member.name!r} is a link or device")
            rel = safe_rel(member.name)
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            src = t.extractfile(member)
            assert src is not None
            with target.open("wb") as dst:
                shutil.copyfileobj(src, dst)


def project_root(base: Path) -> Path:
    """The directory holding platformio.ini: the base, or the one top-level folder an archive wrapped it in."""
    if (base / "platformio.ini").exists():
        return base
    found = sorted(base.rglob("platformio.ini"), key=lambda p: len(p.parts))
    if found:
        return found[0].parent
    # a bare sketch: step into single wrapping folders until src/ (or several entries) shows up
    while not (base / "src").is_dir():
        entries = list(base.iterdir())
        if len(entries) != 1 or not entries[0].is_dir():
            break
        base = entries[0]
    return base


def define_flags(defines: dict) -> list[str]:
    flags = []
    for name, value in sorted(defines.items()):
        if not DEFINE_NAME.match(name):
            raise ValueError(f"define name {name!r}: use A-Z, 0-9 and _ (a C macro name)")
        if isinstance(value, bool):
            flags.append(f"-D{name}={1 if value else 0}")
        elif isinstance(value, (int, float)):
            flags.append(f"-D{name}={value}")
        elif isinstance(value, str):
            if not STRING_VALUE.match(value):
                raise ValueError(f"define {name}: text may hold letters, digits, space and _ . , : / + @ # - only")
            flags.append(f"-D{name}='\"{value}\"'")
        elif value is None:
            flags.append(f"-D{name}")
        else:
            raise ValueError(f"define {name}: a number, true/false, short text or null")
    return flags


def toolchain_identity() -> dict:
    """The exact platform and package versions installed in this image."""
    def manifests(kind: str) -> list[dict]:
        items = []
        root = CORE / kind
        if not root.is_dir():
            return items
        for d in sorted(root.iterdir()):
            for name in ("platform.json", "package.json"):
                f = d / name
                if f.exists():
                    data = json.loads(f.read_text())
                    items.append({"name": data.get("name", d.name), "version": data.get("version", "?")})
                    break
        return items
    import platformio  # noqa: PLC0415

    return {"platformio": platformio.__version__, "platforms": manifests("platforms"), "packages": manifests("packages")}


SIZE_LINE = re.compile(r"^(RAM|Flash):\s+\[.*?\]\s+([\d.]+)%\s+\(used (\d+) bytes from (\d+) bytes\)", re.M)


def size_report(log: str) -> dict:
    report = {}
    for kind, _pct, used, total in SIZE_LINE.findall(log):
        report[kind.lower()] = {"used": int(used), "total": int(total)}
    return report


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        print("targets:", ", ".join(f"{k} ({v['label']})" for k, v in TARGETS.items()))
        return 0
    op = sys.argv[1]
    if op == "identity":
        print(json.dumps({"pack": PACK, "packVersion": PACK_VERSION, "targets": TARGETS, "toolchain": toolchain_identity()}, indent=2))
        return 0
    request_path = Path(sys.argv[2] if len(sys.argv) > 2 else IN / "request.json")
    request = json.loads(request_path.read_text())
    params = request.get("params") or {}
    inputs = request.get("inputs") or []
    OUT.mkdir(parents=True, exist_ok=True)
    log_path = OUT / "log.txt"
    findings: list[dict] = []
    outputs: list[dict] = []
    input_rows: list[dict] = []
    log_lines: list[str] = []

    def finish(status: str) -> int:
        log_path.write_text("\n".join(log_lines) + "\n")
        manifest = {
            "pack": PACK, "packVersion": PACK_VERSION,
            "tool": {"name": "platformio", "version": identity["platformio"]},
            "toolchain": identity,
            "op": op, "inputs": input_rows, "outputs": outputs, "log": "log.txt",
            "status": status, "findings": findings,
        }
        (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return 0

    identity = toolchain_identity()
    if op != "compile":
        findings.append({"level": "error", "message": f"Unknown op {op!r}; this pack offers 'compile'."})
        return finish("failed")

    # 1. inputs: verify each hash, then lay the project out in scratch
    project = SCRATCH / "project"
    shutil.rmtree(SCRATCH, ignore_errors=True)
    project.mkdir(parents=True)
    try:
        for item in inputs:
            rel = safe_rel(item["path"])
            src = IN / rel
            actual = sha256(src)
            input_rows.append({"path": str(rel), "sha256": actual})
            if item.get("sha256") and item["sha256"] != actual:
                findings.append({"level": "error", "message": f"Input {rel} does not match its recorded sha256."})
                return finish("failed")
            name = rel.name.lower()
            if name.endswith((".zip", ".tar", ".tar.gz", ".tgz")):
                extract(src, project)
            else:
                dst = project / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
        flags = define_flags(params.get("defines") or {})
    except (ValueError, KeyError, OSError, tarfile.TarError, zipfile.BadZipFile) as error:
        findings.append({"level": "error", "message": f"Inputs refused: {error}"})
        return finish("failed")

    root = project_root(project)
    if not (root / "src").is_dir():
        # loose sources (files uploaded one by one, without their folder): PlatformIO builds src/
        loose = [f for f in root.iterdir() if f.is_file() and f.suffix in (".ino", ".c", ".cpp", ".h", ".hpp")]
        if loose:
            (root / "src").mkdir()
            for f in loose:
                f.rename(root / "src" / f.name)
            findings.append({"level": "info", "message": f"Moved {len(loose)} loose source file(s) into src/."})
    env = params.get("environment")
    target = params.get("target")
    ini = root / "platformio.ini"
    if not ini.exists():
        # a bare sketch: make the project file from the chosen supported target
        if target not in TARGETS:
            findings.append({"level": "error", "message": f"No platformio.ini and no supported target. Choose one of: {', '.join(TARGETS)}."})
            return finish("failed")
        t = TARGETS[target]
        ini.write_text("\n".join([f"[env:{target}]", f"platform = {t['platform']}", f"board = {t['board']}", f"framework = {t['framework']}", *t.get("ini", [])]) + "\n")
        env = env or target
        findings.append({"level": "info", "message": f"No platformio.ini in the source: generated one for {t['label']}."})
    if env is not None and not ENV_NAME.match(str(env)):
        findings.append({"level": "error", "message": "The environment name may hold letters, digits, _ and - only."})
        return finish("failed")
    ini_text = ini.read_text(errors="replace")
    if "lib_deps" in ini_text and not params.get("networkAllowed"):
        findings.append({"level": "warn", "message": "platformio.ini declares lib_deps: libraries not in this image need network access, which this run does not have. Vendor them under lib/ or enable the network opt-in."})

    # 2. the core directory: the image's packages through symlinks, the rest writable in /tmp
    core = SCRATCH / "core"
    core.mkdir()
    for kind in ("platforms", "packages"):
        if (CORE / kind).exists():
            (core / kind).symlink_to(CORE / kind)
    for f in ("appstate.json",):
        if (CORE / f).exists():
            shutil.copyfile(CORE / f, core / f)
    run_env = {**os.environ, "PLATFORMIO_CORE_DIR": str(core), "HOME": str(SCRATCH), "PLATFORMIO_BUILD_FLAGS": " ".join(flags)}
    cmd = ["pio", "run", "--project-dir", str(root)] + (["--environment", str(env)] if env else [])
    log_lines.append(f"$ {' '.join(cmd)}")
    if flags:
        log_lines.append(f"# build flags from the request: {' '.join(flags)}")
    try:
        proc = subprocess.run(cmd, env=run_env, cwd=root, capture_output=True, text=True, timeout=TIMEOUT_S)
        log_lines.append(proc.stdout)
        if proc.stderr:
            log_lines.append(proc.stderr)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        findings.append({"level": "error", "message": f"The build ran longer than {TIMEOUT_S} s and was stopped."})
        return finish("failed")
    log_text = "\n".join(log_lines)
    if code != 0:
        if re.search(r"(Could not resolve|HTTPClientError|Name or service not known|InternetIsOffline|Max retries exceeded)", log_text):
            findings.append({"level": "error", "message": "The build tried to download a package and had no network. Vendor the dependency or enable the network opt-in."})
        else:
            errs = [ln.strip() for ln in log_text.splitlines() if re.search(r"\berror\b", ln, re.I)][:5]
            for e in errs:
                findings.append({"level": "error", "message": e[:300]})
        findings.append({"level": "error", "message": f"pio run exited {code}; see the build log."})
        return finish("failed")

    # 3. outputs: the binaries of each built environment, the size report
    build = root / ".pio" / "build"
    envs = sorted(d for d in build.iterdir() if d.is_dir()) if build.is_dir() else []
    for d in envs:
        for name, (role, media) in ARTIFACTS.items():
            f = d / name
            if f.exists():
                rel = f"{d.name}/{name}" if len(envs) > 1 else name
                dst = OUT / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(f, dst)
                outputs.append({"path": rel, "sha256": sha256(dst), "role": role, "mediaType": media})
    size = size_report(log_text)
    size_doc = {"environments": [d.name for d in envs], **size, "source": "PlatformIO's post-build size summary"}
    (OUT / "size.json").write_text(json.dumps(size_doc, indent=2) + "\n")
    outputs.append({"path": "size.json", "sha256": sha256(OUT / "size.json"), "role": "size-report", "mediaType": "application/json"})
    if not any(o["role"] == "firmware" for o in outputs):
        findings.append({"level": "error", "message": "The build finished but produced no firmware image."})
        return finish("failed")
    for kind, s in size.items():
        findings.append({"level": "info", "message": f"{kind.upper()}: {s['used']} of {s['total']} bytes ({100 * s['used'] / s['total']:.1f}%)."})
    findings.append({"level": "info", "message": "Compiled only. Nothing was flashed or run on a device."})
    return finish("ok")


if __name__ == "__main__":
    sys.exit(main())
