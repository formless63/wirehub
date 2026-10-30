#!/usr/bin/env python3
"""WireHub tool pack `slicer-resin`: masked-LCD resin (mSLA) print preparation.

PrusaSlicer (SLA mode) slices the parts, adds supports and a pad, and writes a PrusaSlicer .sl1
(a zip of layer PNGs); UVtoolsCmd converts that .sl1 into the printer's own format. The pack then
reads the result back twice, with UVtools and with its own small reader of Elegoo's published GOO
layout (header fields, every layer's checksum, a sample of layers decoded pixel by pixel), and
fails when they disagree with what was asked for.

Contract v0 (tools/README.md): invoked as `<image> <op> /work/in/request.json`, reads only
/work/in (read-only), writes only /work/out and /tmp. No network. Exit 0 even when the op fails
honestly (status "failed"); non-zero = crash. This pack prepares files. It never connects to or
operates a printer.

Op `slice`
  inputs  one or more .stl parts, or one .3mf (its own plate, without the file's project settings)
  params  {
    "config":      { "<prusaslicer SLA key>": value, ..., "resin_<key>": value }
                   printer + material + process merged by the caller (later wins). The `resin_*`
                   keys are this pack's own (see RESIN_KEYS) and never reach PrusaSlicer:
                     resin_format          output format, "goo" (Elegoo)
                     resin_machine_name    the machine name written into the file header; UVtools
                                           uses it too (a Mars 5 Ultra / Saturn 4 Ultra name selects  # privacy-check: allow — public printer model names
                                           the tilting-vat encoding)
                     resin_<UVtools custom value in snake case>, e.g. resin_lift_height,
                                           resin_bottom_lift_speed, resin_transition_layer_count,
                                           resin_light_pwm: motion and light values PrusaSlicer has
                                           no setting for, handed to UVtools as SL1 custom values
    "orientation": "as-designed" | "flat"
    "parts":       [ { "path": "...", "copies": 1 } ]
    "name":        "file stem for the outputs"
  }
  outputs `<name>.goo` (role printer-file), `<name>.sl1` (role sla-slices: PrusaSlicer's own
          output, opens in PrusaSlicer and UVtools), `<name>.summary.json` (role summary),
          `<name>.effective.ini` (role effective-profile: every PrusaSlicer setting used, from the
          .sl1), `<name>.request.ini` (role requested-profile), `<name>.plate.3mf` (role plate),
          `<name>.preview.png` (role preview: the file's own preview image, as the printer shows it)
"""

import hashlib
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preview  # noqa: E402  (beside this file in the image)

PACK = "slicer-resin"
PACK_VERSION = os.environ.get("WIREHUB_PACK_VERSION", "dev")
OUT = "/work/out"
IN = "/work/in"
WORK = "/tmp/slice"
UVTOOLS = "/opt/uvtools/UVtoolsCmd"

log_lines = []
findings = []
outputs = []
tool = {"name": "PrusaSlicer (SLA) + UVtools", "version": "unknown"}

KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
FORBIDDEN = {"post_process", "host_type", "print_host", "printhost_apikey", "printhost_cafile", "printhost_password", "printhost_user", "printhost_port"}
# the formats this pack writes: UVtools encoder name, extension, media type
FORMATS = {"goo": ("GooFile", "goo", "application/x.elegoo-goo")}
# UVtools SL1 custom values a profile may set (resin_<snake_case> -> CamelCase)
CUSTOM_VALUES = [
    "BottomLiftHeight", "BottomLiftSpeed", "LiftHeight", "LiftSpeed", "BottomRetractSpeed", "RetractSpeed",
    "BottomLiftHeight2", "BottomLiftSpeed2", "LiftHeight2", "LiftSpeed2", "BottomRetractHeight2", "BottomRetractSpeed2",
    "RetractHeight2", "RetractSpeed2", "BottomWaitTimeBeforeCure", "WaitTimeBeforeCure", "BottomWaitTimeAfterCure",
    "WaitTimeAfterCure", "BottomWaitTimeAfterLift", "WaitTimeAfterLift", "BottomLightOffDelay", "LightOffDelay",
    "BottomLightPWM", "LightPWM", "TransitionLayerCount",
]
SNAKE = {re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower().replace("_p_w_m", "_pwm"): name for name in CUSTOM_VALUES}
RESIN_KEYS = {"resin_format", "resin_machine_name", *(f"resin_{k}" for k in SNAKE)}


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


