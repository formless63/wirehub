#!/usr/bin/env python3
"""WireHub tool pack `slicer-prusaslicer`: FDM print preparation with the PrusaSlicer CLI.

Contract v0 (tools/README.md): invoked as `<image> <op> /work/in/request.json`, reads only
/work/in (read-only), writes only /work/out (manifest.json, log.txt, outputs) and /tmp.
No network. Exit 0 even when the op fails honestly (status "failed"); non-zero = crash.
This pack prepares files. It never connects to or operates a printer.

Op `slice`
  inputs  one or more .stl parts, or one .3mf (sliced on its own plate, without the file's own
          slicer project settings: the caller's config is the whole profile)
  params  {
    "config":      { "<prusaslicer key>": value, ... }   printer + material + process settings,
                                                          merged by the caller (later wins)
    "orientation": "as-designed" | "flat"                flat: the largest planar face of each
                                                          part goes down on the bed
    "parts":       [ { "path": "...", "copies": 1 } ]     optional; default every input once
    "name":        "file stem for the outputs"            optional
  }
  outputs `<name>.gcode` (role gcode), `<name>.summary.json` (role summary: print time,
          filament length/volume/mass, layer count, …), `<name>.effective.ini` (role
          effective-profile: every setting PrusaSlicer actually used, as embedded in the G-code),
          `<name>.request.ini` (role requested-profile: the keys the caller set), `<name>.plate.3mf`
          (role plate: the STL parts as placed on the bed, oriented, one object each), `<name>.preview.png`
          (role preview: that plate drawn by preview.py)
"""

import hashlib
import json
import math
import os
import re
import struct
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preview  # noqa: E402  (beside this file in the image)

PACK = "slicer-prusaslicer"
PACK_VERSION = os.environ.get("WIREHUB_PACK_VERSION", "dev")
OUT = "/work/out"
IN = "/work/in"
WORK = "/tmp/slice"

log_lines = []
findings = []
outputs = []
tool = {"name": "PrusaSlicer", "version": "unknown"}

KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# Settings that would make the slicer reach outside the container or run code.
FORBIDDEN = {"post_process", "host_type", "print_host", "printhost_apikey", "printhost_cafile", "printhost_password", "printhost_user", "printhost_port"}


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
    log("$ " + " ".join(args))
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp", env={**os.environ, "HOME": "/tmp"})
    text = proc.stdout or ""
    for line in text.splitlines()[-200:]:
        log("  " + line)
    if proc.returncode != 0:
        log(f"  (exit {proc.returncode})")
    return proc.returncode, text


