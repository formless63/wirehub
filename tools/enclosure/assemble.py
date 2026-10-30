"""WireHub tool pack `enclosure`, op `device-assemble`: one device (boards, enclosure base and lid,
hardware, schematic cable routes) as an assembly STEP, a GLB, a preview and an orthographic drawing
sheet.

    docker run --rm --network none --read-only --tmpfs /tmp \
        -v <in>:/work/in:ro -v <out>:/work/out wirehub-tool-enclosure:<v> \
        device-assemble /work/in/request.json

The studio composes the device (`deviceScene` in `@wirehub/model`): every placed thing arrives as a
part with its own path, a 4x4 matrix in the device frame (millimetres, z up) and the geometry to
draw it with. This op places and exports; it never re-derives a placement.

`params.parts[]`: `{ path, kind, label, def?, group?, matrix, color?, provisional?, geometry }` where
`geometry` is one of
- `{ type: "step", input, frame: "board" | "as-is" }`: a STEP file under /work/in. `board` moves a
  board's own STEP (KiCad's) into the board-local frame the matrices use: the PCB body's outline
  minimum at the origin, its underside at z = 0.
- `{ type: "board", outline, thickness, components }`: a board drawn from its outline and footprint
  boxes (the enclosure request's board dummy).
- `{ type: "box", size }`: a declared box, origin at its minimum corner.
- `{ type: "hardware", shape: screw | standoff | foot, params }`: the parametric hardware, z up:
  a screw's head above z = 0 and shank below, a standoff on z = 0, a foot hanging below z = 0.
- `{ type: "tube", points, radius }`: a schematic cable route, device frame.

`params.drawing` (optional): `{ title, subtitle, revision, date, items: [{ qty, label, note? }],
notes: [], openings: [{ label, face, center: [x, y, z], width, height, shape }], mounts: [{ label,
at: [x, y, z], d }], fasteners: [{ kind: lid-screw | foot, label, at: [x, y, z], d }], sheets: [{ path,
frame, title, subtitle, items, openings, mounts, fasteners }] }` for the sheet's title block, parts
list and its opening, mounting-hole and lid-screw/feet tables (device frame; positions are given
from the device's front-left-bottom corner; lid screws and feet also get their pitch dimensioned).
Each `sheets[]` entry is a further sheet for a nested sub-device: the parts whose path starts with
`<path>/`, moved by `frame` (device frame → the sub-device's own), its tables in that frame. `false`
skips the drawing.

Outputs (manifest roles): `device-step` (device.step, one named, coloured solid per part, grouped by
sub-assembly), `device-glb` (device.glb, millimetres, y up like the Library's GLBs), `preview-image`
(device-preview.png), `device-drawing` (device-drawing.svg, A3: front, top and right views in
third-angle projection with hidden lines, section B-B through the x centre, an isometric view,
overall dimensions, opening and mounting-hole tables keyed by balloons, parts list and title
block; sheet 1), `device-drawing-pdf` (every sheet as one vector PDF, a page each) and `result` (device-result.json, no timings so it is byte-reproducible: bounding box, each part's geometry and status, the
drawing's scale).
"""

import copy
import hashlib
import json
import math
import os
import sys
import time
import traceback

PACK = "enclosure"
PACK_VERSION = os.environ.get("PACK_VERSION", "0.0.0-dev")
OUT = os.environ.get("PACK_OUT", "/work/out")
IN_ROOT = os.environ.get("PACK_IN", "/work/in")
OPS = ("device-assemble",)

LOG: list[str] = []

COLORS = {
    "enclosure": (0.62, 0.65, 0.70),
    "lid": (0.74, 0.77, 0.81),
    "board": (0.08, 0.45, 0.22),
    "component": (0.18, 0.18, 0.20),
    "hardware": (0.70, 0.71, 0.74),
    "foot": (0.15, 0.15, 0.16),
    "cable": (0.20, 0.36, 0.75),
    "other": (0.60, 0.55, 0.45),
}


class Invalid(Exception):
    pass


def log(msg: str) -> None:
    LOG.append(msg)
    print(msg, file=sys.stderr)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _num(v, what):
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        raise Invalid(f"{what} is not a number")
    return float(v)


def _matrix(m, what):
    if not (isinstance(m, list) and len(m) in (3, 4) and all(isinstance(r, list) and len(r) == 4 for r in m)):
        raise Invalid(f"{what}: matrix is a 4x4 row-major list")
    return [[_num(x, what) for x in r] for r in m[:3]]


# --------------------------------------------------------------------------- geometry

def located(shape, m):
    """The shape moved by a row-major 4x4 (rotation + translation) matrix."""
    from build123d import Location
    from OCP.gp import gp_Trsf
    t = gp_Trsf()
    t.SetValues(m[0][0], m[0][1], m[0][2], m[0][3],
                m[1][0], m[1][1], m[1][2], m[1][3],
                m[2][0], m[2][1], m[2][2], m[2][3])
    return shape.moved(Location(t))


def board_body(compound, size):
    """The PCB body of a board's STEP: by label, else the solid whose extents match the outline."""
    solids = list(compound.solids())
    for s in solids:
        if "pcb" in (getattr(s, "label", "") or "").lower():
            return s
    if size is not None:
        w, l = size[0], size[1]
        best, err = None, None
        for s in solids:
            bb = s.bounding_box()
            e = abs(bb.size.X - w) + abs(bb.size.Y - l)
            if bb.size.Z < 4 and (err is None or e < err):
                best, err = s, e
        if best is not None and err < 2.0:
            return best
    return None


def board_from_outline(g, label):
    from build123d import Box, Compound, Polygon, Pos, extrude
    outline = g.get("outline") or []
    if len(outline) < 3:
        raise Invalid(f"{label}: a board needs an outline of at least three points")
    t = _num(g.get("thickness", 1.6), f"{label} thickness")
    pts = [(_num(x, label), _num(y, label)) for x, y in outline]
    pcb = extrude(Polygon(*pts, align=None), amount=t)
    pcb.label = "pcb"
    pcb.color = COLORS["board"]
    children = [pcb]
    for c in g.get("components") or []:
        x0, x1 = sorted((_num(c["x0"], label), _num(c["x1"], label)))
        y0, y1 = sorted((_num(c["y0"], label), _num(c["y1"], label)))
        h = c.get("height")
        h = 3.0 if h is None else max(0.2, _num(h, label))
        if x1 - x0 < 0.05 or y1 - y0 < 0.05:
            continue
        z = t if c.get("side", "top") != "bottom" else -h
        part = Pos((x0 + x1) / 2, (y0 + y1) / 2, z + h / 2) * Box(x1 - x0, y1 - y0, h)
        part.label = str(c.get("ref") or "part")
        part.color = COLORS["component"]
        children.append(part)
    return Compound(children=children)


