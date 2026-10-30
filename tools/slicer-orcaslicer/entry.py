#!/usr/bin/env python3
"""WireHub tool pack `slicer-orcaslicer`: FDM print preparation with the OrcaSlicer CLI and the
printer, filament and process presets OrcaSlicer ships for each printer maker.

Contract v0 (tools/README.md): invoked as `<image> <op> /work/in/request.json`, reads only
/work/in (read-only), writes only /work/out (manifest.json, log.txt, outputs) and /tmp.
No network. Exit 0 even when the op fails honestly (status "failed"); non-zero = crash.
This pack prepares files. It never connects to or operates a printer.

Op `profiles`
  params  { "vendors": ["BBL", "Qidi"] }   profile folders to list (default: those two)
  outputs `profiles.json` (role profiles): every printer preset of those makers with the process
          and filament presets OrcaSlicer offers for it, its defaults and each preset's hash (the
          sha256 of the preset with its inheritance resolved, as this pack hands it to the slicer)

Op `slice`
  inputs  one or more .stl parts, or one .3mf (sliced as its own plate, without the file's own
          slicer project settings: the chosen presets are the whole profile)
  params  {
    "presets":     { "printer": "<machine preset>", "material": "<filament preset>", "process": "<process preset>" },
    "overrides":   { "<orca key>": value, ... }     applied over the resolved presets (supports, brim …)
    "orientation": "as-designed" | "flat"           flat: the largest planar face of each STL goes down
    "parts":       [ { "path": "...", "copies": 1 } ]
    "name":        "file stem for the outputs"
    "printer3mf":  "auto" | true | false            also write <name>.gcode.3mf (auto: Bambu Lab printers)
  }
  outputs `<name>.gcode` (role gcode), `<name>.gcode.3mf` (role gcode-3mf: the sliced plate as Bambu
          Lab printers take it, with Metadata/plate_1.gcode and its .md5), `<name>.summary.json`
          (role summary), `<name>.effective.ini` (role effective-profile: every setting the slicer
          used, read back from the G-code), `<name>.request.json` (role requested-profile),
          `<name>.preview.png` (role preview: the plate drawn by preview.py; the Bambu Lab 3MF carries
          it as Metadata/plate_1.png and plate_1_small.png, other printers' G-code as the PNG
          thumbnails their preset asks for)
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

PACK = "slicer-orcaslicer"
PACK_VERSION = os.environ.get("WIREHUB_PACK_VERSION", "dev")
ORCA = "/opt/orca"
PROFILES = os.path.join(ORCA, "resources", "profiles")
LIBRARY = "OrcaFilamentLibrary"
DEFAULT_VENDORS = ["BBL", "Qidi"]
VENDOR_LABEL = {"BBL": "Bambu Lab", "Qidi": "QIDI"}
OUT = "/work/out"
IN = "/work/in"
WORK = "/tmp/slice"

log_lines = []
findings = []
outputs = []
tool = {"name": "OrcaSlicer", "version": os.environ.get("WIREHUB_ORCA_VERSION", "unknown")}

KEY = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
# Settings that would make the slicer reach outside the container or run code.
FORBIDDEN = re.compile(r"^(post_process|host_type|print_host|print_host_webui|printhost_.*|bbl_use_printhost|thumbnails_format)$")
# Process settings an override may set although the chosen presets leave them at OrcaSlicer's
# built-in default (so they are absent from the preset files).
PROCESS_KEYS = {"enable_support", "support_type", "support_style", "support_on_build_plate_only", "support_threshold_angle",
                "brim_type", "brim_width", "brim_object_gap", "skirt_loops", "skirt_distance", "wall_loops",
                "sparse_infill_density", "sparse_infill_pattern", "top_shell_layers", "bottom_shell_layers", "layer_height",
                "initial_layer_print_height", "seam_position", "ironing_type"}
# Preset fields that are bookkeeping, not settings.
META = {"name", "inherits", "from", "type", "instantiation", "setting_id", "version", "compatible_printers",
        "compatible_printers_condition", "compatible_prints", "compatible_prints_condition", "renamed_from", "is_custom_defined"}


def log(line):
    log_lines.append(line)


def finding(level, message):
    if not any(f["message"] == message for f in findings):
        findings.append({"level": level, "message": message})


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


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


def run(args, timeout=None):
    log("$ " + " ".join(args))
    proc = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp", env={**os.environ, "HOME": "/tmp"}, timeout=timeout)
    text = proc.stdout or ""
    for line in text.splitlines()[-200:]:
        log("  " + line)
    if proc.returncode != 0:
        log(f"  (exit {proc.returncode})")
    return proc.returncode, text


def slicer_version():
    proc = subprocess.run([os.path.join(ORCA, "AppRun"), "--help"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd="/tmp", env={**os.environ, "HOME": "/tmp"})
    first = (proc.stdout or "").splitlines()[:1]
    log("$ orca-slicer --help -> " + (first[0] if first else "(no output)"))
    m = re.search(r"OrcaSlicer-([0-9][0-9.]*)", first[0] if first else "")
    if m:
        tool["version"] = m.group(1)
    tool["package"] = f"OrcaSlicer_Linux_AppImage_Ubuntu2404_V{tool['version']}.AppImage"


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------- presets

class Vendor:
    """One profile folder (resources/profiles/<id>): its index and presets by (kind, name)."""

    def __init__(self, vid):
        self.id = vid
        with open(os.path.join(PROFILES, vid + ".json"), "r", encoding="utf-8") as f:
            index = json.load(f)
        self.name = index.get("name") or vid
        self.version = index.get("version") or ""
        self.files = {}
        for kind, key in (("machine", "machine_list"), ("filament", "filament_list"), ("process", "process_list"), ("model", "machine_model_list")):
            for entry in index.get(key) or []:
                self.files[(kind, entry["name"])] = os.path.join(PROFILES, vid, entry["sub_path"])
        self._raw = {}

    def raw(self, kind, name):
        key = (kind, name)
        if key not in self._raw:
            path = self.files.get(key)
            if path is None:
                return None
            with open(path, "r", encoding="utf-8") as f:
                self._raw[key] = json.load(f)
        return self._raw[key]

    def names(self, kind):
        return [n for (k, n) in self.files if k == kind]


_vendors = {}


def vendor(vid):
    if vid not in _vendors:
        if not re.match(r"^[A-Za-z0-9 _.-]{1,64}$", vid) or not os.path.isfile(os.path.join(PROFILES, vid + ".json")):
            raise ValueError(f"OrcaSlicer {tool['version']} ships no profile folder {vid!r}")
        _vendors[vid] = Vendor(vid)
    return _vendors[vid]


def all_vendor_ids():
    return sorted(f[:-5] for f in os.listdir(PROFILES) if f.endswith(".json") and os.path.isdir(os.path.join(PROFILES, f[:-5])))


def resolve(v, kind, name, depth=0):
    """The preset with its `inherits` chain applied (parent first, child wins), as OrcaSlicer does.
    A parent missing from the maker's folder is looked up in the shared filament library."""
    if depth > 20:
        raise ValueError(f"{name}: inheritance is too deep")
    data = v.raw(kind, name)
    if data is None and v.id != LIBRARY:
        data = vendor(LIBRARY).raw(kind, name)
    if data is None:
        raise ValueError(f"no {kind} preset {name!r} in {v.id}")
    parent = data.get("inherits")
    merged = dict(resolve(v, kind, parent, depth + 1)) if parent else {}
    merged.update(data)
    return merged


