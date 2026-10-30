"""Plate preview images without a display (pure Python: no GL, no numpy).

OrcaSlicer's CLI renders no thumbnail headless (its glfw context request asks for "OpenGL 3.4",
glfw's own version, which no driver offers), so the pack draws one itself from the sliced plate's
3MF: every build item's mesh where the slicer placed it, flat shaded in its filament colour, seen
from the front right and above, fitted to the image, on a transparent background.

Kept identical in tools/slicer-orcaslicer, tools/slicer-prusaslicer and tools/slicer-resin (each pack builds
from its own folder).

Used for the Bambu Lab printer 3MF (`Metadata/plate_1.png` 512x512 and `plate_1_small.png`
128x128, the files its relationships already name), G-code thumbnails a printer preset asks for
(`; thumbnail begin WxH len` blocks, PNG) and the run's own preview output.
"""

import base64
import json
import math
import re
import struct
import xml.etree.ElementTree as ET
import zipfile
import zlib

NS = {"m": "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"}
PROD = "{http://schemas.microsoft.com/3dmanufacturing/production/2015/06}path"
IDENTITY = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0)
DEFAULT_COLOUR = (0x9A, 0xA4, 0xB1)
MAX_TRIANGLES = 2_000_000


def _matrix(text):
    if not text:
        return IDENTITY
    values = tuple(float(v) for v in text.split())
    if len(values) != 12:
        raise ValueError(f"3MF transform has {len(values)} values")
    return values


def _compose(inner, outer):
    """inner applied first, then outer (3MF row-vector convention: p' = p * M)."""
    a, b = inner, outer
    rot = [0.0] * 9
    for r in range(3):
        for c in range(3):
            rot[r * 3 + c] = sum(a[r * 3 + k] * b[k * 3 + c] for k in range(3))
    t = [sum(a[9 + k] * b[k * 3 + c] for k in range(3)) + b[9 + c] for c in range(3)]
    return tuple(rot + t)


def _apply(m, p):
    x, y, z = p
    return (x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11])


def _colour(text):
    m = re.match(r"^#?([0-9A-Fa-f]{6})", text or "")
    return tuple(int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4)) if m else DEFAULT_COLOUR


def plate_meshes(path, colour=None):
    """[(colour, triangles)] for each build item of a 3MF, in plate coordinates (`colour`: "#rrggbb" when the 3MF names none)."""
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        docs = {}

        def doc(part):
            part = part.lstrip("/")
            if part not in docs:
                if part not in names:
                    raise ValueError(f"3MF part {part} is missing")
                docs[part] = ET.fromstring(z.read(part))
            return docs[part]

        colours = []
        if "Metadata/project_settings.config" in names:
            try:
                colours = [_colour(c) for c in json.loads(z.read("Metadata/project_settings.config")).get("filament_colour") or []]
            except ValueError:
                colours = []
        if not colours and colour:
            colours = [_colour(colour)]
        extruder = {}
        if "Metadata/model_settings.config" in names:
            for obj in ET.fromstring(z.read("Metadata/model_settings.config")).iter("object"):
                for meta in obj.findall("metadata"):
                    if meta.get("key") == "extruder" and (meta.get("value") or "").isdigit():
                        extruder[obj.get("id")] = int(meta.get("value"))

        count = [0]

        def triangles(part, oid, m, out, depth=0):
            if depth > 8:
                raise ValueError("3MF components nest too deep")
            root = doc(part)
            obj = next((o for o in root.iterfind("m:resources/m:object", NS) if o.get("id") == oid), None)
            if obj is None:
                raise ValueError(f"3MF object {oid} is missing in {part}")
            mesh = obj.find("m:mesh", NS)
            if mesh is not None:
                before = len(out)
                verts = [_apply(m, (float(v.get("x")), float(v.get("y")), float(v.get("z")))) for v in mesh.iterfind("m:vertices/m:vertex", NS)]
                for t in mesh.iterfind("m:triangles/m:triangle", NS):
                    out.append((verts[int(t.get("v1"))], verts[int(t.get("v2"))], verts[int(t.get("v3"))]))
                count[0] += len(out) - before
                if count[0] > MAX_TRIANGLES:
                    raise ValueError("too many triangles for a preview")
            for comp in obj.iterfind("m:components/m:component", NS):
                triangles(comp.get(PROD) or part, comp.get("objectid"), _compose(_matrix(comp.get("transform")), m), out, depth + 1)

        result = []
        for item in doc("3D/3dmodel.model").iterfind("m:build/m:item", NS):
            tris = []
            triangles(item.get(PROD) or "3D/3dmodel.model", item.get("objectid"), _matrix(item.get("transform")), tris)
            n = extruder.get(item.get("objectid"), 1)
            result.append((colours[n - 1] if 0 < n <= len(colours) else colours[0] if colours else DEFAULT_COLOUR, tris))
        return result