def hardware(g, label):
    from build123d import Align, Compound, Cone, Cylinder, Pos, RegularPolygon, extrude
    shape, p = g.get("shape"), g.get("params") or {}
    up = (Align.CENTER, Align.CENTER, Align.MIN)
    down = (Align.CENTER, Align.CENTER, Align.MAX)
    if shape == "screw":
        d, ln = _num(p["diameterMm"], label), _num(p["lengthMm"], label)
        hd, hh = _num(p["headDiameterMm"], label), _num(p["headHeightMm"], label)
        head = Cone(hd / 2, hd / 2.3, hh, align=up)
        shank = Cylinder(d / 2, ln, align=down)
        return Compound(children=[head, shank])
    if shape == "standoff":
        af, ln = _num(p["acrossFlatsMm"], label), _num(p["lengthMm"], label)
        return extrude(RegularPolygon(af / math.sqrt(3), 6), amount=ln)
    if shape == "foot":
        d, h = _num(p["diameterMm"], label), _num(p["heightMm"], label)
        return Pos(0, 0, -h) * Cone(d / 2.5, d / 2, h, align=up)
    raise Invalid(f"{label}: hardware shape {shape!r} is not one of screw, standoff, foot")


def tube(g, label):
    """A cable route: a cylinder per leg and a ball at each bend (robust where a sweep is not)."""
    from build123d import Compound, Plane, Pos, Solid, Sphere, Vector
    r = _num(g.get("radius", 2.2), f"{label} radius")
    pts = [Vector(*[_num(c, label) for c in p]) for p in g.get("points") or []]
    if len(pts) < 2:
        raise Invalid(f"{label}: a route needs at least two points")
    legs = []
    for a, b in zip(pts, pts[1:]):
        d = b - a
        if d.length < 1e-6:
            continue
        legs.append(Solid.make_cylinder(r, d.length, Plane(origin=a, z_dir=d)))
    for p in pts[1:-1]:
        legs.append(Pos(p) * Sphere(r))
    return Compound(children=legs)


class StepCache:
    def __init__(self):
        self.shapes = {}

    def get(self, rel):
        if rel not in self.shapes:
            from build123d import import_step
            path = os.path.normpath(os.path.join(IN_ROOT, rel))
            if not path.startswith(IN_ROOT + os.sep) or not os.path.isfile(path):
                raise Invalid(f"input {rel!r} is missing or outside /work/in")
            t0 = time.time()
            self.shapes[rel] = import_step(path)
            log(f"read {rel} in {time.time() - t0:.1f} s")
        # each use its own copy: two occurrences of one board must stay two named parts
        return copy.deepcopy(self.shapes[rel])


def part_shape(part, steps, findings):
    """The part's geometry in its own frame, and how it was drawn."""
    g = part.get("geometry") or {}
    label = part.get("path", "?")
    kind = g.get("type")
    if kind == "step":
        shape = steps.get(g.get("input", ""))
        if g.get("frame") == "board":
            body = board_body(shape, part.get("size"))
            if body is None:
                findings.append(("warn", f"{label}: no PCB body found in its STEP; placed by the whole model's extents."))
                bb = shape.bounding_box()
            else:
                bb = body.bounding_box()
            from build123d import Pos
            shape = Pos(-bb.min.X, -bb.min.Y, -bb.min.Z) * shape
        return shape, "step"
    if kind == "board":
        return board_from_outline(g, label), "outline"
    if kind == "box":
        from build123d import Align, Box
        sx, sy, sz = (max(0.1, _num(v, label)) for v in g.get("size") or [0, 0, 0])
        return Box(sx, sy, sz, align=(Align.MIN, Align.MIN, Align.MIN)), "box"
    if kind == "hardware":
        return hardware(g, label), "parametric"
    if kind == "tube":
        return tube(g, label), "route"
    raise Invalid(f"{label}: geometry type {kind!r} is not step, board, box, hardware or tube")


def colour_of(part):
    c = part.get("color")
    if isinstance(c, list) and len(c) == 3:
        return tuple(max(0.0, min(1.0, float(x))) for x in c)
    k = part.get("kind")
    if k == "hardware" and (part.get("geometry") or {}).get("shape") == "foot":
        return COLORS["foot"]
    return COLORS.get(k, COLORS["other"])


def paint(shape, rgb):
    """Colour a part that carries no colours of its own (a KiCad STEP keeps its own)."""
    from build123d import Color
    if getattr(shape, "color", None) is None and not any(getattr(c, "color", None) is not None for c in getattr(shape, "children", []) or []):
        shape.color = Color(*rgb)
    for c in getattr(shape, "children", []) or []:
        if getattr(c, "color", None) is None and c.label != "pcb":
            c.color = Color(*rgb)


# --------------------------------------------------------------------------- drawing

SHEET_W, SHEET_H = 420.0, 297.0          # A3 landscape, mm
MARGIN = 10.0
TITLE_W, TITLE_H = 168.0, 46.0
SHEET_NO = "@@sheet@@"   # the sheet cell's placeholder, numbered once every sheet is made
SCALES = [(5, 1), (2, 1), (1, 1), (1, 1.5), (1, 2), (1, 2.5), (1, 3), (1, 4), (1, 5), (1, 10), (1, 20), (1, 50)]


def edges_2d(edges, tol=0.25):
    """Discretised 2D polylines of projected edges."""
    out = []
    for e in edges:
        try:
            gt = str(e.geom_type)
            if gt.endswith("LINE"):
                ts = [0.0, 1.0]
            else:
                n = max(6, min(96, int(e.length / max(tol, 0.05)) + 1))
                ts = [i / n for i in range(n + 1)]
            pts = [e.position_at(t) for t in ts]
            out.append([(p.X, p.Y) for p in pts])
        except Exception:  # noqa: BLE001 - one odd edge never sinks the sheet
            continue
    return out


def bounds(polys):
    xs = [x for p in polys for x, _ in p]
    ys = [y for p in polys for _, y in p]
    if not xs:
        return (0.0, 0.0, 0.0, 0.0)
    return (min(xs), min(ys), max(xs), max(ys))


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


# average advance of a character, in ems, of the sheet's sans (DejaVu Sans is wide): an estimate
# that errs long, so a line judged to fit does; text_fit squeezes the rare one that still would not
PLAIN_EM, BOLD_EM = 0.60, 0.66


def text_width(text, size, em):
    return len(text) * size * em