def find_preset(kind, name, vendors):
    for vid in vendors:
        v = vendor(vid)
        raw = v.raw(kind, name)
        if raw is not None and str(raw.get("instantiation", "true")).lower() == "true":
            return v
    return None


def preset_hash(resolved):
    return sha256_bytes(canonical({k: v for k, v in resolved.items() if k not in ("compatible_printers", "compatible_printers_condition")}).encode("utf-8"))


def first(value):
    if isinstance(value, list):
        return value[0] if value else None
    return value


def number(value):
    try:
        return float(first(value))
    except (TypeError, ValueError):
        return None


def bed_size(machine):
    xs, ys = [], []
    for point in machine.get("printable_area") or []:
        try:
            x, y = str(point).split("x")
            xs.append(float(x))
            ys.append(float(y))
        except ValueError:
            pass
    return [round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)] if xs else None


DEFAULT_MATERIAL_HINTS = [r"^Generic PLA @", r"^Bambu PLA Basic @", r"^Qidi Generic PLA @", r"^QIDI PLA Basic @", r"PLA"]


def op_profiles(request):
    params = request.get("params") or {}
    wanted = params.get("vendors") or DEFAULT_VENDORS
    if not isinstance(wanted, list) or not all(isinstance(x, str) for x in wanted):
        finding("error", "params.vendors is a list of OrcaSlicer profile folder names")
        return "failed"
    shipped = all_vendor_ids()
    printers, processes, materials = [], [], []
    process_index, material_index = {}, {}
    vendors_out = []
    for vid in wanted:
        if vid not in shipped:
            finding("warn", f"OrcaSlicer {tool['version']} ships no profile folder {vid!r}")
            continue
        v = vendor(vid)
        vendors_out.append({"id": vid, "name": VENDOR_LABEL.get(vid, v.name), "profileVersion": v.version})
        machine_names = sorted(n for n in v.names("machine") if str(v.raw("machine", n).get("instantiation", "")).lower() == "true")
        resolved_proc = {}
        resolved_fil = {}
        for kind, store in (("process", resolved_proc), ("filament", resolved_fil)):
            for n in v.names(kind):
                raw = v.raw(kind, n)
                if str(raw.get("instantiation", "")).lower() != "true":
                    continue
                try:
                    store[n] = resolve(v, kind, n)
                except (ValueError, OSError) as error:
                    log(f"skip {kind} {n}: {error}")
        for m in machine_names:
            try:
                machine = resolve(v, "machine", m)
            except (ValueError, OSError) as error:
                log(f"skip machine {m}: {error}")
                continue
            procs = sorted(n for n, d in resolved_proc.items() if m in (d.get("compatible_printers") or []))
            fils = sorted(n for n, d in resolved_fil.items() if m in (d.get("compatible_printers") or []))
            if not procs or not fils:
                log(f"skip machine {m}: {len(procs)} process and {len(fils)} filament presets name it")
                continue
            for n in procs:
                if (vid, n) not in process_index:
                    process_index[(vid, n)] = len(processes)
                    d = resolved_proc[n]
                    processes.append({"name": n, "vendor": vid, "layerHeight": number(d.get("layer_height")), "sha256": preset_hash(d)})
            for n in fils:
                if (vid, n) not in material_index:
                    material_index[(vid, n)] = len(materials)
                    d = resolved_fil[n]
                    materials.append({"name": n, "vendor": vid, "type": first(d.get("filament_type")), "sha256": preset_hash(d)})
            default_process = machine.get("default_print_profile") if machine.get("default_print_profile") in procs else None
            if default_process is None:
                default_process = next((n for n in procs if re.match(r"^0\.20mm Standard", n)), procs[0])
            default_material = next((n for n in (machine.get("default_filament_profile") or []) if n in fils), None)
            for hint in DEFAULT_MATERIAL_HINTS:
                if default_material is not None:
                    break
                default_material = next((n for n in fils if re.search(hint, n)), None)
            printers.append({
                "name": m, "vendor": vid, "model": machine.get("printer_model"), "nozzle": number(machine.get("nozzle_diameter")),
                "bed": bed_size(machine), "height": number(machine.get("printable_height")),
                "flavor": machine.get("gcode_flavor"), "output": "gcode+3mf" if vid == "BBL" else "gcode",
                "defaultProcess": default_process, "defaultMaterial": default_material or fils[0], "sha256": preset_hash(machine),
                "processes": [process_index[(vid, n)] for n in procs], "materials": [material_index[(vid, n)] for n in fils],
            })
        log(f"{vid}: {sum(1 for p in printers if p['vendor'] == vid)} printers")
    doc = {"orcaVersion": tool["version"], "vendors": vendors_out, "printers": printers, "processes": processes, "materials": materials}
    with open(os.path.join(OUT, "profiles.json"), "w", encoding="utf-8") as f:
        json.dump(doc, f, separators=(",", ":"), sort_keys=True)
    add_output("profiles.json", "profiles", "application/json")
    finding("info", f"{len(printers)} printer presets, {len(processes)} process presets, {len(materials)} filament presets ({', '.join(v['name'] for v in vendors_out)})")
    return "ok" if printers else "failed"