def render(meshes, width, height, azimuth=30.0, elevation=38.0, margin=0.06):
    """RGBA bytes (width x height) of the meshes, flat shaded, fitted with a margin; supersampled 2x for small meshes."""
    a, e = math.radians(azimuth), math.radians(elevation)
    view = (math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))  # towards the camera
    right = (math.cos(a), math.sin(a), 0.0)
    up = (view[1] * right[2] - view[2] * right[1], view[2] * right[0] - view[0] * right[2], view[0] * right[1] - view[1] * right[0])
    light = (0.35 * view[0] + 0.45, 0.35 * view[1] - 0.25, 0.35 * view[2] + 0.75)
    ln = math.sqrt(sum(c * c for c in light))
    light = tuple(c / ln for c in light)
    total = sum(len(t) for _, t in meshes)
    ss = 2 if total <= 200_000 else 1
    W, H = width * ss, height * ss
    proj = []
    xs, ys = [], []
    for colour, tris in meshes:
        for tri in tris:
            p = [(q[0] * right[0] + q[1] * right[1], q[0] * up[0] + q[1] * up[1] + q[2] * up[2], q[0] * view[0] + q[1] * view[1] + q[2] * view[2]) for q in tri]
            proj.append((colour, tri, p))
            for q in p:
                xs.append(q[0])
                ys.append(q[1])
    if not proj:
        raise ValueError("the plate has no triangles")
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    scale = min(W * (1 - 2 * margin) / max(x1 - x0, 1e-6), H * (1 - 2 * margin) / max(y1 - y0, 1e-6))
    ox = W / 2 - (x0 + x1) / 2 * scale
    oy = H / 2 + (y0 + y1) / 2 * scale
    zbuf = [-math.inf] * (W * H)
    rgb = [None] * (W * H)
    for colour, tri, p in proj:
        (ax, ay, az), (bx, by, bz), (cx, cy, cz) = tri
        ux, uy, uz = bx - ax, by - ay, bz - az
        vx, vy, vz = cx - ax, cy - ay, cz - az
        nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
        nl = math.sqrt(nx * nx + ny * ny + nz * nz)
        if nl == 0:
            continue
        nx, ny, nz = nx / nl, ny / nl, nz / nl
        if nx * view[0] + ny * view[1] + nz * view[2] < 0:  # two-sided: face the camera
            nx, ny, nz = -nx, -ny, -nz
        shade = 0.32 + 0.68 * max(0.0, nx * light[0] + ny * light[1] + nz * light[2])
        col = (min(255, int(colour[0] * shade)), min(255, int(colour[1] * shade)), min(255, int(colour[2] * shade)))
        s = [(ox + q[0] * scale, oy - q[1] * scale, q[2]) for q in p]
        (sx0, sy0, sz0), (sx1, sy1, sz1), (sx2, sy2, sz2) = s
        det = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0)
        if abs(det) < 1e-12:
            continue
        # depth as a plane over the screen: z = sz0 + dzx (x - sx0) + dzy (y - sy0)
        dzx = ((sz1 - sz0) * (sy2 - sy0) - (sz2 - sz0) * (sy1 - sy0)) / det
        dzy = ((sx1 - sx0) * (sz2 - sz0) - (sx2 - sx0) * (sz1 - sz0)) / det
        top = max(0, math.ceil(min(sy0, sy1, sy2) - 0.5))
        bottom = min(H - 1, math.floor(max(sy0, sy1, sy2) - 0.5))
        edges = ((sx0, sy0, sx1, sy1), (sx1, sy1, sx2, sy2), (sx2, sy2, sx0, sy0))
        for row in range(top, bottom + 1):
            yc = row + 0.5
            cross = []
            for (ex0, ey0, ex1, ey1) in edges:
                if (ey0 <= yc < ey1) or (ey1 <= yc < ey0):
                    cross.append(ex0 + (yc - ey0) * (ex1 - ex0) / (ey1 - ey0))
            if len(cross) < 2:
                continue
            left = max(0, math.ceil(min(cross) - 0.5))
            rightx = min(W - 1, math.floor(max(cross) - 0.5))
            if rightx < left:
                continue
            base = row * W
            z = sz0 + dzx * (left + 0.5 - sx0) + dzy * (yc - sy0)
            for i in range(base + left, base + rightx + 1):
                if z > zbuf[i]:
                    zbuf[i] = z
                    rgb[i] = col
                z += dzx
    # outlines: a pixel next to a crease (a clear shade change) or a depth step (an edge in front of a surface) is darkened
    step = max(0.6, 3.0 / scale)
    edged = list(rgb)
    for y in range(H - 1):
        base = y * W
        for i in range(base, base + W - 1):
            c = rgb[i]
            if c is None:
                continue
            for j in (i + 1, i + W):
                d = rgb[j]
                if d is not None and (abs(d[0] - c[0]) + abs(d[1] - c[1]) + abs(d[2] - c[2]) > 40 or abs(zbuf[j] - zbuf[i]) > step):
                    # the farther pixel of the pair takes the line, so silhouettes stay crisp
                    k = j if zbuf[j] < zbuf[i] else i
                    e = rgb[k]
                    edged[k] = (e[0] * 3 // 5, e[1] * 3 // 5, e[2] * 3 // 5)
    rgb = edged
    out = bytearray(width * height * 4)
    n = ss * ss
    for y in range(height):
        for x in range(width):
            r = g = b = cnt = 0
            for dy in range(ss):
                base = (y * ss + dy) * W + x * ss
                for dx in range(ss):
                    c = rgb[base + dx]
                    if c is not None:
                        r += c[0]
                        g += c[1]
                        b += c[2]
                        cnt += 1
            if cnt:
                o = (y * width + x) * 4
                out[o:o + 4] = bytes((r // cnt, g // cnt, b // cnt, 255 * cnt // n))
    return bytes(out)


def downscale(rgba, width, height, factor):
    """Box-filter an RGBA image down by an integer factor (alpha weighted)."""
    w, h = width // factor, height // factor
    out = bytearray(w * h * 4)
    n = factor * factor
    for y in range(h):
        for x in range(w):
            r = g = b = a = 0
            for dy in range(factor):
                o = ((y * factor + dy) * width + x * factor) * 4
                for dx in range(factor):
                    pa = rgba[o + 3]
                    r += rgba[o] * pa
                    g += rgba[o + 1] * pa
                    b += rgba[o + 2] * pa
                    a += pa
                    o += 4
            if a:
                q = (y * w + x) * 4
                out[q:q + 4] = bytes((r // a, g // a, b // a, a // n))
    return bytes(out), w, h


def png(rgba, width, height):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def thumbnail_sizes(value):
    """OrcaSlicer's `thumbnails` setting ("48x48/PNG,300x300/PNG" or "272x272, 96x96") -> PNG sizes; other formats are skipped."""
    sizes = []
    for item in re.split(r"[,;]", value or ""):
        m = re.match(r"^\s*(\d{1,4})x(\d{1,4})(?:/(\w+))?\s*$", item)
        if m and (m.group(3) or "PNG").upper() == "PNG":
            w, h = int(m.group(1)), int(m.group(2))
            if 8 <= w <= 1024 and 8 <= h <= 1024 and (w, h) not in sizes:
                sizes.append((w, h))
    return sizes


def gcode_thumbnails(meshes, sizes):
    """The `; thumbnail begin WxH len` block printers with Klipper-style screens read."""
    lines = ["; THUMBNAIL_BLOCK_START"]
    for w, h in sizes:
        data = base64.b64encode(png(render(meshes, w, h), w, h)).decode("ascii")
        lines += [";", f"; thumbnail begin {w}x{h} {len(data)}"] + [f"; {data[i:i + 78]}" for i in range(0, len(data), 78)] + ["; thumbnail end", ";"]
    lines.append("; THUMBNAIL_BLOCK_END")
    return "\n".join(lines) + "\n\n"
