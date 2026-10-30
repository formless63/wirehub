#!/usr/bin/env python3
"""WireHub tool pack `kicad`: board outputs from a native .kicad_pcb with kicad-cli.

Contract v0 (tools/README.md): invoked as `<image> <op> /work/in/request.json`,
reads only /work/in (read-only), writes only /work/out (manifest.json, log.txt
and the outputs) and /tmp. No network. Exit code 0 even when the op fails
honestly (status "failed" in the manifest); non-zero means the pack crashed.

Ops:
  board-render  top/bottom SVG (`pcb export svg`), optional PNG (`pcb render`)
  board-3d      STEP and GLB (`pcb export step|glb`), board body plus any
                component models the image can resolve
  fab           Gerbers + drill files as one zip, a position file (CSV) and a
                footprint BOM (CSV) read from the board itself
  netlist       the nets as KiCad has them, per part and pad: the board's
                (pcbnew) and, when .kicad_sch inputs are given, the
                schematic's (`sch export netlist`, kicadxml) — `nets.json`
                plus the raw `schematic.xml`. It compares nothing: the
                studio sets these beside the board record.
"""

import csv
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
import zipfile

import repro

PACK = "kicad"
PACK_VERSION = os.environ.get("WIREHUB_PACK_VERSION", "dev")
OUT = "/work/out"
IN = "/work/in"
LOG_PATH = os.path.join(OUT, "log.txt")

log_lines = []
findings = []
outputs = []
# the one creation time every output carries (repro.py), set from the request in main()
STAMP = repro.stamp_of({})


def log(line):
    log_lines.append(line)


def finding(level, message):
    if not any(f["message"] == message for f in findings):
        findings.append({"level": level, "message": message})


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def add_output(rel, role, media_type):
    path = os.path.join(OUT, rel)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        finding("error", f"{rel} was not produced")
        return False
    outputs.append({"path": rel, "sha256": sha256_file(path), "role": role, "mediaType": media_type, "size": os.path.getsize(path)})
    return True


def run(args):
    """Run kicad-cli; its output goes to the log. Returns (code, text)."""
    log("$ " + " ".join(args))
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp")
    text = proc.stdout or ""
    for line in text.splitlines():
        log("  " + line)
    if proc.returncode != 0:
        log(f"  (exit {proc.returncode})")
    return proc.returncode, text


def missing_models(text):
    missing = sorted(set(re.findall(r"File not found: (.+)", text)))
    if missing:
        finding("warn", f"{len(missing)} component model file(s) not available in the pack; the board body is exported without them")
        for m in missing[:20]:
            log(f"  missing model: {m}")