# ---------------------------------------------------------------- STL handling (for "flat")

def read_stl(path):
    """Triangles as ((ax,ay,az),(bx,by,bz),(cx,cy,cz)). Binary or ASCII."""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) >= 84:
        n = struct.unpack_from("<I", data, 80)[0]
        if 84 + 50 * n == len(data):
            return [(v[3:6], v[6:9], v[9:12]) for v in (struct.unpack_from("<12f", data, 84 + 50 * i) for i in range(n))]
    text = data.decode("ascii", errors="replace")
    verts = [tuple(float(x) for x in m.groups()) for m in re.finditer(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", text)]
    if not verts or len(verts) % 3 != 0:
        raise ValueError("not a readable STL")
    return [tuple(verts[i:i + 3]) for i in range(0, len(verts), 3)]


def write_stl(path, tris):
    with open(path, "wb") as f:
        f.write(b"wirehub slicer-orcaslicer".ljust(80, b" "))
        f.write(struct.pack("<I", len(tris)))
        for t in tris:
            f.write(struct.pack("<3f", 0.0, 0.0, 0.0))
            for p in t:
                f.write(struct.pack("<3f", *p))
            f.write(b"\0\0")


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
    if c < -1 + 1e-9:
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
    """Put the largest coplanar face group that bounds the part down (same rule as slicer-prusaslicer)."""
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
    for (_, _, _, d), (area, n) in sorted(groups.items(), key=lambda kv: (-kv[1][0], kv[0]))[:50]:
        if abs(max(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] for p in points) - d) <= 0.05:
            best = (area, n)
            break
    if best is None:
        return tris, None
    m = rotation_to_down(best[1])
    return [tuple(apply(m, p) for p in t) for t in tris], best


# ---------------------------------------------------------------- 3MF uploads

# A 3MF saved by a slicer carries that slicer's project configuration (and possibly a sliced
# plate). The chosen presets are the whole profile, so the project configuration and any sliced
# results are set aside; geometry and per-object settings stay, minus anything that reaches outside.
PROJECT_PARTS = re.compile(r"^metadata/(project_settings\.config|slic3r_pe\.config|print_profile\.config|plate_\d+\.(gcode|gcode\.md5|png|json)|(pick|top|plate_no_light)_\d+\.png|slice_info\.config|filament_sequence\.json|cut_information\.xml)$")
OBJECT_CONFIG = re.compile(r"^metadata/(model_settings\.config|slic3r_pe_model\.config)$")
OBJECT_KEY = re.compile(r'<metadata\b[^>]*\bkey="([^"]*)"[^>]*/>')


def sanitize_3mf(src, dest, label):
    dropped, removed = [], []
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        if not any(n.lower().endswith(".model") for n in zin.namelist()):
            raise ValueError("the 3MF has no 3D model part")
        for info in zin.infolist():
            lower = info.filename.lower()
            data = zin.read(info.filename)
            if PROJECT_PARTS.match(lower):
                dropped.append(info.filename)
                continue
            if OBJECT_CONFIG.match(lower):
                text = data.decode("utf-8", errors="replace")

                def keep(match):
                    if FORBIDDEN.match(match.group(1)):
                        removed.append(match.group(1))
                        return ""
                    return match.group(0)
                data = OBJECT_KEY.sub(keep, text).encode("utf-8")
            zout.writestr(info, data)
    if dropped:
        finding("info", f"{label}: the file's own slicer project settings and any sliced plates were set aside; the chosen presets were used")
    if removed:
        finding("warn", f"{label}: removed per-object settings that reach outside the slice ({', '.join(sorted(set(removed)))})")
    log(f"{label}: 3MF sanitised; dropped {dropped or 'nothing'}")
    return {"projectPartsDropped": dropped, "objectSettingsRemoved": sorted(set(removed))}


# ---------------------------------------------------------------- G-code summary

def parse_duration(text):
    total = 0
    for value, unit in re.findall(r"(\d+)\s*([dhms])", text):
        total += int(value) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return total


def to_number(value):
    try:
        return round(float(value.split(",")[0].strip()), 3)
    except ValueError:
        return None


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
            elif line.startswith("; CONFIG_BLOCK_START"):
                in_config = True
            elif line.startswith("; CONFIG_BLOCK_END"):
                in_config = False
            elif in_config and line.startswith("; "):
                config.append(line[2:].rstrip("\n"))
            elif line.startswith("; ") and (" = " in line or ": " in line):
                body = line[2:].strip()
                key, _, value = body.partition(" = ") if " = " in body else body.partition(": ")
                key = key.strip()
                if key == "estimated printing time (normal mode)":
                    summary["printTimeText"] = value
                    summary["printTimeSeconds"] = parse_duration(value)
                elif key == "filament used [mm]":
                    summary["filamentMm"] = to_number(value)
                elif key == "filament used [cm3]":
                    summary["filamentCm3"] = to_number(value)
                elif key in ("filament used [g]", "total filament used [g]"):
                    summary["filamentG"] = to_number(value)
                elif key == "total filament cost":
                    summary["filamentCost"] = to_number(value)
                elif key == "total layer number":
                    summary["headerLayers"] = int(to_number(value) or 0)
                elif key == "model printing time":
                    # Bambu Lab flavour: "; model printing time: 11m 36s; total estimated time: 18m 52s"
                    total = re.search(r"total estimated time:\s*(.+)$", value)
                    if total and "printTimeText" not in summary:
                        summary["printTimeText"] = total.group(1).strip()
                        summary["printTimeSeconds"] = parse_duration(summary["printTimeText"])
                elif key == "max_z_height":
                    summary["maxZ"] = to_number(value)
    summary["heightMm"] = round(summary.pop("maxZ", None) or max_z, 3)
    header_layers = summary.pop("headerLayers", 0)
    if summary["layers"] == 0 or header_layers > 0:
        summary["layers"] = header_layers or summary["layers"]
    return summary, config


# ---------------------------------------------------------------- slice

def as_orca_value(current, value):
    """A JSON override in the shape OrcaSlicer's preset uses for that key (strings; per-extruder lists)."""
    if isinstance(value, bool):
        text = "1" if value else "0"
    elif isinstance(value, (int, float)):
        text = repr(value) if isinstance(value, float) else str(value)
    else:
        text = str(value)
    if isinstance(current, list):
        return [text] * max(1, len(current))
    return text


def write_preset(resolved, kind, name, path):
    """The resolved preset as a user preset over the system one it came from, so OrcaSlicer's own
    printer/process compatibility check sees the system names it expects."""
    data = dict(resolved)
    data.update({"type": kind, "name": name, "from": "User", "inherits": name})
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True)


