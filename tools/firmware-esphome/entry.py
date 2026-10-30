#!/usr/bin/env python3
"""WireHub tool pack `firmware-esphome`: compile an ESPHome YAML config offline.

Contract: docs/tool-packs.md (native tool-pack contract v0).

    wirehub-firmware compile /work/in/request.json

Request params: `defines` (become ESPHome substitutions, `-s NAME value`), `config` (which
input is the main YAML; default `config.yaml`, else the only/first top-level .yaml). Inputs may
also hold included files, `secrets.yaml` (synthetic values only), or one .zip / .tar.gz. The
build runs offline; a failed build is an honest `failed` manifest with exit code 0.
Compiling never touches a device: there is no upload/flash/logs op.
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
TARGETS = {t["id"]: t for t in PACK_CONFIG["targets"]}
IN = Path("/work/in")
OUT = Path(os.environ.get("WIREHUB_OUT", "/work/out"))
CORE = Path(os.environ.get("PLATFORMIO_CORE_DIR", "/opt/pio"))
SCRATCH = Path("/tmp/wirehub-firmware")
TIMEOUT_S = int(os.environ.get("WIREHUB_FIRMWARE_TIMEOUT", "1500"))

# esphome build dir file -> (output name, role, media type)
ARTIFACTS = [
    ("firmware.factory.bin", "firmware.factory.bin", "firmware", "application/octet-stream"),
    ("firmware.ota.bin", "firmware.ota.bin", "firmware", "application/octet-stream"),
    ("firmware.bin", "firmware.bin", "firmware", "application/octet-stream"),
    ("firmware.elf", "firmware.elf", "debug-image", "application/x-elf"),
]
SUBST_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
SUBST_VALUE = re.compile(r"^[A-Za-z0-9 _.,:/+@#-]{0,128}$")
SIZE_LINE = re.compile(r"^(RAM|Flash):\s+\[.*?\]\s+([\d.]+)%\s+\(used (\d+) bytes from (\d+) bytes\)", re.M)


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


def esphome_version() -> str:
    from importlib.metadata import version  # noqa: PLC0415

    return version("esphome")


def toolchain_identity() -> dict:
    def manifests(kind: str) -> list[dict]:
        items = []
        root = CORE / kind
        if root.is_dir():
            for d in sorted(root.iterdir()):
                for name in ("platform.json", "package.json"):
                    f = d / name
                    if f.exists():
                        data = json.loads(f.read_text())
                        items.append({"name": data.get("name", d.name), "version": data.get("version", "?")})
                        break
        return items

    return {"esphome": esphome_version(), "platforms": manifests("platforms"), "packages": manifests("packages")}


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        print("targets:", ", ".join(f"{k} ({v['label']})" for k, v in TARGETS.items()))
        return 0
    op = sys.argv[1]
    if op == "identity":
        print(json.dumps({"pack": PACK, "packVersion": PACK_VERSION, "targets": TARGETS, "toolchain": toolchain_identity()}, indent=2))
        return 0
    request = json.loads(Path(sys.argv[2] if len(sys.argv) > 2 else IN / "request.json").read_text())
    params = request.get("params") or {}
    OUT.mkdir(parents=True, exist_ok=True)
    findings: list[dict] = []
    outputs: list[dict] = []
    input_rows: list[dict] = []
    log_lines: list[str] = []
    identity = toolchain_identity()

    def finish(status: str) -> int:
        (OUT / "log.txt").write_text("\n".join(log_lines) + "\n")
        manifest = {
            "pack": PACK, "packVersion": PACK_VERSION,
            "tool": {"name": "esphome", "version": identity["esphome"]},
            "toolchain": identity,
            "op": op, "inputs": input_rows, "outputs": outputs, "log": "log.txt",
            "status": status, "findings": findings,
        }
        (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        return 0

    if op != "compile":
        findings.append({"level": "error", "message": f"Unknown op {op!r}; this pack offers 'compile'."})
        return finish("failed")

    project = SCRATCH / "project"
    shutil.rmtree(SCRATCH, ignore_errors=True)
    project.mkdir(parents=True)
    try:
        for item in request.get("inputs") or []:
            rel = safe_rel(item["path"])
            src = IN / rel
            actual = sha256(src)
            input_rows.append({"path": str(rel), "sha256": actual})
            if item.get("sha256") and item["sha256"] != actual:
                findings.append({"level": "error", "message": f"Input {rel} does not match its recorded sha256."})
                return finish("failed")
            if rel.name.lower().endswith((".zip", ".tar", ".tar.gz", ".tgz")):
                extract(src, project)
            else:
                dst = project / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dst)
        subst = []
        for name, value in sorted((params.get("defines") or {}).items()):
            if not SUBST_NAME.match(name):
                raise ValueError(f"substitution name {name!r}: letters, digits and _ only")
            text = ("true" if value else "false") if isinstance(value, bool) else "" if value is None else str(value)
            if not SUBST_VALUE.match(text):
                raise ValueError(f"substitution {name}: text may hold letters, digits, space and _ . , : / + @ # - only")
            subst += ["-s", name, text]
    except (ValueError, KeyError, OSError, tarfile.TarError, zipfile.BadZipFile) as error:
        findings.append({"level": "error", "message": f"Inputs refused: {error}"})
        return finish("failed")

    # the main YAML: a lone wrapping folder is stepped into
    root = project
    while not list(root.glob("*.yaml")) and len([e for e in root.iterdir()]) == 1 and next(root.iterdir()).is_dir():
        root = next(root.iterdir())
    wanted = params.get("config")
    candidates = [p for p in sorted(root.glob("*.yaml")) if p.name != "secrets.yaml"]
    main_yaml = root / wanted if wanted else (root / "config.yaml" if (root / "config.yaml").exists() else (candidates[0] if candidates else None))
    if main_yaml is None or not main_yaml.is_file() or root.resolve() not in main_yaml.resolve().parents:
        findings.append({"level": "error", "message": "No ESPHome YAML found: provide config.yaml (or name it in params.config)."})
        return finish("failed")
    if len(candidates) > 1 and not wanted and main_yaml.name != "config.yaml":
        findings.append({"level": "warn", "message": f"Several YAML files and no config.yaml: using {main_yaml.name}."})
    if "!secret" in main_yaml.read_text(errors="replace") and not (root / "secrets.yaml").exists():
        findings.append({"level": "warn", "message": "The config uses !secret but no secrets.yaml was supplied; validation will fail. Use synthetic values only."})

    core = SCRATCH / "core"
    core.mkdir()
    for kind in ("platforms", "packages"):
        if (CORE / kind).exists():
            (core / kind).symlink_to(CORE / kind)
    # ESPHome keeps its ESP-IDF framework in $XDG_CACHE_HOME/esphome (read-only here, at its original
    # path); the one directory it writes is a symlink into scratch.
    cache_src = Path(os.environ.get("XDG_CACHE_HOME", "/opt/cache"))
    (SCRATCH / "idf-component-lists").mkdir(exist_ok=True)
    run_env = {**os.environ, "PLATFORMIO_CORE_DIR": str(core), "HOME": str(SCRATCH)}
    # ESP32 (ESP-IDF) builds fetch "managed components" (Arduino core, mdns, …) from a registry. The image
    # carries a copy, but the component manager's lock is keyed on the absolute build path, so an ESP32
    # build is pinned to the seed's path (esphome: build_path) and the copy is placed there.
    seed = cache_src / "seed-esp32"
    seed_build = Path("/tmp/seed/.esphome/build/seed-esp32")
    target_yaml = main_yaml.name
    uses_seed = seed.is_dir() and re.search(r"^esp32:", main_yaml.read_text(errors="replace"), re.M) is not None
    if uses_seed:
        wrapper = main_yaml.parent / "wirehub-build.yaml"
        wrapper.write_text(f"packages:\n  user: !include {main_yaml.name}\nesphome:\n  build_path: {seed_build}\n")
        target_yaml = wrapper.name
    cmd = ["esphome", *subst, "compile", target_yaml]
    log_lines.append(f"$ {' '.join(cmd)}")

    def build() -> int:
        proc = subprocess.run(cmd, env=run_env, cwd=main_yaml.parent, capture_output=True, text=True, timeout=TIMEOUT_S)
        log_lines.append(proc.stdout)
        if proc.stderr:
            log_lines.append(proc.stderr)
        return proc.returncode

    try:
        code = build()
        if code != 0 and uses_seed and "component registry" in "\n".join(log_lines):
            # ESPHome clears a build directory it has not seen, so the image's copy goes in after that run
            shutil.copytree(seed / "managed_components", seed_build / "managed_components", dirs_exist_ok=True)
            shutil.copyfile(seed / "dependencies.lock", seed_build / "dependencies.lock")
            shutil.rmtree(seed_build / "build", ignore_errors=True)  # the failed configure's cache
            log_lines.append("# retrying with the image's ESP-IDF managed components")
            code = build()
    except subprocess.TimeoutExpired:
        findings.append({"level": "error", "message": f"The build ran longer than {TIMEOUT_S} s and was stopped."})
        return finish("failed")
    log_text = "\n".join(log_lines)
    if code != 0:
        if re.search(r"(Could not resolve|HTTPClientError|Name or service not known|InternetIsOffline|Max retries exceeded|Temporary failure in name resolution|Connection refused)", log_text):
            findings.append({"level": "error", "message": "The build tried to download a package and had no network. This image carries ESP32 and ESP8266 (Arduino) toolchains and common component libraries only."})
        for ln in [ln.strip() for ln in log_text.splitlines() if re.search(r"\b(error|failed)\b", ln, re.I)][:5]:
            findings.append({"level": "error", "message": ln[:300]})
        findings.append({"level": "error", "message": f"esphome compile exited {code}; see the build log."})
        return finish("failed")

    bdirs = [seed_build] if uses_seed else [d for d in sorted((main_yaml.parent / ".esphome" / "build").glob("*")) if d.is_dir()]
    cands = [c for bd in bdirs for c in [bd / "build", *sorted((bd / ".pioenvs").glob("*"))] if c.is_dir()]
    cands = [c for c in cands if any((c / a[0]).exists() for a in ARTIFACTS)]
    if not cands:
        findings.append({"level": "error", "message": "The build finished but left no build directory."})
        return finish("failed")
    d = cands[0]
    seen = set()
    for src_name, out_name, role, media in ARTIFACTS:
        f = d / src_name
        if f.exists() and out_name not in seen:
            dst = OUT / out_name
            shutil.copyfile(f, dst)
            outputs.append({"path": out_name, "sha256": sha256(dst), "role": role, "mediaType": media})
            seen.add(out_name)
    size = {k.lower(): {"used": int(u), "total": int(t)} for k, _p, u, t in SIZE_LINE.findall(log_text)}
    (OUT / "size.json").write_text(json.dumps({"environments": [d.name if d.parent.name == ".pioenvs" else d.parent.name], **size, "source": "PlatformIO's post-build size summary"}, indent=2) + "\n")
    outputs.append({"path": "size.json", "sha256": sha256(OUT / "size.json"), "role": "size-report", "mediaType": "application/json"})
    if not any(o["role"] == "firmware" for o in outputs):
        findings.append({"level": "error", "message": "The build finished but produced no firmware image."})
        return finish("failed")
    for kind, s in size.items():
        findings.append({"level": "info", "message": f"{kind.upper()}: {s['used']} of {s['total']} bytes ({100 * s['used'] / s['total']:.1f}%)."})
    findings.append({"level": "info", "message": "Compiled only. Nothing was flashed, uploaded or run on a device. Build: " + d.parent.name})
    return finish("ok")


if __name__ == "__main__":
    sys.exit(main())