def run(args, keep=200):
    log("$ " + " ".join(args))
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp", env={**os.environ, "HOME": "/tmp"})
    text = proc.stdout or ""
    # progress bars are noise in the log
    kept = [l for l in text.splitlines() if not re.match(r"^\s*(\[[#-]+\]|\d+% =>)", l)]
    for line in kept[-keep:]:
        log("  " + line)
    if proc.returncode != 0:
        log(f"  (exit {proc.returncode})")
    return proc.returncode, text


def tool_versions():
    proc = subprocess.run(["prusa-slicer", "--help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp", env={**os.environ, "HOME": "/tmp"})
    first = (proc.stdout or "").splitlines()[:1]
    m = re.search(r"PrusaSlicer-([0-9][0-9.]*)", first[0] if first else "")
    prusa = m.group(1) if m else "unknown"
    uv = os.environ.get("UVTOOLS_VERSION", "unknown")
    tool["version"] = f"{prusa} + {uv}"
    tool["components"] = [{"name": "PrusaSlicer", "version": prusa}, {"name": "UVtools", "version": uv}]
    deb = subprocess.run(["dpkg-query", "-W", "-f", "${Version}", "prusa-slicer"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    if deb.returncode == 0 and deb.stdout.strip():
        tool["package"] = f"debian prusa-slicer {deb.stdout.strip()}; UVtools {uv} linux-x64 release zip"
    log(f"tools: PrusaSlicer {prusa}, UVtools {uv}")


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


# ---------------------------------------------------------------- GOO reader (independent of UVtools)
#
# Elegoo's published GOO layout (github.com/elegooofficial/GOO), big-endian throughout; the layer
# checksum is the inverted byte sum of the layer payload. Written for this pack from the spec,
# cross-checked against the goo_format reader of mslicer (GPL-3.0) during development.

GOO_MAGIC = bytes([0x07, 0x00, 0x00, 0x00, 0x44, 0x4C, 0x50, 0x00])
GOO_END = bytes([0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00, 0x44, 0x4C, 0x50, 0x00])
CRLF = b"\r\n"


class Reader:
    def __init__(self, data):
        self.data, self.at = data, 0

    def take(self, n):
        if self.at + n > len(self.data):
            raise ValueError(f"the file ends early (at byte {self.at}, wanted {n} more)")
        out = self.data[self.at:self.at + n]
        self.at += n
        return out

    def text(self, n):
        return self.take(n).split(b"\0", 1)[0].decode("utf-8", errors="replace")

    def u8(self):
        return self.take(1)[0]

    def u16(self):
        return struct.unpack(">H", self.take(2))[0]

    def u32(self):
        return struct.unpack(">I", self.take(4))[0]

    def f32(self):
        return round(struct.unpack(">f", self.take(4))[0], 4)

    def expect(self, raw, what):
        if self.take(len(raw)) != raw:
            raise ValueError(f"{what} is not where the format puts it (byte {self.at - len(raw)})")


def decode_runs(payload, width, height):
    """Lit pixel count of one layer (pixels > 127) and the total run length, from the GOO RLE."""
    color, i, total, lit, n = 0, 0, 0, 0, len(payload)
    while i < n:
        head = payload[i]
        kind, size = head >> 6, (head >> 4) & 3
        if kind == 2:
            if size & 1:
                i += 1
                length = payload[i]
            else:
                length = 1
            color = (color - (head & 0x0F)) & 0xFF if size & 2 else (color + (head & 0x0F)) & 0xFF
        else:
            if kind == 0:
                color = 0
            elif kind == 1:
                i += 1
                color = payload[i]
            else:
                color = 0xFF
            length = head & 0x0F
            for k in range(size):
                i += 1
                length += payload[i] << (4 + 8 * (size - 1 - k))
        i += 1
        total += length
        if color > 127:
            lit += length
    if total != width * height:
        raise ValueError(f"a layer decodes to {total} pixels, not {width} x {height}")
    return lit


def read_goo(path, sample=24):
    """Header, per-layer Z/exposure/checksums, and a decoded sample of layers."""
    with open(path, "rb") as f:
        r = Reader(f.read())
    h = {"version": r.text(4)}
    r.expect(GOO_MAGIC, "the GOO magic")
    h["software"] = r.text(32)
    h["softwareVersion"] = r.text(24)
    h["fileTime"] = r.text(24)
    h["machineName"] = r.text(32)
    h["machineType"] = r.text(32)
    h["profileName"] = r.text(32)
    h["antiAliasing"], h["greyLevel"], h["blurLevel"] = r.u16(), r.u16(), r.u16()
    small = r.take(116 * 116 * 2)
    r.expect(CRLF, "the small preview's end")
    big = r.take(290 * 290 * 2)
    r.expect(CRLF, "the big preview's end")
    h["layerCount"] = r.u32()
    h["resolutionX"], h["resolutionY"] = r.u16(), r.u16()
    h["mirrorX"], h["mirrorY"] = bool(r.u8()), bool(r.u8())
    h["displayWidthMm"], h["displayHeightMm"], h["machineZMm"] = r.f32(), r.f32(), r.f32()
    h["layerHeightMm"], h["exposureS"] = r.f32(), r.f32()
    h["delayModeStatic"] = bool(r.u8())
    for k in ("lightOffS", "bottomBeforeLiftS", "bottomAfterLiftS", "bottomAfterRetractS", "beforeLiftS", "afterLiftS", "afterRetractS", "bottomExposureS"):
        h[k] = r.f32()
    h["bottomLayers"] = r.u32()
    for k in ("bottomLiftMm", "bottomLiftSpeed", "liftMm", "liftSpeed", "bottomRetractMm", "bottomRetractSpeed", "retractMm", "retractSpeed",
              "bottomLift2Mm", "bottomLift2Speed", "lift2Mm", "lift2Speed", "bottomRetract2Mm", "bottomRetract2Speed", "retract2Mm", "retract2Speed"):
        h[k] = r.f32()
    h["bottomLightPwm"], h["lightPwm"] = r.u16(), r.u16()
    h["perLayerSettings"] = bool(r.u8())
    h["printTimeS"] = r.u32()
    h["volumeMm3"], h["weightG"], h["price"] = r.f32(), r.f32(), r.f32()
    h["priceUnit"] = r.text(8)
    h["layerContentOffset"] = r.u32()
    h["greyScale"] = bool(r.u8())
    h["transitionLayers"] = r.u16()
    if r.at != h["layerContentOffset"]:
        raise ValueError(f"the header is {r.at} bytes but says layers start at {h['layerContentOffset']}")
    count, w, hh = h["layerCount"], h["resolutionX"], h["resolutionY"]
    picks = set(range(0, count, max(1, count // sample))) | {0, max(0, h["bottomLayers"] - 1), count - 1} if count else set()
    layers, z_prev, lit_total = [], -1.0, 0
    for i in range(count):
        pause, pause_z, z, exposure, off = r.u16(), r.f32(), r.f32(), r.f32(), r.f32()
        r.take(4 * 11)  # wait times and the motion values (per-layer copies of the header's)
        pwm = r.u16()
        r.expect(CRLF, f"layer {i}'s data start")
        size = r.u32()
        if r.u8() != 0x55:
            raise ValueError(f"layer {i} does not start with its 0x55 marker")
        payload = r.take(size - 2)
        checksum = r.u8()
        r.expect(CRLF, f"layer {i}'s end")
        if (~sum(payload)) & 0xFF != checksum:
            raise ValueError(f"layer {i}'s checksum does not match its data")
        if z <= z_prev:
            raise ValueError(f"layer {i} is at Z {z} mm, not above layer {i - 1} ({z_prev} mm)")
        z_prev = z
        entry = {"index": i, "z": z, "exposureS": exposure, "pwm": pwm, "bytes": size}
        if i in picks:
            entry["litPixels"] = decode_runs(payload, w, hh)
            lit_total += entry["litPixels"]
        layers.append(entry)
    r.expect(GOO_END, "the GOO end marker")
    if r.at != len(r.data):
        raise ValueError(f"{len(r.data) - r.at} bytes follow the end marker")
    return h, layers, {"small": small, "big": big}


def preview_png(raw, size, path):
    """The header's RGB565 preview as a PNG (stdlib zlib, no imaging library)."""
    import zlib
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            v = (raw[2 * (y * size + x)] << 8) | raw[2 * (y * size + x) + 1]
            row += bytes([((v >> 11) & 0x1F) * 255 // 31, ((v >> 5) & 0x3F) * 255 // 63, (v & 0x1F) * 255 // 31])
        rows.append(bytes(row))

    def chunk(kind, data):
        c = kind + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def uvtools_properties(path):
    """UVtools' own read-back of the file it wrote (name: value lines)."""
    names = ["MachineName", "ResolutionX", "ResolutionY", "LayerCount", "LayerHeight", "BottomLayerCount", "ExposureTime", "BottomExposureTime",
             "DisplayWidth", "DisplayHeight", "MachineZ", "PrintTime", "MaterialMilliliters", "MaterialGrams", "HaveTiltingVat", "TransitionLayerCount", "LiftHeight", "LiftSpeed"]
    code, text = run([UVTOOLS, "print-properties", path, "--partial-mode", "-n", *names], keep=40)
    props = {}
    for line in text.splitlines():
        m = re.match(r"^(\w+): (.*)$", line.strip())
        if m and m.group(1) in names:
            props[m.group(1)] = m.group(2)
    return code, props


ISSUE_NAMES = {"Island": ("island", "islands"), "ResinTrap": ("resin trap", "resin traps"), "SuctionCup": ("suction cup", "suction cups"),
               "TouchingBound": ("part touching the build area edge", "parts touching the build area edge")}


def uvtools_issues(path, pixel_mm2, timeout=600):
    """UVtools' issue scan (islands, resin traps, suction cups, touching bounds) as one warn finding per kind.
    A scan that cannot run is an info finding: the file itself is fine."""
    args = [UVTOOLS, "--no-progress", "print-issues", path, "--islands", "--resin-traps", "--suction-cups", "--touching-bounds", "--sort-area"]
    log("$ " + " ".join(args))
    try:
        proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd="/tmp", env={**os.environ, "HOME": "/tmp"}, timeout=timeout)
    except subprocess.TimeoutExpired:
        finding("info", f"UVtools' issue scan took longer than {timeout // 60} min and was skipped")
        return []
    text = proc.stdout.decode("utf-8", errors="replace")
    for line in text.splitlines()[:60]:
        log("  " + line)
    if proc.returncode != 0:
        finding("info", f"UVtools' issue scan did not run (exit {proc.returncode})")
        return []
    issues = []
    for line in text.splitlines():
        m = re.match(r"^\s*(\w+),\s*([\d-]+),\s*(\d+)\s*px", line)
        if m:
            layers = [int(n) for n in m.group(2).split("-") if n.isdigit()]
            issues.append({"type": m.group(1), "layer": layers[0] if layers else None, **({"lastLayer": layers[-1]} if len(layers) > 1 else {}),
                           "areaMm2": round(int(m.group(3)) * pixel_mm2, 2)})
    for kind in sorted({i["type"] for i in issues}):
        found = [i for i in issues if i["type"] == kind]
        one, many = ISSUE_NAMES.get(kind, (kind, kind))
        layers = sorted({i["layer"] for i in found if i["layer"] is not None})
        where = ", ".join(map(str, layers[:5])) + (" …" if len(layers) > 5 else "")
        largest = max(i["areaMm2"] for i in found)
        finding("warn", f"UVtools: {len(found)} {one if len(found) == 1 else many} (layer{'s' if len(layers) > 1 else ''} {where}; largest {largest} mm²)")
    return issues[:100]


def num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- op

def ini_text(value):
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, float):
        return repr(value)
    if isinstance(value, int):
        return str(value)
    return str(value).replace("\r", "").replace("\n", "\\n")


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
        finding("error", "params.config must be an object of PrusaSlicer SLA settings")
        return "failed"
    slicer, resin, requested = {}, {}, []
    for key in sorted(config):
        value = config[key]
        if not KEY.match(key):
            finding("error", f"setting {key!r} is not a PrusaSlicer key")
            return "failed"
        if key in FORBIDDEN or key.startswith("printhost_"):
            finding("error", f"setting {key!r} is not allowed in this pack (it reaches outside the slice)")
            return "failed"
        if not isinstance(value, (bool, int, float, str)):
            finding("error", f"setting {key!r} must be a string, number or boolean")
            return "failed"
        requested.append(f"{key} = {ini_text(value)}")
        if key.startswith("resin_"):
            if key not in RESIN_KEYS:
                finding("error", f"{key!r} is not a setting this pack knows (resin_format, resin_machine_name, resin_<motion or light value>)")
                return "failed"
            resin[key] = value
        else:
            slicer[key] = value
    if str(slicer.get("printer_technology", "SLA")).upper() != "SLA":
        finding("error", "this pack slices resin (printer_technology SLA); choose a resin printer profile")
        return "failed"
    slicer["printer_technology"] = "SLA"
    fmt = str(resin.get("resin_format", "goo")).lower()
    if fmt not in FORMATS:
        finding("error", f"resin_format {fmt!r} is not one this pack writes ({', '.join(FORMATS)})")
        return "failed"
    encoder, ext, media = FORMATS[fmt]
    machine = str(resin.get("resin_machine_name") or "").strip()
    if machine:
        slicer["printer_settings_id"] = machine
    else:
        finding("warn", "no resin_machine_name in the printer profile; the file header names no printer")
    # PrusaSlicer's SLA default first layer is 0.3 mm (a Prusa SL1 habit); a masked-LCD printer
    # expects every layer at the layer height unless the profile says otherwise
    if "initial_layer_height" not in slicer and "layer_height" in slicer:
        slicer["initial_layer_height"] = slicer["layer_height"]
    custom = [f"{SNAKE[k[6:]]}_{ini_text(v)}" for k, v in sorted(resin.items()) if k[6:] in SNAKE]
    notes = str(slicer.get("printer_notes") or "")
    slicer["printer_notes"] = "\\n".join([n for n in [notes, f"FILEFORMAT_{ext.upper()}"] if n] + (["START_CUSTOM_VALUES", *custom, "END_CUSTOM_VALUES"] if custom else []))

    os.makedirs(WORK, exist_ok=True)
    with open(os.path.join(OUT, f"{name}.request.ini"), "w", encoding="utf-8") as f:
        f.write("\n".join(requested) + "\n")
    config_path = os.path.join(WORK, "config.ini")
    with open(config_path, "w", encoding="utf-8") as f:
        f.write("\n".join(f"{k} = {ini_text(v)}" for k, v in sorted(slicer.items())) + "\n")

    by_path = {i["path"]: i for i in inputs}
    parts = params.get("parts") or [{"path": i["path"], "copies": 1} for i in inputs]
    objects, passthrough, three_mf = [], None, None
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
            passthrough = os.path.join(WORK, "plate.3mf")
            try:
                three_mf = sanitize_3mf(src, passthrough, os.path.basename(rel))
            except Exception as error:
                finding("error", f"{rel}: not a readable 3MF ({error})")
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
                log(f"{rel}: laid flat on a {best[0]:.1f} mm2 face")
        for c in range(copies):
            objects.append((f"{os.path.basename(rel)}{'' if copies == 1 else f' #{c + 1}'}", tris))

    if passthrough is not None:
        model = passthrough
    else:
        model = os.path.join(OUT, f"{name}.plate.3mf")
        # supports stand the part off the pad, and the pad reaches past the part: leave room
        placed = arrange(objects, slicer, gap=10.0)
        if placed is None:
            return "failed"
        write_3mf(model, placed)

    sl1 = os.path.join(OUT, f"{name}.sl1")
    code, text = run(["prusa-slicer", "--datadir", "/tmp/prusa-datadir", "--export-sla", "--load", config_path, "--output", sl1, model])
    if code != 0 or not os.path.isfile(sl1):
        said = [l.strip() for l in text.splitlines() if l.strip() and not re.match(r"^\d+% => ", l.strip())]
        for line in said[-3:]:
            finding("error", line[:300])
        finding("error", f"PrusaSlicer did not produce the SLA slices (exit {code})")
        return "failed"
    with zipfile.ZipFile(sl1) as z:
        effective = z.read("prusaslicer.ini").decode("utf-8", errors="replace")
        sl1_config = dict(l.split(" = ", 1) for l in z.read("config.ini").decode("utf-8", errors="replace").splitlines() if " = " in l)
    with open(os.path.join(OUT, f"{name}.effective.ini"), "w", encoding="utf-8") as f:
        f.write(effective)

    # UVtools writes next to its input; give it a writable copy in /tmp and move the result out
    work_sl1 = os.path.join(WORK, f"{name}.sl1")
    with open(sl1, "rb") as a, open(work_sl1, "wb") as b:
        b.write(a.read())
    target = os.path.join(WORK, f"{name}.{ext}")
    code, text = run([UVTOOLS, "convert", work_sl1, encoder, target], keep=30)
    if code != 0 or not os.path.isfile(target):
        finding("error", f"UVtools did not convert the slices to .{ext} (exit {code})")
        return "failed"
    final = os.path.join(OUT, f"{name}.{ext}")
    shutil.move(target, final)
    # the file's preview (what the printer's screen shows): the plate drawn by preview.py, set by UVtools
    try:
        drawn = os.path.join(WORK, "plate-preview.png")
        with open(drawn, "wb") as f:
            f.write(preview.png(preview.render(preview.plate_meshes(model, "#8C9AAB"), 512, 512), 512, 512))
        code, _ = run([UVTOOLS, "--no-progress", "set-preview", final, drawn], keep=10)
        if code != 0:
            finding("info", f"UVtools could not set the file's preview (exit {code})")
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as error:
        finding("info", f"no plate preview: {error}")

    # read the result back: UVtools' view, and our own reader of the published layout
    code, props = uvtools_properties(final)
    try:
        header, layers, previews = read_goo(final)
    except ValueError as error:
        finding("error", f"the .{ext} does not read back as a well-formed GOO file: {error}")
        return "failed"
    preview_png(previews["big"], 290, os.path.join(OUT, f"{name}.preview.png"))
    expected = {
        "resolutionX": int(num(slicer.get("display_pixels_x")) or 0), "resolutionY": int(num(slicer.get("display_pixels_y")) or 0),
        "layerHeightMm": num(slicer.get("layer_height")), "exposureS": num(slicer.get("exposure_time")),
        "bottomExposureS": num(slicer.get("initial_exposure_time")), "bottomLayers": int(num(sl1_config.get("numFade")) or 0),
        "layerCount": int(num(sl1_config.get("numFast")) or 0) + int(num(sl1_config.get("numSlow")) or 0),
        "machineName": machine or header["machineName"],
    }
    mismatched = []
    for k, want in expected.items():
        got = header[k]
        if want is None or want == 0:
            continue
        same = abs(float(got) - float(want)) < 1e-3 if isinstance(want, float) else got == want
        if not same:
            mismatched.append(f"{k} {got} (asked for {want})")
    uv_checks = {"LayerCount": header["layerCount"], "ResolutionX": header["resolutionX"], "ResolutionY": header["resolutionY"], "ExposureTime": header["exposureS"], "BottomExposureTime": header["bottomExposureS"]}
    for k, ours in uv_checks.items():
        theirs = num(props.get(k))
        if theirs is None or abs(theirs - float(ours)) > 1e-3:
            mismatched.append(f"UVtools reads {k} {props.get(k)!r}, the GOO reader {ours}")
    if mismatched:
        for m in mismatched:
            finding("error", f"read-back mismatch: {m}")
        return "failed"
    pixel_mm2 = (header["displayWidthMm"] / header["resolutionX"]) * (header["displayHeightMm"] / header["resolutionY"])
    issues = uvtools_issues(final, pixel_mm2)
    sampled = [l for l in layers if "litPixels" in l]
    empty = [l["index"] for l in sampled if l["litPixels"] == 0]
    if empty:
        finding("warn", f"layer(s) {', '.join(map(str, empty[:5]))} expose nothing; check the model and supports")
    first_z = layers[0]["z"] if layers else 0
    if abs(first_z - header["layerHeightMm"]) > 1e-3:
        finding("info", f"the first layer sits at {first_z} mm (layer height {header['layerHeightMm']} mm)")
    summary = {
        "format": ext, "machineName": header["machineName"], "layers": header["layerCount"], "bottomLayers": header["bottomLayers"],
        "layerHeightMm": header["layerHeightMm"], "heightMm": round(layers[-1]["z"], 3) if layers else 0,
        "exposureS": header["exposureS"], "bottomExposureS": header["bottomExposureS"], "transitionLayers": header["transitionLayers"],
        "resolution": [header["resolutionX"], header["resolutionY"]], "displayMm": [header["displayWidthMm"], header["displayHeightMm"]],
        "pixelUm": round(header["displayWidthMm"] / header["resolutionX"] * 1000, 2), "mirrorX": header["mirrorX"], "mirrorY": header["mirrorY"],
        "tiltingVat": props.get("HaveTiltingVat") == "True",
        "motion": {k: header[k] for k in ("bottomLiftMm", "bottomLiftSpeed", "liftMm", "liftSpeed", "retractMm", "retractSpeed")},
        "printTimeSeconds": header["printTimeS"], "printTimeText": duration(header["printTimeS"]),
        # UVtools fills the header's weight field with millilitres too; the volume (mm3) is the honest number
        "resinMl": round(header["volumeMm3"] / 1000, 2),
        "sampledLayers": [{"index": l["index"], "z": l["z"], "litMm2": round(l["litPixels"] * pixel_mm2, 1)} for l in sampled],
        "issues": issues,
        "readBack": {"uvtools": props, "gooReader": "header, every layer checksum and Z order, decoded sample of layers"},
        "slicer": tool, "orientation": orientation,
        "parts": [{"path": p.get("path"), "copies": int(p.get("copies") or 1)} for p in parts],
        "effectiveProfileSha256": hashlib.sha256(effective.encode("utf-8")).hexdigest(),
        "requestedSettings": len(requested),
        **({"threeMf": three_mf} if three_mf is not None else {}),
        "note": "Untested on a printer until someone prints it: check the first .goo from a new profile with a small part.",
    }
    with open(os.path.join(OUT, f"{name}.summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
    add_output(f"{name}.{ext}", "printer-file", media)
    add_output(f"{name}.summary.json", "summary", "application/json")
    add_output(f"{name}.preview.png", "preview", "image/png")
    add_output(f"{name}.sl1", "sla-slices", "application/zip")
    add_output(f"{name}.effective.ini", "effective-profile", "text/plain")
    add_output(f"{name}.request.ini", "requested-profile", "text/plain")
    if passthrough is None:
        add_output(f"{name}.plate.3mf", "plate", "model/3mf")
    finding("info", f"{header['layerCount']} layers, {summary['printTimeText']}, {summary['resinMl']} ml resin (estimates); read back by UVtools and the GOO reader")
    return "ok"


def duration(seconds):
    seconds = int(seconds)
    h, rest = divmod(seconds, 3600)
    m, s = divmod(rest, 60)
    return f"{h}h {m:02d}m {s:02d}s" if h else f"{m}m {s:02d}s"


def main():
    if len(sys.argv) != 3:
        print("usage: <op> /work/in/request.json", file=sys.stderr)
        return 2
    op, request_path = sys.argv[1], sys.argv[2]
    with open(request_path, "r", encoding="utf-8") as f:
        request = json.load(f)
    status = "failed"
    declared = request.get("inputs") or []
    tool_versions()
    for item in declared:
        path = os.path.join(IN, item["path"])
        if not os.path.isfile(path) or sha256_file(path) != item.get("sha256"):
            finding("error", f"input {item['path']} is missing or does not match its sha256")
            break
    else:
        if op == "slice":
            try:
                status = op_slice(request)
            except Exception as error:
                finding("error", f"slice failed: {error}")
                status = "failed"
        else:
            finding("error", f"unknown op {op!r}")
    with open(os.path.join(OUT, "log.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines) + "\n")
    manifest = {
        "pack": PACK, "packVersion": PACK_VERSION, "tool": tool, "op": op,
        "inputs": [{"path": i["path"], "sha256": i.get("sha256")} for i in declared],
        "outputs": outputs if status == "ok" else [o for o in outputs if o["role"] != "printer-file"],
        "log": "log.txt", "status": status, "findings": findings,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