def fit_lines(text, width, sizes, max_lines, em):
    """Wrap `text` at spaces to `width` mm: one line at the first of `sizes` that holds it, else up to
    `max_lines` lines at a smaller one; at the smallest size the last line is cut with an ellipsis."""
    text = " ".join(text.split())
    for n, size in enumerate(sizes):
        last = n == len(sizes) - 1
        lines, line = [], ""
        for word in text.split(" "):
            candidate = word if line == "" else f"{line} {word}"
            if line != "" and text_width(candidate, size, em) > width:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
        allowed = 1 if n == 0 else max_lines   # the largest size takes one line; a smaller one may wrap
        if len(lines) <= allowed and all(text_width(l, size, em) <= width for l in lines):
            return lines, size
        if last:
            kept = lines[:max_lines]
            if len(lines) > max_lines or text_width(kept[-1], size, em) > width:
                tail = kept[-1] if len(lines) <= max_lines else " ".join([kept[-1], *lines[max_lines:]])
                while tail != "" and text_width(tail + "…", size, em) > width:
                    tail = tail[:-1]
                kept[-1] = tail.rstrip() + "…"
            return kept, size
    return [text], sizes[-1]


def text_fit(cls, x, y, text, size, width, em):
    """A text line at `size`, squeezed into `width` should the estimate have been short."""
    squeeze = f' textLength="{width:.2f}" lengthAdjust="spacingAndGlyphs"' if text_width(text, size, em) > width else ""
    return f'<text class="{cls}" x="{x:.2f}" y="{y:.2f}" style="font-size:{size:g}px"{squeeze}>{esc(text)}</text>'


def project_views(shape, bb, section=True):
    """Front, top, right (with hidden edges), an isometric view and section B-B (the device cut at
    its x centre, seen from the right), each as 2D polylines. The section also gives its cut faces
    as closed loops, for hatching."""
    c = bb.center()
    d = max(bb.size.X, bb.size.Y, bb.size.Z) * 4 + 200
    views = {
        "front": ((c.X, c.Y - d, c.Z), (0, 0, 1)),
        "top": ((c.X, c.Y, c.Z + d), (0, 1, 0)),
        "right": ((c.X + d, c.Y, c.Z), (0, 0, 1)),
        "iso": ((c.X + d / math.sqrt(3) * -1, c.Y - d / math.sqrt(3), c.Z + d / math.sqrt(3)), (0, 0, 1)),
    }
    out = {}
    for name, (origin, up) in views.items():
        t0 = time.time()
        visible, hidden = shape.project_to_viewport(origin, up, (c.X, c.Y, c.Z))
        out[name] = {"visible": edges_2d(visible), "hidden": [] if name == "iso" else edges_2d(hidden)}
        log(f"view {name}: {len(visible)} visible, {len(hidden)} hidden edge(s) in {time.time() - t0:.1f} s")
    if section:
        t0 = time.time()
        try:
            from build123d import Compound, Keep, Plane
            half = shape.split(Plane.YZ.offset(c.X), keep=Keep.BOTTOM)
            if isinstance(half, (list, tuple)):
                half = Compound(children=list(half)) if half else None
            if half is not None:
                visible, _ = half.project_to_viewport((c.X + d, c.Y, c.Z), (0, 0, 1), (c.X, c.Y, c.Z))
                cut = []
                for f in half.faces():
                    fc = f.center()
                    if abs(fc.X - c.X) > 1e-3 or abs(abs(f.normal_at(fc).X) - 1) > 1e-3:
                        continue
                    hb = f.bounding_box()
                    if hb.size.X > 1e-3:
                        continue
                    for w in [f.outer_wire(), *f.inner_wires()]:
                        n = max(8, min(160, int(w.length / 0.5)))
                        pts = [(p.Y, p.Z) for p in (w.position_at(i / n) for i in range(n + 1))]
                        if len(pts) > 2:
                            cut.append(pts)
                out["section"] = {"visible": edges_2d(visible), "hidden": [], "cut3d": cut, "bb": half.bounding_box()}
                log(f"section B-B: {len(visible)} edge(s), {len(cut)} cut loop(s) in {time.time() - t0:.1f} s")
        except Exception as e:  # noqa: BLE001 - the sheet still has its other views
            log(f"section B-B not made: {type(e).__name__}: {e}")
    return out


def fmt(v):
    return f"{v:.1f}".rstrip("0").rstrip(".") if abs(v - round(v)) < 0.05 else f"{v:.1f}"