def finalize_3mf(src, dest, v, printer_model, thumbs):
    """Two things the CLI leaves out of the printer 3MF:
    - the plate's printer_model_id (it looks for a Bambu Studio resource layout); a printer reads it
      to tell a file sliced for it. Filled from the maker's model preset.
    - the plate preview the package relationships already name (Metadata/plate_1.png 512x512 and
      plate_1_small.png 128x128, what the printer's screen shows): drawn by preview.py.
    The plate G-code and its .md5 stay byte for byte."""
    model = v.raw("model", printer_model or "") or {}
    model_id = model.get("model_id")
    if not model_id or not re.match(r"^[A-Za-z0-9_-]{1,32}$", model_id):
        model_id = None
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zout:
        names = set(zin.namelist())
        for info in zin.infolist():
            if info.filename in thumbs:
                continue
            data = zin.read(info.filename)
            if info.filename == "Metadata/slice_info.config" and model_id:
                data = data.replace(b'<metadata key="printer_model_id" value=""/>', f'<metadata key="printer_model_id" value="{model_id}"/>'.encode("ascii"))
            if info.filename == "Metadata/model_settings.config" and "Metadata/plate_1.png" in thumbs and b'key="thumbnail_file"' not in data:
                data = data.replace(b'<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>',
                                    b'<metadata key="gcode_file" value="Metadata/plate_1.gcode"/>\n    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>', 1)
            zout.writestr(info, data)
        for path in sorted(thumbs):
            zout.writestr(zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0)), thumbs[path], compress_type=zipfile.ZIP_STORED)
    if model_id:
        log(f"printer 3MF: printer_model_id {model_id} ({printer_model})")
    if thumbs:
        log("printer 3MF: " + ", ".join(sorted(thumbs)) + (" (replaced)" if names & set(thumbs) else ""))