def slicer_version():
    proc = subprocess.run(["prusa-slicer", "--help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp", env={**os.environ, "HOME": "/tmp"})
    first = (proc.stdout or "").splitlines()[:1]
    log("$ prusa-slicer --help -> " + (first[0] if first else "(no output)"))
    m = re.search(r"PrusaSlicer-([0-9][0-9.]*)", first[0] if first else "")
    if m:
        tool["version"] = m.group(1)
    deb = subprocess.run(["dpkg-query", "-W", "-f", "${Version}", "prusa-slicer"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    if deb.returncode == 0 and deb.stdout.strip():
        tool["package"] = f"debian prusa-slicer {deb.stdout.strip()}"


# ---------------------------------------------------------------- STL handling (for "flat")

def read_stl(path):
    """Triangles as ((ax,ay,az),(bx,by,bz),(cx,cy,cz)). Binary or ASCII."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + 50 * n == len(data):
            tris = []
            for i in range(n):
                v = struct.unpack_from("<12f", data, 84 + 50 * i)
                tris.append((v[3:6], v[6:9], v[9:12]))
            return tris
    text = data.decode("ascii", errors="replace")
    verts = [tuple(float(x) for x in m.groups()) for m in re.finditer(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", text)]
    if not verts or len(verts) % 3 != 0:
        raise ValueError("not a readable STL")
    return [tuple(verts[i:i + 3]) for i in range(0, len(verts), 3)]


def sub(p, q):
    return (p[0] - q[0], p[1] - q[1], p[2] - q[2])


def cross(u, v):
    return (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])


def normal(a, b, c):
    n = cross(sub(b, a), sub(c, a))
    length = math.sqrt(n[0] ** 2 + n[1] ** 2 + n[2] ** 2)
    if length == 0:
        return (0.0, 0.0, 0.0), 0.0
    return (n[0] / length, n[1] / length, n[2] / length), length / 2


def rotation_to_down(n):
    """Rotation matrix taking unit vector n onto (0,0,-1) (Rodrigues)."""
    target = (0.0, 0.0, -1.0)
    v = cross(n, target)
    c = n[0] * target[0] + n[1] * target[1] + n[2] * target[2]
    if c > 1 - 1e-9:
        return ((1, 0, 0), (0, 1, 0), (0, 0, 1))
    if c < -1 + 1e-9:  # facing straight up: turn over about X
        return ((1, 0, 0), (0, -1, 0), (0, 0, -1))
    k = 1 / (1 + c)
    vx, vy, vz = v
    return (
        (1 - k * (vy * vy + vz * vz), k * vx * vy - vz, k * vx * vz + vy),
        (k * vx * vy + vz, 1 - k * (vx * vx + vz * vz), k * vy * vz - vx),
        (k * vx * vz - vy, k * vy * vz + vx, 1 - k * (vx * vx + vy * vy)),
    )


def apply(m, p):
    return tuple(m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] for i in range(3))


def lay_flat(tris):
    """Put the largest coplanar face group that bounds the part down. Returns (triangles, best)."""
    groups = {}
    for a, b, c in tris:
        n, area = normal(a, b, c)
        if area == 0:
            continue
        key = (round(n[0], 3), round(n[1], 3), round(n[2], 3), round(n[0] * a[0] + n[1] * a[1] + n[2] * a[2], 2))
        g = groups.setdefault(key, [0.0, n])
        g[0] += area
    best = None
    points = [p for t in tris for p in t]
    ranked = sorted(groups.items(), key=lambda kv: (-kv[1][0], kv[0]))
    for (_, _, _, d), (area, n) in ranked[:50]:
        extreme = max(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] for p in points)
        if abs(extreme - d) <= 0.05:
            best = (area, n)
            break
    if best is None:
        return tris, None
    m = rotation_to_down(best[1])
    return [tuple(apply(m, p) for p in t) for t in tris], best


def bed_rect(config):
    shape = str(config.get("bed_shape") or "0x0,250x0,250x210,0x210")
    xs, ys = [], []
    for point in shape.split(","):
        try:
            x, y = point.split("x")
            xs.append(float(x))
            ys.append(float(y))
        except ValueError:
            pass
    if not xs:
        return 0.0, 0.0, 250.0, 210.0
    return min(xs), min(ys), max(xs), max(ys)


def arrange(objects, config, gap=8.0):
    """Shelf-pack the parts' footprints on the bed (largest first), centred, each resting on z = 0."""
    x0, y0, x1, y1 = bed_rect(config)
    height_limit = float(config.get("max_print_height") or 1e9)
    boxes = []
    for label, tris in objects:
        pts = [p for t in tris for p in t]
        lo = [min(p[k] for p in pts) for k in range(3)]
        hi = [max(p[k] for p in pts) for k in range(3)]
        if hi[2] - lo[2] > height_limit:
            finding("error", f"{label} is {hi[2] - lo[2]:.1f} mm tall, over the printer's {height_limit:g} mm")
            return None
        boxes.append((label, tris, lo, hi))
    boxes.sort(key=lambda b: (-(b[3][1] - b[2][1]), b[0]))
    width, depth = x1 - x0, y1 - y0
    rows, row, row_w, row_d = [], [], 0.0, 0.0
    for box in boxes:
        w, d = box[3][0] - box[2][0], box[3][1] - box[2][1]
        if w > width or d > depth:
            finding("error", f"{box[0]} ({w:.1f} x {d:.1f} mm) does not fit the {width:g} x {depth:g} mm bed")
            return None
        if row and row_w + gap + w > width:
            rows.append((row, row_w, row_d))
            row, row_w, row_d = [], 0.0, 0.0
        row_w = w if not row else row_w + gap + w
        row_d = max(row_d, d)
        row.append(box)
    if row:
        rows.append((row, row_w, row_d))
    total_d = sum(r[2] for r in rows) + gap * (len(rows) - 1)
    if total_d > depth:
        finding("error", f"the {len(boxes)} part(s) do not fit on one {width:g} x {depth:g} mm bed; slice fewer at a time")
        return None
    placed = []
    y = y0 + (depth - total_d) / 2
    for parts_in_row, w_row, d_row in rows:
        x = x0 + (width - w_row) / 2
        for label, tris, lo, hi in parts_in_row:
            dx, dy, dz = x - lo[0], y - lo[1], -lo[2]
            placed.append((label, [tuple((p[0] + dx, p[1] + dy, p[2] + dz) for p in t) for t in tris]))
            log(f"{label}: placed at x {x:.1f}, y {y:.1f} ({hi[0] - lo[0]:.1f} x {hi[1] - lo[1]:.1f} x {hi[2] - lo[2]:.1f} mm)")
            x += hi[0] - lo[0] + gap
        y += d_row + gap
    return placed


def write_3mf(path, placed):
    """One plate, one 3MF object per part (PrusaSlicer slices each as its own object)."""
    import zipfile
    from xml.sax.saxutils import escape
    out = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
           '<resources>']
    for i, (label, tris) in enumerate(placed, start=1):
        index, verts, faces = {}, [], []
        for t in tris:
            ids = []
            for p in t:
                k = (round(p[0], 5), round(p[1], 5), round(p[2], 5))
                if k not in index:
                    index[k] = len(verts)
                    verts.append(k)
                ids.append(index[k])
            if len(set(ids)) == 3:
                faces.append(ids)
        out.append(f'<object id="{i}" type="model" name="{escape(label)}"><mesh><vertices>')
        out.extend(f'<vertex x="{v[0]:.5f}" y="{v[1]:.5f}" z="{v[2]:.5f}"/>' for v in verts)
        out.append('</vertices><triangles>')
        out.extend(f'<triangle v1="{f[0]}" v2="{f[1]}" v3="{f[2]}"/>' for f in faces)
        out.append('</triangles></mesh></object>')
    out.append('</resources><build>')
    out.extend(f'<item objectid="{i}"/>' for i in range(1, len(placed) + 1))
    out.append('</build></model>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr("3D/3dmodel.model", "\n".join(out))


# ---------------------------------------------------------------- 3MF uploads

# A 3MF saved by a slicer carries that slicer's whole project configuration. PrusaSlicer applies it
# under the settings we load (keys we do not set would come from the file, and a post-processing
# script in it would run), so a sliced 3MF would no longer be reproducible from the hub's profile.
# The project configuration is set aside; per-object settings (modifiers, per-part layer height,
# support painting) are geometry-level and stay, minus anything that reaches outside the slice.
PROJECT_CONFIGS = {"metadata/slic3r_pe.config", "metadata/project_settings.config", "metadata/print_profile.config"}
OBJECT_CONFIG = "metadata/slic3r_pe_model.config"
OBJECT_KEY = re.compile(r'<metadata\b[^>]*\bkey="([^"]*)"[^>]*/>')


def sanitize_3mf(src, dest, label):
    """Copy a 3MF without its project configuration. Returns a short account for the summary."""
    import zipfile
    dropped, kept, removed = [], [], []
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        names = zin.namelist()
        if not any(n.lower().endswith(".model") for n in names):
            raise ValueError("the 3MF has no 3D model part")
        for info in zin.infolist():
            lower = info.filename.lower()
            data = zin.read(info.filename)
            if lower in PROJECT_CONFIGS:
                dropped.append(info.filename)
                continue
            if lower == OBJECT_CONFIG:
                text = data.decode("utf-8", errors="replace")

                def keep(match):
                    key = match.group(1)
                    if key in FORBIDDEN or key.startswith("printhost_"):
                        removed.append(key)
                        return ""
                    if 'type="object"' in match.group(0) or 'type="volume"' in match.group(0):
                        kept.append(key)
                    return match.group(0)
                data = OBJECT_KEY.sub(keep, text).encode("utf-8")
            zout.writestr(info, data)
    if dropped:
        finding("info", f"{label}: the file's own slicer project settings were set aside; the hub's printer, material and process profile was used")
    if removed:
        finding("warn", f"{label}: removed per-object settings that reach outside the slice ({', '.join(sorted(set(removed)))})")
    settings = sorted(set(k for k in kept if k not in ("name", "source_file", "source_object_id", "source_volume_id", "source_offset_x", "source_offset_y", "source_offset_z", "matrix", "volume_type", "extruder")))
    if settings:
        finding("info", f"{label}: per-object settings kept from the file: {', '.join(settings[:12])}{' …' if len(settings) > 12 else ''}")
    log(f"{label}: 3MF sanitised; dropped {dropped or 'nothing'}; per-object keys kept {settings}")
    return {"projectSettingsDropped": dropped, "objectSettingsKept": settings, "objectSettingsRemoved": sorted(set(removed))}


# ---------------------------------------------------------------- G-code summary

def parse_duration(text):
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([dhms])", text):
        total += int(value) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return total


def summarize(gcode_path):
    summary = {"layers": 0}
    config = []
    in_config = False
    max_z = 0.0
    with open(gcode_path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.startswith(";LAYER_CHANGE"):
                summary["layers"] += 1
            elif line.startswith(";Z:"):
                try:
                    max_z = max(max_z, float(line[3:]))
                except ValueError:
                    pass
            elif line.startswith("; prusaslicer_config = begin"):
                in_config = True
            elif line.startswith("; prusaslicer_config = end"):
                in_config = False
            elif in_config and line.startswith("; "):
                config.append(line[2:].rstrip("\n"))
            elif line.startswith("; ") and " = " in line:
                key, _, value = line[2:].strip().partition(" = ")
                if key == "estimated printing time (normal mode)":
                    summary["printTimeText"] = value
                    summary["printTimeSeconds"] = parse_duration(value)
                elif key == "filament used [mm]":
                    summary["filamentMm"] = to_number(value)
                elif key == "filament used [cm3]":
                    summary["filamentCm3"] = to_number(value)
                elif key == "filament used [g]" or key == "total filament used [g]":
                    summary["filamentG"] = to_number(value)
                elif key == "filament cost" or key == "total filament cost":
                    summary["filamentCost"] = to_number(value)
    summary["heightMm"] = round(max_z, 3)
    return summary, config


def to_number(value):
    try:
        first = value.split(",")[0].strip()
        return round(float(first), 3)
    except ValueError:
        return None


# ---------------------------------------------------------------- op

def op_slice(request):
    params = request.get("params") or {}
    inputs = request.get("inputs") or []
    config = params.get("config") or {}
    orientation = params.get("orientation") or "as-designed"
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(params.get("name") or "print")).strip("-.") or "print"
    if orientation not in ("as-designed", "flat"):
        finding("error", f"orientation {orientation!r} is not as-designed or flat")
        return "failed"
    if not isinstance(config, dict):
        finding("error", "params.config must be an object of PrusaSlicer settings")
        return "failed"
    lines = []
    for key in sorted(config):
        value = config[key]
        if not KEY.match(key):
            finding("error", f"setting {key!r} is not a PrusaSlicer key")
            return "failed"
        if key in FORBIDDEN or key.startswith("printhost_"):
            finding("error", f"setting {key!r} is not allowed in this pack (it reaches outside the slice)")
            return "failed"
        if isinstance(value, bool):
            text = "1" if value else "0"
        elif isinstance(value, (int, float)):
            text = repr(value) if isinstance(value, float) else str(value)
        elif isinstance(value, str):
            text = value.replace("\r", "").replace("\n", "\\n")
        else:
            finding("error", f"setting {key!r} must be a string, number or boolean")
            return "failed"
        lines.append(f"{key} = {text}")
    os.makedirs(WORK, exist_ok=True)
    requested = os.path.join(OUT, f"{name}.request.ini")
    with open(requested, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    config_path = os.path.join(WORK, "config.ini")
    with open(config_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")

    by_path = {i["path"]: i for i in inputs}
    parts = params.get("parts") or [{"path": i["path"], "copies": 1} for i in inputs]
    objects = []  # (label, triangles) laid out on one plate
    passthrough = None  # a single 3MF keeps its own plate (sanitised copy)
    three_mf = None
    for part in parts:
        rel = part.get("path")
        if rel not in by_path:
            finding("error", f"part {rel!r} is not one of the inputs")
            return "failed"
        src = os.path.join(IN, rel)
        lower = rel.lower()
        copies = int(part.get("copies") or 1)
        if copies < 1 or copies > 50:
            finding("error", f"{rel}: copies must be 1-50")
            return "failed"
        if lower.endswith(".3mf"):
            if len(parts) != 1 or copies != 1:
                finding("error", f"{rel}: a 3MF is sliced on its own, as its own plate")
                return "failed"
            if orientation == "flat":
                finding("warn", f"{rel}: flat orientation applies to STL parts; this 3MF keeps its own placement")
            os.makedirs(WORK, exist_ok=True)
            passthrough = os.path.join(WORK, "plate.3mf")
            try:
                three_mf = sanitize_3mf(src, passthrough, os.path.basename(rel))
            except Exception as error:  # a broken zip, no model part
                finding("error", f"{rel}: not a readable 3MF ({error})")
                return "failed"
            # a plate whose per-object config names no volumes reads as empty; say so, not "outside the print volume"
            code, info = run(["prusa-slicer", "--datadir", "/tmp/prusa-datadir", "--info", passthrough])
            facets = sum(int(m) for m in re.findall(r"^number_of_facets = (\d+)", info, re.M))
            if facets == 0:
                finding("error", f"{rel}: PrusaSlicer reads no geometry from this 3MF (its per-object configuration names no volumes, or it has no mesh)")
                return "failed"
            continue
        if not lower.endswith(".stl"):
            finding("error", f"{rel} is not an STL or 3MF file")
            return "failed"
        try:
            tris = read_stl(src)
        except ValueError as error:
            finding("error", f"{rel}: {error}")
            return "failed"
        if orientation == "flat":
            tris, best = lay_flat(tris)
            if best is None:
                finding("warn", f"{rel}: no flat face found; sliced as designed")
            else:
                n = best[1]
                log(f"{rel}: laid flat on a {best[0]:.1f} mm2 face (normal {n[0]:.3f}, {n[1]:.3f}, {n[2]:.3f})")
        for c in range(copies):
            objects.append((f"{os.path.basename(rel)}{'' if copies == 1 else f' #{c + 1}'}", tris))

    if passthrough is not None:
        model = passthrough
    else:
        model = os.path.join(OUT, f"{name}.plate.3mf")
        placed = arrange(objects, config)
        if placed is None:
            return "failed"
        write_3mf(model, placed)

    gcode_rel = f"{name}.gcode"
    gcode = os.path.join(OUT, gcode_rel)
    code, text = run(["prusa-slicer", "--datadir", "/tmp/prusa-datadir", "--export-gcode", "--load", config_path,
                      "--output", gcode, model])
    if code != 0 or not os.path.isfile(gcode):
        # PrusaSlicer reports a configuration problem as plain text and may still exit 0
        said = [l.strip() for l in text.splitlines() if l.strip() and not re.match(r"^\d+ => ", l.strip())]
        for line in said[:3]:
            finding("error", line[:300])
        finding("error", f"PrusaSlicer did not produce G-code (exit {code})")
        return "failed"
    summary, effective = summarize(gcode)
    with open(os.path.join(OUT, f"{name}.effective.ini"), "w", encoding="utf-8") as f:
        f.write("\n".join(effective) + "\n")
    effective_sha = hashlib.sha256(("\n".join(effective) + "\n").encode("utf-8")).hexdigest()
    summary.update({
        "slicer": tool,
        "orientation": orientation,
        "parts": [{"path": p.get("path"), "copies": int(p.get("copies") or 1)} for p in parts],
        "effectiveProfileSha256": effective_sha,
        **({"threeMf": three_mf} if three_mf is not None else {}),
        "requestedSettings": len(lines),
        "effectiveSettings": len(effective),
    })
    if summary["layers"] == 0:
        finding("warn", "the G-code has no layer changes; check the part size and profile")
    with open(os.path.join(OUT, f"{name}.summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
    add_output(gcode_rel, "gcode", "text/x.gcode")
    add_output(f"{name}.summary.json", "summary", "application/json")
    add_output(f"{name}.effective.ini", "effective-profile", "text/plain")
    add_output(f"{name}.request.ini", "requested-profile", "text/plain")
    if passthrough is None:
        add_output(f"{name}.plate.3mf", "plate", "model/3mf")
    # the plate drawn without a display (preview.py): the parts where they sit on the bed
    try:
        colour = next((l.split("=", 1)[1].strip().split(";")[0] for l in effective if l.startswith("filament_colour =")), None)
        image = preview.render(preview.plate_meshes(model, colour), 512, 512)
        with open(os.path.join(OUT, f"{name}.preview.png"), "wb") as f:
            f.write(preview.png(image, 512, 512))
        add_output(f"{name}.preview.png", "preview", "image/png")
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as error:
        finding("info", f"no plate preview: {error}")
    finding("info", f"{summary['layers']} layers, {summary.get('printTimeText', '?')}, {summary.get('filamentG', '?')} g filament (estimates)")
    return "ok"


def main():
    if len(sys.argv) != 3:
        print("usage: <op> /work/in/request.json", file=sys.stderr)
        return 2
    op, request_path = sys.argv[1], sys.argv[2]
    with open(request_path, "r", encoding="utf-8") as f:
        request = json.load(f)
    status = "failed"
    declared = request.get("inputs") or []
    slicer_version()
    for item in declared:
        path = os.path.join(IN, item["path"])
        if not os.path.isfile(path) or sha256_file(path) != item.get("sha256"):
            finding("error", f"input {item['path']} is missing or does not match its sha256")
            break
    else:
        if op == "slice":
            try:
                status = op_slice(request)
            except Exception as error:  # an honest failure, with the reason
                finding("error", f"slice failed: {error}")
                status = "failed"
        else:
            finding("error", f"unknown op {op!r}")
    with open(os.path.join(OUT, "log.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines) + "\n")
    manifest = {
        "pack": PACK, "packVersion": PACK_VERSION, "tool": tool, "op": op,
        "inputs": [{"path": i["path"], "sha256": i.get("sha256")} for i in declared],
        "outputs": outputs if status == "ok" else [o for o in outputs if o["role"] != "gcode"],
        "log": "log.txt", "status": status, "findings": findings,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