def drawing_svg(views, bb, info, findings):
    """One A3 sheet: third-angle front/top/right, section B-B, an isometric view, overall dimensions,
    opening and mounting tables (keyed by balloons on the views), parts list, title block."""
    vb = {k: bounds(v["visible"] + v["hidden"]) for k, v in views.items()}
    size = {k: (b[2] - b[0], b[3] - b[1]) for k, b in vb.items()}
    has_sec = "section" in views and views["section"]["visible"]
    fast = [f for f in (info.get("fasteners") or []) if isinstance(f, dict) and f.get("kind") in ("lid-screw", "foot")]
    has_feet = sum(1 for f in fast if f["kind"] == "foot") >= 2
    has_lid = sum(1 for f in fast if f["kind"] == "lid-screw") >= 2
    gap = 16.0
    dim = 20.0 if has_feet else 12.0               # room for the dimension lines left of and below the views (feet pitch: a second row)
    top_room = 10.0 if has_lid else 0.0            # the lid screws' pitch above the top view
    dim_l = dim + (8.0 if has_lid else 0.0)        # and their y pitch left of it, outside the overall size
    left_w = SHEET_W - 2 * MARGIN - TITLE_W - 6    # the views stay left of the tables/title column
    area_h = SHEET_H - 2 * MARGIN - 14
    col2_w = max(size["right"][0], size["section"][0] if has_sec else 0)
    row1_h = max(size["top"][1], size["section"][1] if has_sec else 0)
    need_w = size["front"][0] + col2_w
    need_h = size["front"][1] + row1_h
    scale = SCALES[-1]
    for s in SCALES:
        k = s[0] / s[1]
        if need_w * k + gap + dim_l <= left_w and need_h * k + gap + dim + 10 + top_room <= area_h:
            scale = s
            break
    k = scale[0] / scale[1]
    block_w = need_w * k + gap + dim_l
    block_h = need_h * k + gap + dim + 10 + top_room
    fx0 = MARGIN + dim_l + max(0.0, (left_w - block_w) / 2)
    fy_base = SHEET_H - MARGIN - dim - max(0.0, (area_h - block_h) / 2)
    place = {}

    def put(name, left, bottom):
        b = vb[name]
        place[name] = (left - b[0] * k, bottom + b[1] * k)   # sheet x = ox + x*k ; sheet y = oy - y*k

    row1_bottom = fy_base - size["front"][1] * k - gap
    put("front", fx0, fy_base)
    put("top", fx0, row1_bottom)
    put("right", fx0 + size["front"][0] * k + gap, fy_base)
    if has_sec:
        put("section", fx0 + size["front"][0] * k + gap, row1_bottom)

    def path(polys, ox, oy, kk, close=False):
        parts = []
        for p in polys:
            if len(p) < 2:
                continue
            parts.append("M" + " L".join(f"{ox + x * kk:.2f} {oy - y * kk:.2f}" for x, y in p) + (" Z" if close else ""))
        return " ".join(parts)

    # a 3D point → sheet, on a view: orthographic, so the projected bounds map onto the box's extents
    axes = {"front": ("X", "Z", 1), "top": ("X", "Y", 1), "right": ("Y", "Z", 1)}

    def to_sheet(view, p):
        a, b_, _ = axes[view]
        lo = {"X": bb.min.X, "Y": bb.min.Y, "Z": bb.min.Z}
        hi = {"X": bb.max.X, "Y": bb.max.Y, "Z": bb.max.Z}
        idx = {"X": 0, "Y": 1, "Z": 2}
        b = vb[view]
        u = b[0] + (p[idx[a]] - lo[a]) / max(hi[a] - lo[a], 1e-9) * (b[2] - b[0])
        v = b[1] + (p[idx[b_]] - lo[b_]) / max(hi[b_] - lo[b_], 1e-9) * (b[3] - b[1])
        ox, oy = place[view]
        return ox + u * k, oy - v * k

    o = []
    o.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{SHEET_W:g}mm" height="{SHEET_H:g}mm" viewBox="0 0 {SHEET_W:g} {SHEET_H:g}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif">')
    o.append(f'<title>{esc(info.get("title", "Device"))}: orthographic views</title>')
    o.append('<defs><pattern id="hatch" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">'
             '<path d="M0 0 L0 1.6" stroke="#555" stroke-width=".18"/></pattern></defs>')
    o.append('<style>.v{fill:none;stroke:#111;stroke-width:.35;stroke-linecap:round;stroke-linejoin:round}'
             '.h{fill:none;stroke:#777;stroke-width:.18;stroke-dasharray:1.6 .9}'
             '.c{fill:url(#hatch);fill-rule:evenodd;stroke:#111;stroke-width:.35}'
             '.cl{fill:none;stroke:#2a4d9b;stroke-width:.25;stroke-dasharray:4 1 .8 1}'
             '.d{fill:none;stroke:#2a4d9b;stroke-width:.18}.dt{fill:#2a4d9b;font-size:3.2px}'
             '.b{fill:#fff;stroke:#2a4d9b;stroke-width:.25}.bt{fill:#2a4d9b;font-size:2.4px}'
             '.f{fill:none;stroke:#111;stroke-width:.5}.g{fill:none;stroke:#111;stroke-width:.2}.t{fill:#111;font-size:3px}.tl{fill:#555;font-size:2.2px}'
             '.tt{fill:#111;font-size:5px;font-weight:bold}.vl{fill:#111;font-size:3.2px;font-weight:bold}</style>')
    o.append(f'<rect x="0" y="0" width="{SHEET_W:g}" height="{SHEET_H:g}" fill="#fff"/>')
    o.append(f'<rect class="f" x="{MARGIN}" y="{MARGIN}" width="{SHEET_W - 2 * MARGIN:g}" height="{SHEET_H - 2 * MARGIN:g}"/>')
    for name in ("front", "top", "right"):
        ox, oy = place[name]
        o.append(f'<g data-view="{name}"><path class="h" d="{path(views[name]["hidden"], ox, oy, k)}"/>'
                 f'<path class="v" d="{path(views[name]["visible"], ox, oy, k)}"/></g>')
        bx = vb[name]
        lift = top_room if name == "top" else 0
        o.append(f'<text class="vl" x="{ox + bx[0] * k:.2f}" y="{oy - bx[3] * k - 3 - lift:.2f}">{name.upper()}</text>')
    if has_sec:
        sec = views["section"]
        ox, oy = place["section"]
        sb = sec["bb"]
        b = vb["section"]
        # the cut faces in the section's own 2D frame: (y, z) mapped onto its projected bounds
        def sec2d(pt):
            u = b[0] + (pt[0] - sb.min.Y) / max(sb.size.Y, 1e-9) * (b[2] - b[0])
            v = b[1] + (pt[1] - sb.min.Z) / max(sb.size.Z, 1e-9) * (b[3] - b[1])
            return (u, v)
        loops = [[sec2d(p) for p in loop] for loop in sec.get("cut3d") or []]
        o.append(f'<g data-view="section"><path class="c" d="{path(loops, ox, oy, k, close=True)}"/>'
                 f'<path class="v" d="{path(sec["visible"], ox, oy, k)}"/></g>')
        o.append(f'<text class="vl" x="{ox + b[0] * k:.2f}" y="{oy - b[3] * k - 3:.2f}">SECTION B–B</text>')
        # the cutting plane on the top view
        x0, y0 = to_sheet("top", (bb.center().X, bb.min.Y, 0))
        _, y1 = to_sheet("top", (bb.center().X, bb.max.Y, 0))
        o.append(f'<path class="cl" d="M{x0:.2f} {y0 + 4:.2f} L{x0:.2f} {y1 - 4:.2f}"/>')
        for yy in (y0 + 6.5, y1 - 4.5):
            o.append(f'<text class="dt" text-anchor="middle" x="{x0 + 3:.2f}" y="{yy:.2f}">B</text>')

    # ---- overall dimensions (true size, from the assembly's bounding box) ----
    def hdim(x0, x1, y, value, below=True):
        s = 1 if below else -1
        t = y + s * 8
        o.append(f'<path class="d" d="M{x0:.2f} {y + s * 1.5:.2f} L{x0:.2f} {t + s * 1.5:.2f} M{x1:.2f} {y + s * 1.5:.2f} L{x1:.2f} {t + s * 1.5:.2f} '
                 f'M{x0:.2f} {t:.2f} L{x1:.2f} {t:.2f} M{x0:.2f} {t:.2f} l1.8 -.7 l0 1.4 z M{x1:.2f} {t:.2f} l-1.8 -.7 l0 1.4 z"/>')
        o.append(f'<text class="dt" text-anchor="middle" x="{(x0 + x1) / 2:.2f}" y="{t - 1:.2f}">{value:.1f}</text>')

    def vdim(x, y0, y1, value):
        t = x - 8
        o.append(f'<path class="d" d="M{x - 1.5:.2f} {y0:.2f} L{t - 1.5:.2f} {y0:.2f} M{x - 1.5:.2f} {y1:.2f} L{t - 1.5:.2f} {y1:.2f} '
                 f'M{t:.2f} {y0:.2f} L{t:.2f} {y1:.2f} M{t:.2f} {y0:.2f} l-.7 1.8 l1.4 0 z M{t:.2f} {y1:.2f} l-.7 -1.8 l1.4 0 z"/>')
        o.append(f'<text class="dt" text-anchor="middle" transform="translate({t - 1.2:.2f} {(y0 + y1) / 2:.2f}) rotate(-90)">{value:.1f}</text>')

    fb = vb["front"]
    ox, oy = place["front"]
    hdim(ox + fb[0] * k, ox + fb[2] * k, oy - fb[1] * k, bb.size.X)
    vdim(ox + fb[0] * k, oy - fb[3] * k, oy - fb[1] * k, bb.size.Z)
    rb = vb["right"]
    ox, oy = place["right"]
    hdim(ox + rb[0] * k, ox + rb[2] * k, oy - rb[1] * k, bb.size.Y)
    tb = vb["top"]
    ox, oy = place["top"]
    ox_top, oy_top = ox, oy
    vdim(ox + tb[0] * k, oy - tb[3] * k, oy - tb[1] * k, bb.size.Y)

    # ---- openings and mounting holes: a balloon on the view that faces them, the numbers in a table ----
    def balloon(x, y, text, dx, dy):
        bx, by = x + dx, y + dy
        o.append(f'<path class="d" d="M{x:.2f} {y:.2f} L{bx:.2f} {by:.2f}"/><circle class="b" cx="{bx:.2f}" cy="{by:.2f}" r="2.1"/>'
                 f'<text class="bt" text-anchor="middle" x="{bx:.2f}" y="{by + 0.85:.2f}">{esc(text)}</text>')

    def mark(x, y):
        o.append(f'<path class="d" d="M{x - 1.4:.2f} {y:.2f} L{x + 1.4:.2f} {y:.2f} M{x:.2f} {y - 1.4:.2f} L{x:.2f} {y + 1.4:.2f}"/>')

    lo = (bb.min.X, bb.min.Y, bb.min.Z)
    openings, mounts = [], []
    for i, op in enumerate(info.get("openings") or []):
        try:
            c3 = [float(v) for v in op["center"]]
            face = str(op.get("face", ""))
            w, h = float(op["width"]), float(op["height"])
        except (KeyError, TypeError, ValueError):
            continue
        key = f"{i + 1}"
        # positions from the datum corner (the device's front-left-bottom), along the face as seen
        along = {"front": c3[0] - lo[0], "back": c3[0] - lo[0], "left": c3[1] - lo[1], "right": c3[1] - lo[1], "lid": c3[0] - lo[0]}.get(face)
        up = c3[1] - lo[1] if face == "lid" else c3[2] - lo[2]
        if along is None:
            continue
        size_txt = f"⌀{fmt(max(w, h))}" if op.get("shape") == "round" else f"{fmt(w)} × {fmt(h)}"
        openings.append((key, str(op.get("label") or key), face, f"{fmt(along)}, {fmt(up)}", size_txt))
        view = {"front": "front", "right": "right", "lid": "top"}.get(face)
        if view is not None:
            x, y = to_sheet(view, c3)
            balloon(x, y, key, 0, -(h * k / 2 + 4) if view != "top" else -5)
    for i, m in enumerate(info.get("mounts") or []):
        try:
            p3 = [float(v) for v in m["at"]]
            dia = float(m.get("d") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        key = f"M{i + 1}"
        mounts.append((key, fmt(p3[0] - lo[0]), fmt(p3[1] - lo[1]), f"⌀{fmt(dia)}" if dia > 0 else "–"))
        x, y = to_sheet("top", p3)
        mark(x, y)
        o.append(f'<text class="bt" x="{x + 1.6:.2f}" y="{y - 1.2:.2f}">{key}</text>')

    # ---- lid screws and feet: marks on the top view (feet hidden, below), pitch dimensions, a table ----
    def pitch_h(x0, yf0, x1, yf1, yl, value):
        """A horizontal dimension between two features at (x0, yf0) and (x1, yf1), its line at yl."""
        s0 = 1 if yl > yf0 else -1
        s1 = 1 if yl > yf1 else -1
        o.append(f'<path class="d" d="M{x0:.2f} {yf0 + s0 * 1.5:.2f} L{x0:.2f} {yl + s0 * 1.5:.2f} M{x1:.2f} {yf1 + s1 * 1.5:.2f} L{x1:.2f} {yl + s1 * 1.5:.2f} '
                 f'M{x0:.2f} {yl:.2f} L{x1:.2f} {yl:.2f} M{x0:.2f} {yl:.2f} l1.8 -.7 l0 1.4 z M{x1:.2f} {yl:.2f} l-1.8 -.7 l0 1.4 z"/>')
        o.append(f'<text class="dt" text-anchor="middle" x="{(x0 + x1) / 2:.2f}" y="{yl - 1:.2f}">{value:.1f}</text>')

    def pitch_v(y0, xf0, y1, xf1, xl, value):
        """A vertical dimension between two features at (xf0, y0) and (xf1, y1), its line at xl."""
        s0 = 1 if xl > xf0 else -1
        s1 = 1 if xl > xf1 else -1
        o.append(f'<path class="d" d="M{xf0 + s0 * 1.5:.2f} {y0:.2f} L{xl + s0 * 1.5:.2f} {y0:.2f} M{xf1 + s1 * 1.5:.2f} {y1:.2f} L{xl + s1 * 1.5:.2f} {y1:.2f} '
                 f'M{xl:.2f} {y0:.2f} L{xl:.2f} {y1:.2f} M{xl:.2f} {y0:.2f} l-.7 1.8 l1.4 0 z M{xl:.2f} {y1:.2f} l-.7 -1.8 l1.4 0 z"/>')
        o.append(f'<text class="dt" text-anchor="middle" transform="translate({xl - 1.2:.2f} {(y0 + y1) / 2:.2f}) rotate(-90)">{value:.1f}</text>')

    fasteners = []
    pts = {"lid-screw": [], "foot": []}
    for f in fast:
        try:
            p3 = [float(v) for v in f["at"]]
            dia = float(f.get("d") or 0)
        except (KeyError, TypeError, ValueError):
            continue
        kind = f["kind"]
        pts[kind].append(p3)
        key = f"{'L' if kind == 'lid-screw' else 'F'}{len(pts[kind])}"
        fasteners.append((key, fmt(p3[0] - lo[0]), fmt(p3[1] - lo[1]), f"⌀{fmt(dia)}" if dia > 0 else "–"))
        x, y = to_sheet("top", p3)
        if kind == "foot":
            o.append(f'<circle class="h" cx="{x:.2f}" cy="{y:.2f}" r="{max(1.2, dia * k / 2):.2f}"/>')
            o.append(f'<text class="bt" x="{x + 1.6:.2f}" y="{y + 3:.2f}">{key}</text>')   # below right: a lid screw's key sits above
        else:
            mark(x, y)
            o.append(f'<text class="bt" x="{x + 1.6:.2f}" y="{y - 1.2:.2f}">{key}</text>')
    lid, feet = pts["lid-screw"], pts["foot"]
    if has_lid and len(lid) >= 2:
        # the outermost pair along x and along y: the pattern's pitch
        a = min(lid, key=lambda p: (p[0], p[1]))
        b = max(lid, key=lambda p: (p[0], -p[1]))
        if b[0] - a[0] > 0.05:
            (x0, y0), (x1, y1) = to_sheet("top", a), to_sheet("top", b)
            pitch_h(x0, y0, x1, y1, oy_top - tb[3] * k - 9, b[0] - a[0])
        a = min(lid, key=lambda p: (p[1], -p[0]))
        b = max(lid, key=lambda p: (p[1], p[0]))
        if b[1] - a[1] > 0.05:
            (x0, y0), (x1, y1) = to_sheet("top", a), to_sheet("top", b)
            pitch_v(y0, x0, y1, x1, ox_top + tb[0] * k - 16, b[1] - a[1])
    if has_feet and len(feet) >= 2:
        a = min(feet, key=lambda p: p[0])
        b = max(feet, key=lambda p: p[0])
        if b[0] - a[0] > 0.05:
            (x0, y0), (x1, y1) = to_sheet("front", a), to_sheet("front", b)
            fb_ = vb["front"]
            ox_f, oy_f = place["front"]
            pitch_h(x0, y0, x1, y1, oy_f - fb_[1] * k + 16, b[0] - a[0])
        a = min(feet, key=lambda p: p[1])
        b = max(feet, key=lambda p: p[1])
        if b[1] - a[1] > 0.05:
            (x0, y0), (x1, y1) = to_sheet("right", a), to_sheet("right", b)
            rb_ = vb["right"]
            ox_r, oy_r = place["right"]
            pitch_h(x0, y0, x1, y1, oy_r - rb_[1] * k + 16, b[1] - a[1])

    # ---- the right column, top to bottom: isometric, tables, parts list, title block ----
    tx0 = SHEET_W - MARGIN - TITLE_W
    ty0 = SHEET_H - MARGIN - TITLE_H
    row = 4.2
    items = info.get("items") or []
    max_rows = 10

    def table(top, title, head, cols, rows):
        """A small table under `top`; returns its bottom."""
        shown = rows[:max_rows]
        h = row * (len(shown) + 2) + (row if len(rows) > len(shown) else 0)
        o.append(f'<rect class="g" x="{tx0:.2f}" y="{top:.2f}" width="{TITLE_W:g}" height="{h:.2f}"/>')
        o.append(f'<text class="tl" x="{tx0 + 2:.2f}" y="{top + 3:.2f}" style="font-weight:bold">{esc(title)}</text>')
        for c, (x, label) in enumerate(zip(cols, head)):
            o.append(f'<text class="tl" x="{tx0 + x:.2f}" y="{top + row + 3:.2f}">{esc(label)}</text>')
        for r, cells in enumerate(shown):
            y = top + row * (r + 3) - 1.2
            for c, x in enumerate(cols):
                room = (cols[c + 1] if c + 1 < len(cols) else TITLE_W) - x - 2
                text, _ = fit_lines(str(cells[c]), room, (3.0,), 1, PLAIN_EM)
                o.append(f'<text class="t" x="{tx0 + x:.2f}" y="{y:.2f}">{esc(text[0])}</text>')
        if len(rows) > len(shown):
            o.append(f'<text class="tl" x="{tx0 + 2:.2f}" y="{top + h - 1.2:.2f}">{len(rows) - len(shown)} more</text>')
        return top + h

    # parts list and title block are anchored at the bottom; the tables stack above them
    rows_items = items[:12]
    py1 = ty0
    py0 = py1 - row * (len(rows_items) + 1)
    tables_h = sum(row * (min(len(r), max_rows) + 2) + (row if len(r) > max_rows else 0) + 3 for r in (openings, mounts, fasteners) if r)
    iso_top = MARGIN + 8
    iso_box_h = max(40.0, min(110.0, py0 - tables_h - iso_top - 4))
    top = iso_top + iso_box_h + 3
    if openings:
        top = table(top, "OPENINGS (from the front-left-bottom corner)", ["#", "PORT", "FACE", "AT", "SIZE"], [2, 8, 64, 84, 128], openings) + 3
    if mounts:
        top = table(top, "MOUNTING HOLES (from the front-left corner)", ["#", "X", "Y", "HOLE"], [2, 14, 44, 74], mounts) + 3
    if fasteners:
        which = " AND ".join(n for n, on in (("LID SCREWS (L)", lid), ("FEET (F)", feet)) if on)
        top = table(top, f"{which} (from the front-left corner)", ["#", "X", "Y", "SIZE"], [2, 14, 44, 74], fasteners) + 3
    ki = min(TITLE_W / max(size["iso"][0], 1e-6), iso_box_h / max(size["iso"][1], 1e-6)) * 0.9
    iso_left = tx0 + (TITLE_W - size["iso"][0] * ki) / 2
    iso_y = iso_top + (iso_box_h - size["iso"][1] * ki) / 2
    b = vb["iso"]
    o.append(f'<g data-view="iso"><path class="v" d="{path(views["iso"]["visible"], iso_left - b[0] * ki, iso_y + b[3] * ki, ki)}"/></g>')
    o.append(f'<text class="vl" x="{tx0:.2f}" y="{MARGIN + 6:.2f}">ISOMETRIC (not to scale)</text>')
    if rows_items:
        o.append(f'<rect class="f" x="{tx0:.2f}" y="{py0:.2f}" width="{TITLE_W:g}" height="{py1 - py0:.2f}"/>')
        o.append(f'<text class="tl" x="{tx0 + 2:.2f}" y="{py0 + 3:.2f}">QTY</text><text class="tl" x="{tx0 + 14:.2f}" y="{py0 + 3:.2f}">ITEM</text>')
        for i, it in enumerate(rows_items):
            y = py0 + row * (i + 2) - 1.2
            o.append(f'<text class="t" x="{tx0 + 2:.2f}" y="{y:.2f}">{esc(it.get("qty", ""))}</text>'
                     f'<text class="t" x="{tx0 + 14:.2f}" y="{y:.2f}">{esc(str(it.get("label", ""))[:70])}</text>')
        if len(rows_items) < len(items):
            o.append(f'<text class="tl" x="{tx0 + 2:.2f}" y="{py0 - 1:.2f}">{len(items) - len(rows_items)} more item(s): see the BOM</text>')
    o.append(f'<rect class="f" x="{tx0:.2f}" y="{ty0:.2f}" width="{TITLE_W:g}" height="{TITLE_H:g}"/>')
    o.append(f'<path class="f" d="M{tx0:.2f} {ty0 + 16:.2f} H{tx0 + TITLE_W:.2f} M{tx0:.2f} {ty0 + 26:.2f} H{tx0 + TITLE_W:.2f} M{tx0:.2f} {ty0 + 36:.2f} H{tx0 + TITLE_W:.2f} '
             f'M{tx0 + 56:.2f} {ty0 + 16:.2f} V{ty0 + TITLE_H:.2f} M{tx0 + 112:.2f} {ty0 + 16:.2f} V{ty0 + TITLE_H:.2f}"/>')
    # the title fits the cell: one line at 5, else two at 4, else the second line ends in an ellipsis
    title_w = TITLE_W - 6
    title_lines, title_size = fit_lines(str(info.get("title", "Device")), title_w, (5.0, 4.0), 2, BOLD_EM)
    for i, line in enumerate(title_lines):
        o.append(text_fit("tt", tx0 + 3, ty0 + (7 if len(title_lines) == 1 else 5 + i * 4.6), line, title_size, title_w, BOLD_EM))
    if info.get("subtitle"):
        sub_lines, _ = fit_lines(str(info["subtitle"]), title_w, (3.0,), 1, PLAIN_EM)
        o.append(text_fit("t", tx0 + 3, ty0 + (12.5 if len(title_lines) == 1 else 14.2), sub_lines[0], 3.0, title_w, PLAIN_EM))

    def cell(x, y, label, value):
        o.append(f'<text class="tl" x="{x + 2:.2f}" y="{y + 3:.2f}">{esc(label)}</text><text class="t" x="{x + 2:.2f}" y="{y + 8:.2f}">{esc(str(value)[:30])}</text>')

    scale_txt = f"{fmt(scale[0])}:{fmt(scale[1])}"
    cell(tx0, ty0 + 16, "REVISION", info.get("revision", "unreleased"))
    cell(tx0 + 56, ty0 + 16, "DATE", info.get("date", ""))
    cell(tx0 + 112, ty0 + 16, "SCALE", scale_txt)
    cell(tx0, ty0 + 26, "UNITS", "mm")
    cell(tx0 + 56, ty0 + 26, "PROJECTION", "third angle")
    cell(tx0 + 112, ty0 + 26, "SHEET", info.get("sheet", "1 / 1"))
    cell(tx0, ty0 + 36, "OVERALL", f"{bb.size.X:.1f} × {bb.size.Y:.1f} × {bb.size.Z:.1f}")
    cell(tx0 + 56, ty0 + 36, "GENERATED BY", f"WireHub · {PACK} {PACK_VERSION}")
    cell(tx0 + 112, ty0 + 36, "SOURCE", info.get("source", "device layout"))
    notes = list(info.get("notes") or [])
    for i, n in enumerate(notes[:4]):
        o.append(f'<text class="tl" x="{MARGIN + 3:.2f}" y="{MARGIN + 5 + i * 3:.2f}">{esc(str(n)[:150])}</text>')
    o.append("</svg>")
    return "\n".join(o), scale_txt


# --------------------------------------------------------------------------- op

def assemble(req: dict, out_dir: str):
    from build123d import Color, Compound, Unit, export_gltf, export_step
    t_start = time.time()
    params = req.get("params") or {}
    parts = params.get("parts")
    if not isinstance(parts, list) or not parts:
        raise Invalid("params.parts lists nothing to assemble")
    title = str(params.get("title") or "device")
    findings = []
    steps = StepCache()
    placed = []          # (part, shape in the device frame, how)
    summary = []
    seen = set()
    for i, part in enumerate(parts):
        if not isinstance(part, dict) or not isinstance(part.get("path"), str):
            raise Invalid(f"part {i + 1} has no path")
        if part["path"] in seen:
            raise Invalid(f"part {part['path']} is listed twice")
        seen.add(part["path"])
        m = _matrix(part.get("matrix") or [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], part["path"])
        try:
            shape, how = part_shape(part, steps, findings)
        except Invalid:
            raise
        except Exception as e:  # noqa: BLE001 - one bad part is reported, the rest still assemble
            findings.append(("warn", f"{part['path']}: not drawn ({type(e).__name__}: {e})."))
            log(traceback.format_exc())
            summary.append({"path": part["path"], "kind": part.get("kind"), "geometry": "missing"})
            continue
        shape = located(shape, m)
        rgb = colour_of(part)
        paint(shape, rgb)
        shape.label = part["path"]
        placed.append((part, shape, how, rgb))
        entry = {"path": part["path"], "kind": part.get("kind"), "label": part.get("label"), "geometry": how}
        if part.get("provisional"):
            entry["provisional"] = part["provisional"]
        summary.append(entry)
    if not placed:
        raise Invalid("none of the parts could be drawn")

    # ---- the assembly: one node per part, grouped by sub-assembly (`group`, e.g. a nested device) ----
    groups = {}
    top = []
    for part, shape, _, _ in placed:
        g = part.get("group")
        if isinstance(g, str) and g:
            groups.setdefault(g, []).append(shape)
        else:
            top.append(shape)
    children = top + [Compound(children=v, label=k) for k, v in groups.items()]
    assembly = Compound(children=children, label=title)

    outputs = []

    def emit(path, role, media):
        outputs.append({"path": path, "role": role, "mediaType": media})

    stamp = str(params.get("date") or "2000-01-01") + "T00:00:00"
    export_step(assembly, os.path.join(out_dir, "device.step"), timestamp=stamp)
    try:
        import datetime

        import repro
        fixed = datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=datetime.timezone.utc)
        log(f"device.step: {repro.normalise_step(os.path.join(out_dir, 'device.step'), fixed)}")
    except Exception as e:  # noqa: BLE001 - the export stands as written
        log(f"device.step left as written: {e}")
    emit("device.step", "device-step", "model/step")
    # millimetres, y up, like the Library's GLBs (see enclosure.py): declared as metres so nothing scales
    export_gltf(assembly, os.path.join(out_dir, "device.glb"), unit=Unit.M, binary=True, linear_deflection=0.05, angular_deflection=0.25)
    emit("device.glb", "device-glb", "model/gltf-binary")

    bb = Compound(children=[s for _, s, _, _ in placed]).bounding_box()
    try:
        from preview import render_png
        render_png([(s, rgb) for _, s, _, rgb in placed], os.path.join(out_dir, "device-preview.png"))
        emit("device-preview.png", "preview-image", "image/png")
    except Exception as e:  # noqa: BLE001
        findings.append(("info", f"Preview image not rendered: {e}"))
        log(traceback.format_exc())

    scale = None
    sheet_count = 0
    drawing = params.get("drawing")
    if drawing is not False:
        info = drawing if isinstance(drawing, dict) else {}
        info.setdefault("title", title)
        drawn = [s for p, s, _, _ in placed if p.get("kind") != "cable"]
        skipped = sum(1 for p, _, _, _ in placed if p.get("kind") == "cable")
        notes = list(info.get("notes") or [])
        if skipped:
            notes.append(f"{skipped} cable route(s) not drawn: routes are schematic, not their real path.")
        provisional = [p["path"] for p, _, _, _ in placed if p.get("provisional") and p.get("kind") != "cable"]
        if provisional:
            notes.append(f"Approximate: {', '.join(provisional[:8])}{' …' if len(provisional) > 8 else ''} (no model; drawn from declared or outline geometry).")
        info["notes"] = notes
        # a sheet per nested sub-device: its own parts, in its own frame (`frame`: device → sub-device)
        subs = []
        for sh in info.get("sheets") or []:
            if not isinstance(sh, dict) or not isinstance(sh.get("path"), str):
                continue
            pre = sh["path"] + "/"
            try:
                fm = _matrix(sh.get("frame") or [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]], sh["path"])
            except Invalid as e:
                findings.append(("info", f"Sheet for {sh['path']} not made: {e}"))
                continue
            mine = [located(s, fm) for p, s, _, _ in placed if p["path"].startswith(pre) and p.get("kind") != "cable"]
            if mine:
                subs.append((sh, mine))
        info["sheet"] = SHEET_NO
        try:
            shape = Compound(children=drawn)
            dbb = shape.bounding_box()
            views = project_views(shape, dbb)
            svg, scale = drawing_svg(views, dbb, info, findings)
            sheets = [svg]
            for sh, mine in subs:
                try:
                    sub = {k: info[k] for k in ("revision", "date", "source") if k in info}
                    sub.update({k: v for k, v in sh.items() if k not in ("path", "frame")})
                    sub.setdefault("title", sh["path"])
                    sub["sheet"] = SHEET_NO
                    sub["notes"] = [f"Sub-device {sh['path']}, in its own frame."]
                    part = Compound(children=mine)
                    sbb = part.bounding_box()
                    sheets.append(drawing_svg(project_views(part, sbb), sbb, sub, findings)[0])
                except Exception as e:  # noqa: BLE001 - the other sheets stand
                    findings.append(("info", f"Sheet for {sh['path']} not made: {type(e).__name__}: {e}"))
                    log(traceback.format_exc())
            sheet_count = len(sheets)
            sheets = [x.replace(SHEET_NO, f"{i + 1} / {sheet_count}") for i, x in enumerate(sheets)]
            with open(os.path.join(out_dir, "device-drawing.svg"), "w") as f:
                f.write(sheets[0])
            emit("device-drawing.svg", "device-drawing", "image/svg+xml")
            try:
                from pdf import svgs_to_pdf
                with open(os.path.join(out_dir, "device-drawing.pdf"), "wb") as f:
                    f.write(svgs_to_pdf(sheets, SHEET_W, SHEET_H))
                emit("device-drawing.pdf", "device-drawing-pdf", "application/pdf")
            except Exception as e:  # noqa: BLE001 - the SVG sheet stands without it
                findings.append(("info", f"Drawing PDF not made: {type(e).__name__}: {e}"))
                log(traceback.format_exc())
        except Exception as e:  # noqa: BLE001
            findings.append(("warn", f"Drawing not made: {type(e).__name__}: {e}"))
            log(traceback.format_exc())

    counts = {}
    for s in summary:
        counts[s["geometry"]] = counts.get(s["geometry"], 0) + 1
    findings.append(("info", "Parts: " + ", ".join(f"{n} {k}" for k, n in sorted(counts.items())) + "."))
    result = {
        "units": "mm",
        "frame": "device: the enclosure frame when there is one (x/y from the interior's minimum corner, z = 0 at the outside of the floor); z up",
        "bbox": {"min": [round(bb.min.X, 3), round(bb.min.Y, 3), round(bb.min.Z, 3)], "max": [round(bb.max.X, 3), round(bb.max.Y, 3), round(bb.max.Z, 3)],
                 "size": [round(bb.size.X, 3), round(bb.size.Y, 3), round(bb.size.Z, 3)]},
        "parts": summary,
        "drawing": None if scale is None else {"sheet": "A3 landscape", "scale": scale, "projection": "third angle", "sheets": sheet_count},
    }
    log(f"took {time.time() - t_start:.2f} s")
    with open(os.path.join(out_dir, "device-result.json"), "w") as f:
        json.dump(result, f, indent=2)
    emit("device-result.json", "result", "application/json")
    return outputs, findings, result