def plate_preview(three_mf):
    """The 512x512 plate drawing and the meshes it came from, or (None, None) with an info finding."""
    try:
        meshes = preview.plate_meshes(three_mf)
        return preview.render(meshes, 512, 512), meshes
    except (ValueError, KeyError, OSError, zipfile.BadZipFile, ET.ParseError) as error:
        finding("info", f"no plate preview: {error}")
        return None, None


def add_gcode_thumbnails(path, meshes, sizes):
    """PNG thumbnails at the sizes the printer preset asks for, after the G-code's header block."""
    block = preview.gcode_thumbnails(meshes, sizes)
    with open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
        text = f.read()
    marker = "; HEADER_BLOCK_END\n"
    at = text.find(marker)
    at = at + len(marker) if at >= 0 else 0
    with open(path, "w", encoding="utf-8", errors="surrogateescape") as f:
        f.write(text[:at] + "\n" + block + text[at:])
    log("G-code thumbnails: " + ", ".join(f"{w}x{h}" for w, h in sizes))


def op_slice(request):
    params = request.get("params") or {}
    inputs = request.get("inputs") or []
    presets = params.get("presets") or {}
    overrides = params.get("overrides") or {}
    orientation = params.get("orientation") or "as-designed"
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(params.get("name") or "print")).strip("-.") or "print"
    if orientation not in ("as-designed", "flat"):
        finding("error", f"orientation {orientation!r} is not as-designed or flat")
        return "failed"
    if not isinstance(presets, dict) or not all(isinstance(presets.get(k), str) and presets.get(k) for k in ("printer", "material", "process")):
        finding("error", "params.presets names a printer, a material and a process preset")
        return "failed"
    if not isinstance(overrides, dict):
        finding("error", "params.overrides must be an object of OrcaSlicer settings")
        return "failed"
    vendors = params.get("vendors") or all_vendor_ids()
    mv = find_preset("machine", presets["printer"], vendors)
    if mv is None:
        finding("error", f"OrcaSlicer {tool['version']} has no printer preset {presets['printer']!r}")
        return "failed"
    machine = resolve(mv, "machine", presets["printer"])
    try:
        process = resolve(mv, "process", presets["process"])
        filament = resolve(mv, "filament", presets["material"])
    except ValueError as error:
        finding("error", f"{error} (presets come from the printer's maker folder, {mv.id})")
        return "failed"
    for label, d, pname in (("process", process, presets["process"]), ("material", filament, presets["material"])):
        if presets["printer"] not in (d.get("compatible_printers") or []):
            finding("error", f"the {label} preset {pname!r} is not offered for {presets['printer']!r}")
            return "failed"
    hashes = {"printer": preset_hash(machine), "material": preset_hash(filament), "process": preset_hash(process)}

    applied = {}
    for key in sorted(overrides):
        value = overrides[key]
        if not KEY.match(key) or key in META:
            finding("error", f"setting {key!r} is not an OrcaSlicer setting this pack accepts")
            return "failed"
        if FORBIDDEN.match(key):
            finding("error", f"setting {key!r} is not allowed in this pack (it reaches outside the slice)")
            return "failed"
        if not isinstance(value, (str, int, float, bool)) or (isinstance(value, str) and len(value) > 4000):
            finding("error", f"setting {key!r} must be a short string, number or boolean")
            return "failed"
        target = process if key in process else filament if key in filament else machine if key in machine else process if key in PROCESS_KEYS else None
        if target is None:
            finding("error", f"setting {key!r} is not in the chosen presets")
            return "failed"
        target[key] = as_orca_value(target.get(key), value)
        applied[key] = target[key]

    os.makedirs(WORK, exist_ok=True)
    for d in (machine, process, filament):
        for key in list(d):
            if FORBIDDEN.match(key):
                del d[key]
    write_preset(machine, "machine", presets["printer"], os.path.join(WORK, "machine.json"))
    write_preset(process, "process", presets["process"], os.path.join(WORK, "process.json"))
    write_preset(filament, "filament", presets["material"], os.path.join(WORK, "filament.json"))
    requested = {"presets": presets, "presetSha256": hashes, "overrides": applied, "orientation": orientation, "orca": tool["version"], "vendor": mv.id}
    with open(os.path.join(OUT, f"{name}.request.json"), "w", encoding="utf-8") as f:
        json.dump(requested, f, indent=2, sort_keys=True)

    by_path = {i["path"]: i for i in inputs}
    parts = params.get("parts") or [{"path": i["path"], "copies": 1} for i in inputs]
    models = []
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
            dest = os.path.join(WORK, "plate.3mf")
            try:
                three_mf = sanitize_3mf(src, dest, os.path.basename(rel))
            except (zipfile.BadZipFile, ValueError, KeyError) as error:
                finding("error", f"{rel}: not a readable 3MF ({error})")
                return "failed"
            models.append(dest)
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
        # resting on the bed (the slicer arranges the parts in X/Y around the printer's exclusion zones)
        z0 = min(p[2] for t in tris for p in t)
        tris = [tuple((p[0], p[1], p[2] - z0) for p in t) for t in tris]
        path = os.path.join(WORK, f"part-{len(models)}-{re.sub(r'[^A-Za-z0-9._-]+', '-', os.path.basename(rel))}")
        write_stl(path, tris)
        models.extend([path] * copies)

    printer3mf = params.get("printer3mf", "auto")
    want_3mf = mv.id == "BBL" if printer3mf == "auto" else bool(printer3mf)
    outdir = os.path.join(WORK, "out")
    os.makedirs(outdir, exist_ok=True)
    args = [os.path.join(ORCA, "AppRun"), "--debug", "2", "--slice", "0",
            "--load-settings", f"{os.path.join(WORK, 'machine.json')};{os.path.join(WORK, 'process.json')}",
            "--load-filaments", os.path.join(WORK, "filament.json"),
            "--orient", "0", "--arrange", "0" if three_mf is not None else "1", "--allow-rotations=0",
            "--outputdir", outdir]
    if three_mf is not None:
        args.append("--ensure-on-bed")
    # the 3MF is always written: the preview reads the arranged plate from it (published for Bambu Lab only)
    args += ["--export-3mf", f"{name}.gcode.3mf"]
    code, text = run(args + models)
    result = {}
    try:
        with open(os.path.join(outdir, "result.json"), "r", encoding="utf-8") as f:
            result = json.load(f)
        log("result.json: " + canonical(result))
    except (OSError, ValueError):
        pass
    plates = sorted(f for f in os.listdir(outdir) if re.match(r"^plate_\d+\.gcode$", f))
    if result.get("return_code", code) != 0 or not plates:
        reason = result.get("error_string") or next((l.strip() for l in text.splitlines() if "error" in l.lower()), None)
        if reason:
            finding("error", f"OrcaSlicer: {reason[:300]}")
        finding("error", f"OrcaSlicer did not produce G-code (exit {code}, return code {result.get('return_code', '?')})")
        return "failed"
    if len(plates) > 1:
        finding("error", f"the parts were arranged onto {len(plates)} plates; slice fewer at a time")
        return "failed"
    for plate in result.get("sliced_plates") or []:
        if plate.get("warning_message"):
            finding("warn", f"OrcaSlicer: {plate['warning_message'][:300]}")
    gcode_rel = f"{name}.gcode"
    shutil.move(os.path.join(outdir, plates[0]), os.path.join(OUT, gcode_rel))
    summary, effective = summarize(os.path.join(OUT, gcode_rel))
    with open(os.path.join(OUT, f"{name}.effective.ini"), "w", encoding="utf-8") as f:
        f.write("\n".join(effective) + "\n")
    effective_sha = sha256_bytes(("\n".join(effective) + "\n").encode("utf-8"))
    produced = os.path.join(outdir, f"{name}.gcode.3mf")
    image, meshes = plate_preview(produced) if os.path.isfile(produced) else (None, None)
    if image is not None:
        with open(os.path.join(OUT, f"{name}.preview.png"), "wb") as f:
            f.write(preview.png(image, 512, 512))
        # the printer 3MF's plate G-code must stay the .gcode output byte for byte: thumbnails go in the plain G-code only for other printers
        sizes = preview.thumbnail_sizes(next((l.split("=", 1)[1] for l in effective if l.startswith("thumbnails =")), ""))
        if not want_3mf and sizes:
            add_gcode_thumbnails(os.path.join(OUT, gcode_rel), meshes, sizes)
    if want_3mf:
        if not os.path.isfile(produced):
            finding("error", "OrcaSlicer did not write the printer 3MF")
            return "failed"
        with zipfile.ZipFile(produced) as z:
            names = set(z.namelist())
            if "Metadata/plate_1.gcode" not in names or "Metadata/plate_1.gcode.md5" not in names:
                finding("error", "the printer 3MF has no sliced plate (Metadata/plate_1.gcode and its .md5)")
                return "failed"
            md5 = z.read("Metadata/plate_1.gcode.md5").decode("ascii", errors="replace").strip().lower()
            if hashlib.md5(z.read("Metadata/plate_1.gcode")).hexdigest() != md5:
                finding("error", "the printer 3MF's plate G-code does not match its .md5")
                return "failed"
        thumbs = {}
        if image is not None:
            small, w, h = preview.downscale(image, 512, 512, 4)
            thumbs = {"Metadata/plate_1.png": preview.png(image, 512, 512), "Metadata/plate_1_small.png": preview.png(small, w, h)}
        finalize_3mf(produced, os.path.join(OUT, f"{name}.gcode.3mf"), mv, machine.get("printer_model"), thumbs)
    summary.update({
        "slicer": tool,
        "presets": presets,
        "presetSha256": hashes,
        "vendor": mv.id,
        "printerModel": machine.get("printer_model"),
        "overrides": applied,
        "orientation": orientation,
        "parts": [{"path": p.get("path"), "copies": int(p.get("copies") or 1)} for p in parts],
        "effectiveProfileSha256": effective_sha,
        "printer3mf": want_3mf,
        **({"threeMf": three_mf} if three_mf is not None else {}),
        "effectiveSettings": len(effective),
    })
    if summary["layers"] == 0:
        finding("warn", "the G-code has no layer changes; check the part size and profile")
    with open(os.path.join(OUT, f"{name}.summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, sort_keys=True)
    add_output(gcode_rel, "gcode", "text/x.gcode")
    if want_3mf:
        add_output(f"{name}.gcode.3mf", "gcode-3mf", "model/3mf")
    add_output(f"{name}.summary.json", "summary", "application/json")
    add_output(f"{name}.effective.ini", "effective-profile", "text/plain")
    add_output(f"{name}.request.json", "requested-profile", "application/json")
    if image is not None:
        add_output(f"{name}.preview.png", "preview", "image/png")
    finding("info", f"{presets['printer']} · {presets['material']} · {presets['process']}: {summary['layers']} layers, {summary.get('printTimeText', '?')}, {summary.get('filamentG', '?')} g filament (estimates)")
    return "ok"


def self_check():
    slicer_version()
    for vid in DEFAULT_VENDORS + [LIBRARY]:
        vendor(vid)
    print(f"OrcaSlicer {tool['version']}; profile folders: {len(all_vendor_ids())}")
    return 0 if tool["version"] != "unknown" else 1


def main():
    if sys.argv[1:] == ["--self-check"]:
        return self_check()
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
        handler = {"slice": op_slice, "profiles": op_profiles}.get(op)
        if handler is None:
            finding("error", f"unknown op {op!r}")
        else:
            try:
                status = handler(request)
            except (ValueError, OSError, subprocess.SubprocessError) as error:  # an honest failure, with the reason
                finding("error", f"{op} failed: {error}")
                status = "failed"
    with open(os.path.join(OUT, "log.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(log_lines) + "\n")
    manifest = {
        "pack": PACK, "packVersion": PACK_VERSION, "tool": tool, "op": op,
        "inputs": [{"path": i["path"], "sha256": i.get("sha256")} for i in declared],
        "outputs": outputs if status == "ok" else [o for o in outputs if o["role"] not in ("gcode", "gcode-3mf")],
        "log": "log.txt", "status": status, "findings": findings,
    }
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