def tool_version():
    try:
        return subprocess.run(["kicad-cli", "version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True).stdout.strip()
    except OSError:
        return "unknown"


FRONT = ["F.Cu", "F.Paste", "F.Mask", "F.SilkS", "Edge.Cuts"]
BACK = ["B.Cu", "B.Paste", "B.Mask", "B.SilkS", "Edge.Cuts"]


def crop_transparent(path, pad=0.04):
    """Trim the wide transparent margin `pcb render` leaves, keeping a small even border."""
    try:
        from PIL import Image
        img = Image.open(path).convert("RGBA")
        box = img.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox()
        if box is None:
            return
        w, h = box[2] - box[0], box[3] - box[1]
        m = max(2, int(max(w, h) * pad))
        box = (max(0, box[0] - m), max(0, box[1] - m), min(img.width, box[2] + m), min(img.height, box[3] + m))
        if box != (0, 0, img.width, img.height):
            img.crop(box).save(path, optimize=True)
    except Exception as exc:  # cropping is cosmetic; keep the raw render
        finding("info", f"render crop skipped: {exc}")


def op_board_render(board, params):
    for side, layers in (("top", FRONT), ("bottom", BACK)):
        rel = f"board-{side}.svg"
        args = ["kicad-cli", "pcb", "export", "svg", "--mode-single", "--layers", ",".join(layers),
                "--exclude-drawing-sheet", "--fit-page-to-board", "--drill-shape-opt", "2", "-o", os.path.join(OUT, rel)]
        if side == "bottom":
            args.append("--mirror")
        code, _ = run(args + [board])
        if code == 0:
            repro.normalise_text_dates(os.path.join(OUT, rel), STAMP)
            add_output(rel, f"board-{side}-svg", "image/svg+xml")
        else:
            finding("error", f"SVG export of the {side} side failed")
    if params.get("png", True):
        width = int(params.get("width", 1600))
        height = int(params.get("height", 1000))
        for side in ("top", "bottom"):
            rel = f"render-{side}.png"
            code, text = run(["kicad-cli", "pcb", "render", "--side", side, "--width", str(width), "--height", str(height),
                              "--background", "transparent", "--quality", "basic", "-o", os.path.join(OUT, rel), board])
            missing_models(text)
            if code == 0:
                crop_transparent(os.path.join(OUT, rel))
                add_output(rel, f"render-{side}", "image/png")
            else:
                finding("warn", f"3D render of the {side} side failed (the SVG artwork is unaffected)")


def op_board_3d(board, params):
    formats = params.get("formats", ["step", "glb"])
    for fmt in formats:
        if fmt not in ("step", "glb"):
            finding("error", f"unknown 3D format {fmt}")
            continue
        rel = f"board.{fmt}"
        args = ["kicad-cli", "pcb", "export", fmt, "-o", os.path.join(OUT, rel)]
        if fmt == "step":
            args += ["--subst-models"]
        code, text = run(args + [board])
        missing_models(text)
        if code == 0:
            reproducible(fmt, os.path.join(OUT, rel))
            add_output(rel, f"model-{fmt}", "model/step" if fmt == "step" else "model/gltf-binary")
        else:
            finding("error", f"{fmt.upper()} export failed")


def reproducible(fmt, path):
    """Same inputs, same bytes: fixed creation stamps, STEP entities renumbered canonically."""
    try:
        if fmt == "step":
            log(f"  {os.path.basename(path)}: {repro.normalise_step(path, STAMP)}")
        elif fmt == "glb":
            repro.normalise_glb(path, STAMP)
    except Exception as exc:  # noqa: BLE001 (the export stands as written)
        finding("info", f"{os.path.basename(path)} left as written (not normalised: {exc})")


def deterministic_zip(src_dir, dest):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(os.listdir(src_dir)):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(os.path.join(src_dir, name), "rb") as f:
                z.writestr(info, f.read())


def footprint_bom(board, dest):
    """A BOM grouped by value + footprint, read from the board (no schematic needed)."""
    try:
        import pcbnew  # noqa: PLC0415 (only in the image)
    except ImportError:
        finding("warn", "pcbnew Python module unavailable; no BOM")
        return False
    b = pcbnew.LoadBoard(board)
    groups = {}
    skipped = 0
    for fp in b.GetFootprints():
        attrs = fp.GetAttributes()
        if attrs & getattr(pcbnew, "FP_EXCLUDE_FROM_BOM", 0):
            skipped += 1
            continue
        key = (fp.GetValue(), str(fp.GetFPID().GetUniStringLibId()))
        groups.setdefault(key, []).append(fp.GetReference())
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["References", "Value", "Footprint", "Quantity"])
    natural = lambda r: [int(t) if t.isdigit() else t for t in re.split(r"(\d+)", r)]  # noqa: E731
    for (value, footprint), refs in sorted(groups.items(), key=lambda kv: natural(sorted(kv[1], key=natural)[0])):
        refs = sorted(refs, key=natural)
        w.writerow([" ".join(refs), value, footprint, len(refs)])
    with open(dest, "w", encoding="utf-8") as f:
        f.write(buf.getvalue())
    if skipped:
        log(f"  {skipped} footprint(s) excluded from the BOM by their attributes")
    return True


def op_fab(board, params):
    gdir = "/tmp/gerbers"
    os.makedirs(gdir, exist_ok=True)
    code_g, _ = run(["kicad-cli", "pcb", "export", "gerbers", "--no-protel-ext", "-o", gdir + "/", board])
    code_d, _ = run(["kicad-cli", "pcb", "export", "drill", "--format", "excellon", "--generate-map", "--map-format", "gerberx2", "-o", gdir + "/", board])
    if code_g == 0 and code_d == 0 and os.listdir(gdir):
        for name in os.listdir(gdir):
            repro.normalise_text_dates(os.path.join(gdir, name), STAMP)
        deterministic_zip(gdir, os.path.join(OUT, "fab-gerbers.zip"))
        add_output("fab-gerbers.zip", "fab-gerbers", "application/zip")
        log(f"  zipped {len(os.listdir(gdir))} fabrication file(s)")
    else:
        finding("error", "Gerber or drill export failed")
    code, _ = run(["kicad-cli", "pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both",
                   "-o", os.path.join(OUT, "fab-positions.csv"), board])
    if code == 0:
        add_output("fab-positions.csv", "fab-positions", "text/csv")
    else:
        finding("warn", "position file export failed")
    if params.get("bom", True):
        if footprint_bom(board, os.path.join(OUT, "fab-bom.csv")):
            add_output("fab-bom.csv", "fab-bom", "text/csv")
            finding("info", "BOM grouped from the board's footprints (value + footprint), not from a schematic")


NETS_FORMAT = "wirehub.kicad-nets"


def pcb_nets(board):
    """Each footprint's pads and the net KiCad has each on ("" = no net)."""
    import pcbnew  # noqa: PLC0415 (only in the image)
    b = pcbnew.LoadBoard(board)
    parts = {}
    for fp in b.GetFootprints():
        ref = fp.GetReference()
        if ref == "" or ref.startswith("#"):
            continue
        pads = {}
        for pad in fp.Pads():
            num = str(pad.GetNumber())
            if num == "":
                continue
            net = pad.GetNetname() or ""
            if pads.get(num, "") == "":
                pads[num] = net
        entry = {"value": fp.GetValue(), "footprint": str(fp.GetFPID().GetUniStringLibId()), "pads": pads}
        if getattr(fp, "IsDNP", None) is not None and fp.IsDNP():
            entry["dnp"] = True
        if ref in parts:
            parts[ref]["pads"].update({k: v for k, v in pads.items() if parts[ref]["pads"].get(k, "") == ""})
        else:
            parts[ref] = entry
    return {"parts": parts}


SHEETFILE = re.compile(r'\(property\s+"Sheet ?[Ff]ile"\s+"([^"]+)"')


def root_schematic(paths, board):
    """The sheet no other sheet names; of several, the one named like the board."""
    names = {os.path.basename(p): p for p in paths}
    named = set()
    for p in paths:
        with open(p, encoding="utf-8", errors="replace") as f:
            named.update(os.path.basename(n) for n in SHEETFILE.findall(f.read()))
    roots = [p for n, p in sorted(names.items()) if n not in named] or sorted(paths)
    stem = os.path.splitext(os.path.basename(board or ""))[0]
    for p in roots:
        if os.path.splitext(os.path.basename(p))[0] == stem:
            return p
    if len(roots) > 1:
        finding("warn", f"{len(roots)} top-level schematics; read {os.path.basename(roots[0])}")
    return roots[0]


def schematic_nets(xml_path):
    """kicadxml → parts (value, footprint, pins → net) and the sheet names."""
    root = ET.parse(xml_path).getroot()
    parts = {}
    for comp in root.iter("comp"):
        ref = comp.get("ref", "")
        if ref == "" or ref.startswith("#"):
            continue
        props = {p.get("name", "").lower() for p in comp.iter("property")}
        entry = {"value": (comp.findtext("value") or ""), "footprint": (comp.findtext("footprint") or ""), "pins": {}}
        if "dnp" in props:
            entry["dnp"] = True
        if "exclude_from_board" in props:
            entry["notOnBoard"] = True
        parts[ref] = entry
    nets = 0
    for net in root.iter("net"):
        nets += 1
        name = net.get("name", "")
        for node in net.iter("node"):
            ref, pin = node.get("ref", ""), node.get("pin", "")
            if ref in parts and pin != "":
                parts[ref]["pins"][pin] = name
    sheets = [s.get("name", "") for s in root.iter("sheet")]
    return {"parts": parts, "sheets": sheets}, nets


def op_netlist(board, params, schematics=()):
    result = {"format": NETS_FORMAT, "version": 1}
    try:
        result["pcb"] = {"file": os.path.basename(board), **pcb_nets(board)}
        log(f"  board: {len(result['pcb']['parts'])} footprint(s)")
    except Exception as exc:  # noqa: BLE001 (reported, not raised)
        finding("error", f"the board could not be read: {exc}")
        return
    if schematics:
        # kicad-cli finds sub-sheets beside the root and may write beside it: a writable copy
        work = "/tmp/sch"
        os.makedirs(work, exist_ok=True)
        copies = []
        for p in schematics:
            dest = os.path.join(work, os.path.basename(p))
            shutil.copyfile(p, dest)
            copies.append(dest)
        root = root_schematic(copies, board)
        xml_out = os.path.join(OUT, "schematic.xml")
        code, _ = run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", xml_out, root])
        if code != 0 or not os.path.isfile(xml_out):
            finding("error", "the schematic netlist export failed")
            return
        repro.normalise_text_dates(xml_out, STAMP)
        add_output("schematic.xml", "schematic-netlist", "application/xml")
        try:
            sch, nets = schematic_nets(xml_out)
        except ET.ParseError as exc:
            finding("error", f"the schematic netlist could not be read: {exc}")
            return
        result["schematic"] = {"root": os.path.basename(root), "files": sorted(os.path.basename(p) for p in copies), **sch}
        log(f"  schematic {os.path.basename(root)}: {len(sch['parts'])} part(s), {nets} net(s), {len(sch['sheets'])} sheet(s)")
    else:
        finding("info", "no schematic given: the board's nets only")
    with open(os.path.join(OUT, "nets.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, sort_keys=True)
        f.write("\n")
    add_output("nets.json", "nets", "application/json")


OPS = {"board-render": op_board_render, "board-3d": op_board_3d, "fab": op_fab, "netlist": op_netlist}


def main():
    if len(sys.argv) != 3:
        print("usage: <op> /work/in/request.json", file=sys.stderr)
        return 2
    op, request_path = sys.argv[1], sys.argv[2]
    with open(request_path, encoding="utf-8") as f:
        request = json.load(f)
    version = tool_version()
    inputs = request.get("inputs", [])
    status = "ok"
    board = None
    schematics = []
    if request.get("op") != op:
        finding("error", f"request op {request.get('op')!r} does not match the invoked op {op!r}")
    if op not in OPS:
        finding("error", f"unknown op {op!r}; this pack runs {', '.join(sorted(OPS))}")
    for item in inputs:
        rel = item.get("path", "")
        path = os.path.normpath(os.path.join(IN, rel))
        if not path.startswith(IN + "/") or not os.path.isfile(path):
            finding("error", f"input {rel!r} is missing")
            continue
        actual = sha256_file(path)
        if actual != item.get("sha256"):
            finding("error", f"input {rel!r} does not match its sha256")
            continue
        if rel.endswith(".kicad_pcb") and board is None:
            board = path
        elif rel.endswith(".kicad_sch"):
            schematics.append(path)
    if board is None and not findings:
        finding("error", "no .kicad_pcb input")
    if not any(f["level"] == "error" for f in findings):
        log(f"{PACK} {PACK_VERSION} · {version} · {op}")
        params = request.get("params", {}) or {}
        global STAMP  # noqa: PLW0603
        STAMP = repro.stamp_of(params)
        if op == "netlist":
            op_netlist(board, params, schematics)
        else:
            OPS[op](board, params)
    if any(f["level"] == "error" for f in findings):
        status = "failed"
    with open(LOG_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines) + "\n")
    manifest = {
        "pack": PACK,
        "packVersion": PACK_VERSION,
        "tool": {"name": "kicad-cli", "version": version},
        "op": op,
        "inputs": [{"path": i.get("path"), "sha256": i.get("sha256")} for i in inputs],
        "outputs": outputs,
        "log": "log.txt",
        "status": status,
        "findings": findings,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