# --------------------------------------------------------------------------- entry

def hand_over(out_dir: str) -> None:
    if os.geteuid() != 0:
        return
    st = os.stat(out_dir)
    for name in os.listdir(out_dir):
        try:
            os.chown(os.path.join(out_dir, name), st.st_uid, st.st_gid)
        except OSError:
            pass


def main(argv: list[str]) -> int:
    if len(argv) != 3 or argv[1] not in OPS:
        print(f"usage: {argv[0]} <{'|'.join(OPS)}> /work/in/request.json", file=sys.stderr)
        return 2
    op, req_path = argv[1], argv[2]
    import build123d
    tool = {"name": "build123d", "version": build123d.__version__}
    try:
        from importlib.metadata import version as dist_version
        tool["openCascade"] = dist_version("cadquery-ocp-novtk")
    except Exception:  # noqa: BLE001
        pass
    manifest = {"pack": PACK, "packVersion": PACK_VERSION, "tool": tool, "op": op, "inputs": [], "outputs": [],
                "log": "log.txt", "status": "failed", "findings": []}
    os.makedirs(OUT, exist_ok=True)
    try:
        with open(req_path) as f:
            req = json.load(f)
        if req.get("op") not in (None, op):
            raise Invalid(f"request.json says op {req.get('op')!r} but the pack was run with {op!r}")
        manifest["inputs"].append({"path": "request.json", "sha256": sha256_file(req_path)})
        for i in req.get("inputs") or []:
            path = os.path.normpath(os.path.join(IN_ROOT, i["path"]))
            if not path.startswith(IN_ROOT + os.sep) or not os.path.isfile(path):
                raise Invalid(f"input {i.get('path')!r} is missing or outside /work/in")
            actual = sha256_file(path)
            if i.get("sha256") and i["sha256"] != actual:
                raise Invalid(f"input {i['path']} has sha256 {actual}, not the {i['sha256']} the request declares")
            manifest["inputs"].append({"path": i["path"], "sha256": actual})
        log(f"{PACK} {PACK_VERSION} {op} with build123d {tool['version']}")
        outputs, findings, result = assemble(req, OUT)
        for o in outputs:
            o["sha256"] = sha256_file(os.path.join(OUT, o["path"]))
        manifest["outputs"] = outputs
        manifest["findings"] = [{"level": lv, "message": m} for lv, m in findings]
        manifest["status"] = "ok"
        log(f"{len(result['parts'])} part(s), bbox {result['bbox']['size']} mm")
    except Invalid as e:
        manifest["findings"].append({"level": "error", "message": str(e)})
        log(f"invalid request: {e}")
    except Exception as e:  # noqa: BLE001
        manifest["findings"].append({"level": "error", "message": f"Assembly failed: {type(e).__name__}: {e}"})
        log(traceback.format_exc())
    with open(os.path.join(OUT, "log.txt"), "w") as f:
        f.write("\n".join(LOG) + "\n")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    hand_over(OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
