"""WireHub tool pack `enclosure`: parametric board enclosures with build123d / Open CASCADE.

    docker run --rm --network none --read-only --tmpfs /tmp \
        -v <in>:/work/in:ro -v <out>:/work/out wirehub-tool-enclosure:<v> \
        enclosure-generate /work/in/request.json

Reads request.json ({op, params, inputs}), writes the solids, an assembly, a preview and
/work/out/manifest.json (tool-pack contract v0, tools/README.md). An honest failure still exits 0
with status "failed"; a non-zero exit means the pack itself crashed.

Frames (all millimetres):
- board-local: x right, y toward the back (y up in plan), origin at the outline's bounding-box
  minimum, board underside at z = 0. The server converts KiCad's y-down frame before calling.
- enclosure: x/y from the interior's minimum corner, z = 0 at the outside of the floor.
An occurrence's placement maps board-local to enclosure: p' = R(rotation) p + t.

Approach follows common build123d case generators (rounded shell, standoffs
with pilots, wall cut-outs, lid with lip, interference checks by boolean intersection);
nothing board- or shop-specific is carried over.
"""

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
OPS = ("enclosure-generate",)

LOG: list[str] = []


def log(msg: str) -> None:
    LOG.append(msg)
    print(msg, file=sys.stderr)


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


# --------------------------------------------------------------------------- parameters

DEFAULTS = {
    "wall": 2.0,
    "floor": 2.0,
    "lidThickness": 2.0,
    "clearance": 1.0,          # board edge to inner wall face
    "topClearance": 2.0,       # tallest part to the lid's underside
    "standoffHeight": 5.0,     # floor top to board underside
    "standoffDiameter": 5.5,
    "pilotDiameter": 2.5,      # M3 self-tapping pilot
    "cornerRadius": 2.0,
    "boardGap": 4.0,           # between auto-arranged occurrences
    "defaultComponentHeight": 10.0,
    "interiorHeight": None,    # floor top to lid underside; None = derived
    "openingMargin": 0.5,      # added around each port opening on every side
    "portReach": 3.0,          # a port further than this behind the wall warns
    "lid": {"mode": "flat", "splitHeight": None, "lipHeight": 2.0, "lipThickness": 1.5,
            "fit": 0.25, "screws": True, "postSize": 6.0, "screwClearance": 3.4},
    "vents": {"lid": True, "sides": False, "slotWidth": 2.0, "slotLength": 16.0, "pitch": 4.5},
}


class Invalid(Exception):
    pass


def num(v, name, lo=None, hi=None, allow_none=False):
    if v is None and allow_none:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise Invalid(f"{name} must be a number (got {v!r})")
    if lo is not None and v < lo:
        raise Invalid(f"{name} must be at least {lo} (got {v})")
    if hi is not None and v > hi:
        raise Invalid(f"{name} must be at most {hi} (got {v})")
    return float(v)


def merged_params(raw: dict) -> dict:
    p = json.loads(json.dumps(DEFAULTS))
    for k, v in (raw or {}).items():
        if isinstance(v, dict) and isinstance(p.get(k), dict):
            p[k].update(v)
        else:
            p[k] = v
    for k in ("wall", "floor", "lidThickness"):
        p[k] = num(p[k], k, 0.8, 20)
    for k in ("clearance", "topClearance", "boardGap", "openingMargin", "portReach"):
        p[k] = num(p[k], k, 0, 100)
    p["standoffHeight"] = num(p["standoffHeight"], "standoffHeight", 0, 100)
    p["standoffDiameter"] = num(p["standoffDiameter"], "standoffDiameter", 1, 30)
    p["pilotDiameter"] = num(p["pilotDiameter"], "pilotDiameter", 0, 20)
    p["cornerRadius"] = num(p["cornerRadius"], "cornerRadius", 0, 50)
    p["defaultComponentHeight"] = num(p["defaultComponentHeight"], "defaultComponentHeight", 0, 300)
    p["interiorHeight"] = num(p["interiorHeight"], "interiorHeight", 1, 1000, allow_none=True)
    lid = p["lid"]
    if lid.get("mode") not in ("flat", "split"):
        raise Invalid("lid.mode must be 'flat' or 'split'")
    lid["splitHeight"] = num(lid.get("splitHeight"), "lid.splitHeight", 1, 1000, allow_none=True)
    for k, lo, hi in (("lipHeight", 0, 20), ("lipThickness", 0.4, 10), ("fit", 0, 2), ("postSize", 3, 30), ("screwClearance", 1, 10)):
        lid[k] = num(lid[k], f"lid.{k}", lo, hi)
    lid["screws"] = bool(lid.get("screws"))
    v = p["vents"]
    v["lid"], v["sides"] = bool(v.get("lid")), bool(v.get("sides"))
    for k, lo, hi in (("slotWidth", 0.5, 20), ("slotLength", 2, 200), ("pitch", 1, 50)):
        v[k] = num(v[k], f"vents.{k}", lo, hi)
    if v["pitch"] <= v["slotWidth"]:
        raise Invalid("vents.pitch must be larger than vents.slotWidth")
    return p


EDGES = {"front": (0.0, -1.0), "back": (0.0, 1.0), "left": (-1.0, 0.0), "right": (1.0, 0.0)}


def read_board(b: dict, i: int) -> dict:
    name = f"boards[{i}]"
    if not isinstance(b, dict) or not isinstance(b.get("id"), str) or b["id"] == "":
        raise Invalid(f"{name}.id is required")
    outline = b.get("outline")
    if not isinstance(outline, list) or len(outline) < 3:
        raise Invalid(f"{name}.outline needs at least three [x, y] points")
    pts = [(num(p[0], f"{name}.outline x"), num(p[1], f"{name}.outline y")) for p in outline]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    if max(xs) - min(xs) < 1 or max(ys) - min(ys) < 1:
        raise Invalid(f"{name}.outline is smaller than 1 mm")
    holes = []
    for j, h in enumerate(b.get("holes") or []):
        holes.append({"x": num(h["x"], f"{name}.holes[{j}].x"), "y": num(h["y"], f"{name}.holes[{j}].y"),
                      "d": num(h.get("d", 3.2), f"{name}.holes[{j}].d", 0.5, 20)})
    comps = []
    for j, c in enumerate(b.get("components") or []):
        comps.append({"ref": str(c.get("ref") or f"c{j}"),
                      "x0": num(c["x0"], "x0"), "y0": num(c["y0"], "y0"),
                      "x1": num(c["x1"], "x1"), "y1": num(c["y1"], "y1"),
                      "height": num(c.get("height"), f"{name}.components[{j}].height", 0, 300, allow_none=True),
                      "basis": c.get("basis") if c.get("basis") in ("measured", "declared", "estimated", "native") else None,
                      "side": "bottom" if c.get("side") == "bottom" else "top"})
    ports = []
    for j, q in enumerate(b.get("ports") or []):
        edge = q.get("edge")
        if edge not in EDGES:
            raise Invalid(f"{name}.ports[{j}].edge must be one of front/back/left/right")
        ports.append({"id": str(q.get("id") or f"p{j}"), "label": str(q.get("label") or q.get("id") or f"port {j + 1}"),
                      "edge": edge, "at": num(q["at"], f"{name}.ports[{j}].at"),
                      "z": num(q.get("z", 2.0), f"{name}.ports[{j}].z", -50, 200),
                      "width": num(q["width"], f"{name}.ports[{j}].width", 0.5, 300),
                      "height": num(q["height"], f"{name}.ports[{j}].height", 0.5, 300),
                      "shape": "round" if q.get("shape") == "round" else "rect",
                      "protrude": num(q.get("protrude", 0.0), f"{name}.ports[{j}].protrude", -50, 50)})

    def measure(key):
        m = b.get(key) or {}
        return {"value": num(m.get("value"), f"{name}.{key}.value", 0, 300, allow_none=True),
                "basis": m.get("basis") if m.get("basis") in ("measured", "declared", "estimated", "native") else "unknown"}

    return {"id": b["id"], "label": str(b.get("label") or b["id"]), "outline": pts,
            "thickness": num(b.get("thickness", 1.6), f"{name}.thickness", 0.2, 10),
            "holes": holes, "components": comps, "ports": ports,
            "heightAbove": measure("heightAbove"), "heightBelow": measure("heightBelow"),
            "basis": b.get("basis") if b.get("basis") in ("native", "declared", "estimated", "measured") else "unknown",
            "exported3d": b.get("exported3d") is True}


# --------------------------------------------------------------------------- geometry helpers

def rot2(x, y, deg):
    t = math.radians(deg)
    return (x * math.cos(t) - y * math.sin(t), x * math.sin(t) + y * math.cos(t))


def bbox(points):
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


class Placement:
    def __init__(self, occ_id, board, rotation, tx, ty, tz):
        self.id, self.board, self.rotation = occ_id, board, rotation
        self.tx, self.ty, self.tz = tx, ty, tz

    def xy(self, x, y):
        rx, ry = rot2(x, y, self.rotation)
        return rx + self.tx, ry + self.ty

    def matrix(self):
        t = math.radians(self.rotation)
        c, s = math.cos(t), math.sin(t)
        r = lambda v: round(v, 6)  # noqa: E731
        return [[r(c), r(-s), 0, r(self.tx)], [r(s), r(c), 0, r(self.ty)], [0, 0, 1, r(self.tz)], [0, 0, 0, 1]]


def arrange(boards, occurrences, p, findings):
    """Placements for every occurrence; unplaced ones are laid out left to right, clear of the
    corner screw posts when the lid has them."""
    by_id = {b["id"]: b for b in boards}
    post = p["lid"]["postSize"] + 0.5 if p["lid"]["screws"] and p["lid"]["mode"] == "flat" else 0.0
    out, cursor = [], p["clearance"] + post
    seen = set()
    for i, o in enumerate(occurrences):
        oid = str(o.get("id") or f"occ{i + 1}")
        if oid in seen:
            raise Invalid(f"occurrence id {oid!r} is used twice")
        seen.add(oid)
        b = by_id.get(o.get("board"))
        if b is None:
            raise Invalid(f"occurrence {oid!r} names board {o.get('board')!r}, which is not in boards")
        rot = num(o.get("rotation", 0) or 0, f"occurrence {oid} rotation", -360, 360)
        rpts = [rot2(x, y, rot) for x, y in b["outline"]]
        x0, y0, x1, y1 = bbox(rpts)
        px = num(o.get("x"), f"occurrence {oid} x", -1000, 1000, allow_none=True)
        py = num(o.get("y"), f"occurrence {oid} y", -1000, 1000, allow_none=True)
        if px is None:
            px = cursor
        if py is None:
            py = p["clearance"]
        cursor = max(cursor, px + (x1 - x0) + p["boardGap"])
        if rot % 90:
            findings.append(("warn", f"{oid}: rotation {rot:g}° is not a multiple of 90°; ports are matched to the nearest wall."))
        out.append(Placement(oid, b, rot, px - x0, py - y0, p["floor"] + p["standoffHeight"]))
    return out


def heights(b, p, findings, occ_label):
    """Tallest part above the board top and below its underside, with how well each is known."""
    above, basis_above, unknown, estimated, tallest = 0.0, b["heightAbove"]["basis"], [], [], None
    for c in b["components"]:
        if c["side"] != "top":
            continue
        if c["height"] is None:
            unknown.append(c["ref"])
        else:
            if c["basis"] == "estimated" and c["height"] > 0:
                estimated.append(c["ref"])
            if c["height"] > above:
                above, tallest = c["height"], c
    if tallest is not None:
        findings.append(("info", f"{occ_label}: tallest part {tallest['ref']}, {tallest['height']:g} mm above the board"
                                 f"{' (estimated)' if tallest['basis'] == 'estimated' else ''}."))
    if estimated:
        findings.append(("warn" if tallest is not None and tallest["basis"] == "estimated" else "info",
                         f"{occ_label}: {len(estimated)} part height(s) estimated from footprint names ({', '.join(estimated[:6])}{'…' if len(estimated) > 6 else ''}); "
                         + ("they have no 3D model in the board file: set them before relying on the clearance." if b.get("exported3d")
                          else "set them, or run the board's 3D export, before relying on the clearance.")))
    if b["heightAbove"]["value"] is not None:
        above = max(above, b["heightAbove"]["value"])
    elif not b["components"] or unknown:
        above = max(above, p["defaultComponentHeight"])
        basis_above = "assumed"
    for q in b["ports"]:
        above = max(above, q["z"] + q["height"] / 2)
    if unknown:
        stand_in = (f"modelled at the board's tallest-part height, {b['heightAbove']['value']:g} mm ({b['heightAbove']['basis']})"
                    if b["heightAbove"]["value"] is not None else f"assumed {p['defaultComponentHeight']:g} mm")
        findings.append(("warn", f"{occ_label}: {len(unknown)} component height(s) unknown ({', '.join(unknown[:6])}{'…' if len(unknown) > 6 else ''}); "
                                 f"{stand_in}. Clearance checks above the board are estimates."))
    elif basis_above == "assumed":
        findings.append(("warn", f"{occ_label}: no component heights declared; assumed {p['defaultComponentHeight']:g} mm above the board."))
    below = 0.0
    for c in b["components"]:
        if c["side"] == "bottom" and c["height"] is not None:
            below = max(below, c["height"])
    if b["heightBelow"]["value"] is not None:
        below = max(below, b["heightBelow"]["value"])
    return above, basis_above, below


# --------------------------------------------------------------------------- solids

def generate(req: dict, out_dir: str) -> tuple[list, list, dict]:
    from build123d import (Box, BuildPart, BuildSketch, Color, Compound, Cylinder, Locations, Plane, Polygon,
                           Pos, RectangleRounded, Rot, SlotOverall, Unit, export_gltf, export_step, export_stl, extrude)

    t_start = time.time()
    findings: list[tuple[str, str]] = []
    params = req.get("params") or {}
    p = merged_params(params.get("enclosure") or {})
    boards_raw = params.get("boards") or []
    if not boards_raw:
        raise Invalid("params.boards is empty: an enclosure needs at least one board")
    boards = [read_board(b, i) for i, b in enumerate(boards_raw)]
    if len({b["id"] for b in boards}) != len(boards):
        raise Invalid("board ids must be unique")
    occs = params.get("occurrences") or [{"id": b["id"], "board": b["id"]} for b in boards]
    placements = arrange(boards, occs, p, findings)

    for b in boards:
        if b["basis"] in ("estimated", "unknown"):
            findings.append(("info", f"{b['label']}: outline is {b['basis']}, not from a native source or a measurement."))

    W, FL, LT, C, R = p["wall"], p["floor"], p["lidThickness"], p["clearance"], p["cornerRadius"]
    lid = p["lid"]

    # interior footprint from every placed outline
    all_pts = [pl.xy(x, y) for pl in placements for x, y in pl.board["outline"]]
    x0, y0, x1, y1 = bbox(all_pts)
    if x0 < 0 or y0 < 0:
        findings.append(("warn", "An occurrence is placed at negative x/y; the interior was not grown to the left/front for it."))
    auto_x = any(o.get("x") is None for o in occs)
    post_room = lid["postSize"] + 0.5 if lid["screws"] and lid["mode"] == "flat" and auto_x else 0.0
    IX, IY = x1 + C + post_room, y1 + C

    # findings name an occurrence by its board, numbered when the board appears more than once
    def occ_name(pl):
        same = [q for q in placements if q.board["id"] == pl.board["id"]]
        return pl.board["label"] if len(same) < 2 else f"{pl.board['label']} #{same.index(pl) + 1}"

    # height
    need = 0.0
    occ_heights = {}
    for pl in placements:
        above, basis, below = heights(pl.board, p, findings, occ_name(pl))
        occ_heights[pl.id] = (above, basis, below)
        need = max(need, p["standoffHeight"] + pl.board["thickness"] + above + p["topClearance"])
        if below > p["standoffHeight"] - 0.5:
            findings.append(("warn", f"{occ_name(pl)}: parts under the board reach {below:g} mm; the {p['standoffHeight']:g} mm standoffs leave no room for them."))
    IH = p["interiorHeight"] if p["interiorHeight"] is not None else round(need + 0.0499, 1)
    if IH < need - 1e-6:
        findings.append(("warn", f"Interior height {IH:g} mm is less than the {need:.1f} mm the tallest occurrence needs."))
    H = FL + IH                        # top of the walls (flat lid sits here)
    TOP = H + LT                       # outside top
    r_out = min(R + W, (IX + 2 * W) / 2 - 0.1, (IY + 2 * W) / 2 - 0.1)
    r_in = max(min(R, IX / 2 - 0.1, IY / 2 - 0.1), 0.0)

    def rblock(ax0, ax1, ay0, ay1, z0, h, r):
        with BuildPart() as bp:
            with BuildSketch(Plane.XY.offset(z0)):
                with Locations(((ax0 + ax1) / 2, (ay0 + ay1) / 2)):
                    if r > 0.05:
                        RectangleRounded(ax1 - ax0, ay1 - ay0, min(r, (ax1 - ax0) / 2 - 0.01, (ay1 - ay0) / 2 - 0.01))
                    else:
                        from build123d import Rectangle
                        Rectangle(ax1 - ax0, ay1 - ay0)
            extrude(amount=h)
        return bp.part

    def box(ax0, ax1, ay0, ay1, z0, z1):
        return Pos((ax0 + ax1) / 2, (ay0 + ay1) / 2, (z0 + z1) / 2) * Box(abs(ax1 - ax0), abs(ay1 - ay0), abs(z1 - z0))

    def slot(length, width, depth, along_y):
        with BuildPart() as s:
            with BuildSketch(Plane.XY.offset(-depth / 2)):
                SlotOverall(length, width, rotation=90 if along_y else 0)
            extrude(amount=depth)
        return s.part

    split = lid["mode"] == "split"
    shell_top = TOP if split else H
    base = rblock(-W, IX + W, -W, IY + W, 0, shell_top, r_out)
    base -= rblock(0, IX, 0, IY, FL, IH if not split else IH, r_in)

    # ---- standoffs (or corner rests when a board has no holes) ----
    supports = []      # dicts in the enclosure frame: occurrence, kind, x, y, z (support top), …
    for pl in placements:
        b = pl.board
        zb = pl.tz
        if b["holes"]:
            for h in b["holes"]:
                x, y = pl.xy(h["x"], h["y"])
                supports.append({"occurrence": pl.id, "kind": "board-hole", "x": round(x, 3), "y": round(y, 3), "z": round(zb, 3),
                                 "holeDiameter": h["d"], "standoffDiameter": p["standoffDiameter"],
                                 "pilotDiameter": p["pilotDiameter"] if p["pilotDiameter"] > 0 else None})
                base += Pos(x, y, (FL - 0.01 + zb) / 2) * Cylinder(p["standoffDiameter"] / 2, zb - FL + 0.01)
                if p["pilotDiameter"] > 0:
                    depth = max(min(p["standoffHeight"] - 0.5, 8.0), 0.5)
                    base -= Pos(x, y, zb - depth / 2 + 0.005) * Cylinder(p["pilotDiameter"] / 2, depth + 0.01)
                if h["d"] + 0.4 < p["pilotDiameter"]:
                    findings.append(("warn", f"{occ_name(pl)}: hole at ({h['x']:g}, {h['y']:g}) is {h['d']:g} mm, smaller than the {p['pilotDiameter']:g} mm pilot."))
        else:
            bx0, by0, bx1, by1 = bbox(b["outline"])
            findings.append(("warn", f"{occ_name(pl)} has no mounting holes; it rests on four corner pads and needs another way to be held."))
            for cx, cy in ((bx0 + 2.5, by0 + 2.5), (bx1 - 2.5, by0 + 2.5), (bx0 + 2.5, by1 - 2.5), (bx1 - 2.5, by1 - 2.5)):
                x, y = pl.xy(cx, cy)
                supports.append({"occurrence": pl.id, "kind": "corner-pad", "x": round(x, 3), "y": round(y, 3), "z": round(zb, 3), "size": 4.0})
                base += box(x - 2, x + 2, y - 2, y + 2, FL - 0.01, zb)

    # ---- lid screw posts ----
    posts = []
    lid_posts = []     # screw axis of each lid post, enclosure frame; screwZ = the lid's outside
    if lid["screws"] and not split:
        s = lid["postSize"]
        for (ax, ay) in ((0, 0), (IX - s, 0), (0, IY - s), (IX - s, IY - s)):
            posts.append((ax, ax + s, ay, ay + s))
            lid_posts.append({"x": round(ax + s / 2, 3), "y": round(ay + s / 2, 3), "size": s, "z0": FL, "z1": round(H, 3),
                              "pilotDiameter": p["pilotDiameter"], "pilotDepth": 8.0, "screwZ": round(H + LT, 3)})
            base += box(ax, ax + s, ay, ay + s, FL - 0.01, H)
            base -= Pos(ax + s / 2, ay + s / 2, H - 4.0) * Cylinder(p["pilotDiameter"] / 2, 8.02)
        for pl in placements:
            bx = [pl.xy(x, y) for x, y in pl.board["outline"]]
            ox0, oy0, ox1, oy1 = bbox(bx)
            for (ax0, ax1, ay0, ay1) in posts:
                if ax0 < ox1 and ox0 < ax1 and ay0 < oy1 and oy0 < ay1:
                    findings.append(("warn", f"{occ_name(pl)}: a lid screw post overlaps the board's footprint; increase clearance or turn lid screws off."))
                    break
    elif split and lid["screws"]:
        findings.append(("info", "Split lid: no screw posts in this pack version; the halves locate on the lip."))

    # ---- port openings ----
    openings = []
    walls = {"front": (0.0, -1.0), "back": (0.0, 1.0), "left": (-1.0, 0.0), "right": (1.0, 0.0)}
    for pl in placements:
        b = pl.board
        bx0, by0, bx1, by1 = bbox(b["outline"])
        top_z = pl.tz + b["thickness"]
        for q in b["ports"]:
            nx, ny = EDGES[q["edge"]]
            if q["edge"] == "front":
                lx, ly = q["at"], by0 - q["protrude"]
            elif q["edge"] == "back":
                lx, ly = q["at"], by1 + q["protrude"]
            elif q["edge"] == "left":
                lx, ly = bx0 - q["protrude"], q["at"]
            else:
                lx, ly = bx1 + q["protrude"], q["at"]
            ex, ey = pl.xy(lx, ly)
            rnx, rny = rot2(nx, ny, pl.rotation)
            face, dot = max(((f, rnx * v[0] + rny * v[1]) for f, v in walls.items()), key=lambda t: t[1])
            label = f"{pl.id}:{q['id']}"
            if dot < 0.7:
                findings.append(("warn", f"Port {label} ({q['label']}) does not face a wall; no opening cut."))
                continue
            gap = {"front": ey - 0, "back": IY - ey, "left": ex - 0, "right": IX - ex}[face]
            if gap > p["portReach"]:
                findings.append(("warn", f"Port {label} ({q['label']}) sits {gap:.1f} mm behind the {face} wall; a plug may not seat. Move the board or reduce clearance."))
            m = p["openingMargin"]
            w, h = q["width"] + 2 * m, q["height"] + 2 * m
            zc = top_z + q["z"]
            if face in ("front", "back"):
                cy = -W / 2 if face == "front" else IY + W / 2
                cx = ex
                if q["shape"] == "round":
                    cutter = Pos(cx, cy, zc) * Rot(90, 0, 0) * Cylinder(max(w, h) / 2, W + 2)
                else:
                    cutter = Pos(cx, cy, zc) * Box(w, W + 2, h)
                u = cx
            else:
                cx = -W / 2 if face == "left" else IX + W / 2
                cy = ey
                if q["shape"] == "round":
                    cutter = Pos(cx, cy, zc) * Rot(0, 90, 0) * Cylinder(max(w, h) / 2, W + 2)
                else:
                    cutter = Pos(cx, cy, zc) * Box(W + 2, w, h)
                u = cy
            if zc + h / 2 > (H if not split else TOP):
                findings.append(("warn", f"Port {label} opening reaches above the walls; it was cut as a notch."))
            if zc - h / 2 < FL:
                findings.append(("warn", f"Port {label} opening reaches into the floor."))
            base -= cutter
            openings.append({"id": label, "occurrence": pl.id, "port": q["id"], "label": q["label"], "face": face,
                             "u": round(u, 3), "z": round(zc, 3), "width": round(w, 3), "height": round(h, 3),
                             "shape": q["shape"], "gapToWall": round(gap, 3)})

    # manual openings (enclosure frame)
    for j, o in enumerate(params.get("openings") or []):
        face = o.get("face")
        if face not in ("front", "back", "left", "right", "lid"):
            raise Invalid(f"openings[{j}].face must be front/back/left/right/lid")
        u = num(o.get("u"), f"openings[{j}].u")
        v = num(o.get("v"), f"openings[{j}].v")
        w = num(o.get("width"), f"openings[{j}].width", 0.5, 500)
        h = num(o.get("height"), f"openings[{j}].height", 0.5, 500)
        rnd = o.get("shape") == "round"
        openings.append({"id": str(o.get("id") or f"opening-{j + 1}"), "label": str(o.get("label") or f"opening {j + 1}"),
                         "face": face, "u": u, "z": v, "width": w, "height": h, "shape": "round" if rnd else "rect", "manual": True})

    # ---- lid ----
    fit, lip_h, lip_t = lid["fit"], lid["lipHeight"], lid["lipThickness"]
    if split:
        zs = lid["splitHeight"] if lid["splitHeight"] is not None else round(FL + IH * 0.6, 1)
        if not (FL + 1 < zs < TOP - 1):
            raise Invalid(f"lid.splitHeight {zs:g} must lie between the floor and the top ({FL + 1:g}–{TOP - 1:g} mm)")
        shell = base + rblock(-W, IX + W, -W, IY + W, H, LT, r_out)  # closed box: base walls already reach TOP
        whole = shell
        below = box(-W - 5, IX + W + 5, -W - 5, IY + W + 5, -1, zs)
        above = box(-W - 5, IX + W + 5, -W - 5, IY + W + 5, zs, TOP + 5)
        base_p = whole & below
        lid_p = whole & above
        if lip_h > 0:
            ring = rblock(0, IX, 0, IY, zs - 0.01, lip_h + 0.01, r_in) - rblock(lip_t, IX - lip_t, lip_t, IY - lip_t, zs - 1, lip_h + 2, max(r_in - lip_t, 0))
            base_p += ring
            lid_p -= rblock(-fit, IX + fit, -fit, IY + fit, zs - 0.01, lip_h + fit + 0.01, r_in + fit)
    else:
        base_p = base
        lid_p = rblock(-W, IX + W, -W, IY + W, H, LT, r_out)
        if lip_h > 0:
            lx0, lx1, ly0, ly1 = fit, IX - fit, fit, IY - fit
            ring = rblock(lx0, lx1, ly0, ly1, H - lip_h, lip_h + 0.01, max(r_in - fit, 0)) - \
                rblock(lx0 + lip_t, lx1 - lip_t, ly0 + lip_t, ly1 - lip_t, H - lip_h - 1, lip_h + 2, max(r_in - fit - lip_t, 0))
            for (ax0, ax1, ay0, ay1) in posts:
                ring -= box(ax0 - 0.4, ax1 + 0.4, ay0 - 0.4, ay1 + 0.4, H - lip_h - 1, H)
            lid_p += ring
        for (ax0, ax1, ay0, ay1) in posts:
            cx, cy = (ax0 + ax1) / 2, (ay0 + ay1) / 2
            lid_p -= Pos(cx, cy, H + LT / 2) * Cylinder(lid["screwClearance"] / 2, LT * 3)
    lid_top = TOP

    # vents
    vents = p["vents"]
    if vents["lid"]:
        margin = max(lid["postSize"] + 2 if posts else 4.0, 4.0)
        span_x = IX - 2 * margin
        length = min(vents["slotLength"], IY - 2 * margin)
        n = int(span_x // vents["pitch"]) + 1 if span_x > 0 else 0
        if length >= vents["slotWidth"] + 1 and n > 0:
            x_start = IX / 2 - (n - 1) * vents["pitch"] / 2
            for i in range(n):
                lid_p -= Pos(x_start + i * vents["pitch"], IY / 2, lid_top - LT / 2) * slot(length, vents["slotWidth"], LT * 3, True)
        else:
            findings.append(("info", "Lid vents skipped: the interior is too small for one slot."))
    if vents["sides"]:
        zc = FL + min(4.0, IH / 3)
        hgt = min(6.0, IH / 3)
        n = int((IY - 8) // vents["pitch"]) + 1 if IY > 12 else 0
        for i in range(n):
            y = IY / 2 - (n - 1) * vents["pitch"] / 2 + i * vents["pitch"]
            for xc in (-W / 2, IX + W / 2):
                base_p -= Pos(xc, y, zc) * Box(W + 2, vents["slotWidth"], hgt)

    # manual openings cut last (they may go through the lid)
    for o in openings:
        if not o.get("manual"):
            continue
        face, u, v, w, h = o["face"], o["u"], o["z"], o["width"], o["height"]
        rnd = o["shape"] == "round"
        if face == "lid":
            cutter = Pos(u, v, lid_top - LT / 2) * (Cylinder(max(w, h) / 2, LT * 3) if rnd else Box(w, h, LT * 3))
            lid_p -= cutter
            continue
        if face in ("front", "back"):
            cy = -W / 2 if face == "front" else IY + W / 2
            cutter = Pos(u, cy, v) * (Rot(90, 0, 0) * Cylinder(max(w, h) / 2, W + 2) if rnd else Box(w, W + 2, h))
        else:
            cx = -W / 2 if face == "left" else IX + W / 2
            cutter = Pos(cx, u, v) * (Rot(0, 90, 0) * Cylinder(max(w, h) / 2, W + 2) if rnd else Box(W + 2, w, h))
        base_p -= cutter
        if split:
            lid_p -= cutter

    # ---- board dummies (real outline, declared parts) for checks and the preview ----
    board_solids = []      # (occ id, kind, solid)
    for pl in placements:
        b = pl.board
        pts = [pl.xy(x, y) for x, y in b["outline"]]
        with BuildPart() as bp:
            with BuildSketch(Plane.XY.offset(pl.tz)):
                Polygon(*pts, align=None)
            extrude(amount=b["thickness"])
        slab = bp.part
        for h in b["holes"]:
            x, y = pl.xy(h["x"], h["y"])
            slab -= Pos(x, y, pl.tz + b["thickness"] / 2) * Cylinder(h["d"] / 2, b["thickness"] * 3)
        slab.color = Color(0.05, 0.36, 0.17)
        slab.label = f"{pl.id}"
        board_solids.append((pl.id, "board", slab))
        above = occ_heights[pl.id][0]
        for c in b["components"]:
            hgt = c["height"]
            est = hgt is None or c["basis"] == "estimated"
            if hgt is None:
                hgt = above if b["heightAbove"]["value"] is not None else p["defaultComponentHeight"]
            if hgt <= 0:
                continue
            cpts = [pl.xy(c["x0"], c["y0"]), pl.xy(c["x1"], c["y1"])]
            cx0, cy0, cx1, cy1 = bbox(cpts)
            if c["side"] == "top":
                z0, z1 = pl.tz + b["thickness"], pl.tz + b["thickness"] + hgt
            else:
                z0, z1 = pl.tz - hgt, pl.tz
            solid = box(cx0, cx1, cy0, cy1, z0, z1)
            solid.color = Color(0.55, 0.45, 0.2) if est else Color(0.12, 0.12, 0.13)
            solid.label = f"{pl.id}:{c['ref']}"
            board_solids.append((pl.id, "estimated" if est else "component", solid))

    def overlap(a, b_):
        try:
            i = a & b_
            return sum(s.volume for s in i.solids()) if i else 0.0
        except Exception:  # noqa: BLE001 - a failed boolean is a finding, not a crash
            return -1.0

    hits = []
    for oid, kind, solid in board_solids:
        for part_name, part in (("enclosure base", base_p), ("lid", lid_p)):
            v = overlap(part, solid)
            if v > 0.1:
                what = solid.label
                hits.append(("warn", f"Collision: {part_name} overlaps {what} ({kind}) by {v:.1f} mm³" +
                             (" — that part's height is estimated" if kind == "estimated" else "") + "."))
            elif v < 0:
                hits.append(("info", f"Could not check {part_name} against {solid.label}."))
    for i in range(len(placements)):
        for j in range(i + 1, len(placements)):
            a = next(s for o, k, s in board_solids if o == placements[i].id and k == "board")
            c = next(s for o, k, s in board_solids if o == placements[j].id and k == "board")
            if overlap(a, c) > 0.1:
                hits.append(("warn", f"Collision: occurrences {placements[i].id} and {placements[j].id} overlap."))
    v = overlap(base_p, lid_p)
    if v > 0.1:
        hits.append(("warn", f"Collision: lid overlaps base by {v:.1f} mm³."))
    findings.extend(hits)
    if not any(m.startswith("Collision") for _, m in hits):
        findings.append(("info", "Fit check: no overlaps between the enclosure, lid and the declared board geometry."))

    # ---- exports ----
    grey = Color(0.42, 0.45, 0.5)
    base_p.color, lid_p.color = grey, Color(0.55, 0.58, 0.63)
    base_p.label, lid_p.label = "enclosure-base", "enclosure-lid"
    outputs = []

    def emit(path, role, media):
        outputs.append({"path": path, "role": role, "mediaType": media})

    import repro
    stamp = repro.stamp_of(params)

    def step(shape, name):
        """STEP with a fixed stamp, its entities renumbered canonically (repro.py): same inputs, same bytes."""
        path = os.path.join(out_dir, name)
        export_step(shape, path, timestamp=stamp.strftime("%Y-%m-%dT%H:%M:%S"))
        try:
            log(f"{name}: {repro.normalise_step(path, stamp)}")
        except Exception as e:  # noqa: BLE001 - the export stands as written
            log(f"{name} left as written: {e}")

    step(base_p, "enclosure-base.step")
    emit("enclosure-base.step", "base-step", "model/step")
    step(lid_p, "enclosure-lid.step")
    emit("enclosure-lid.step", "lid-step", "model/step")
    export_stl(base_p, os.path.join(out_dir, "enclosure-base.stl"))
    emit("enclosure-base.stl", "base-stl", "model/stl")
    # lid flipped plate-down for printing
    flipped = Rot(180, 0, 0) * lid_p
    export_stl(flipped, os.path.join(out_dir, "enclosure-lid.stl"))
    emit("enclosure-lid.stl", "lid-stl", "model/stl")

    boards_compound = [s for _, _, s in board_solids]
    step(Compound(children=[base_p, lid_p] + boards_compound, label="enclosure-assembly"), "assembly.step")
    emit("assembly.step", "assembly-step", "model/step")
    lift = max(IH * 0.8, 15.0)
    lid_open = Pos(0, 0, lift) * lid_p
    lid_open.color, lid_open.label = lid_p.color, lid_p.label
    # WireHub's Library GLBs are millimetres, y-up (apps/studio/server/models/glb.ts): declaring the
    # shapes as metres keeps build123d from scaling them by 1/1000; deflection is then in mm.
    export_gltf(Compound(children=[base_p, lid_open] + boards_compound), os.path.join(out_dir, "assembly.glb"), unit=Unit.M,
                binary=True, linear_deflection=0.05, angular_deflection=0.25)
    emit("assembly.glb", "preview-model", "model/gltf-binary")

    try:
        from preview import render_png
        render_png([(base_p, (0.62, 0.65, 0.70)), (lid_open, (0.74, 0.77, 0.81))] +
                   [(s, (0.08, 0.45, 0.22) if k == "board" else (0.75, 0.6, 0.25) if k == "estimated" else (0.18, 0.18, 0.2))
                    for _, k, s in board_solids], os.path.join(out_dir, "preview.png"))
        emit("preview.png", "preview-image", "image/png")
    except Exception as e:  # noqa: BLE001
        findings.append(("info", f"Preview image not rendered: {e}"))
        log(traceback.format_exc())

    result = {
        "units": "mm",
        "frame": "enclosure: x/y from the interior's minimum corner, z = 0 at the outside of the floor; board-local frames are y-up with the underside at z = 0",
        "outer": {"x": round(IX + 2 * W, 3), "y": round(IY + 2 * W, 3), "z": round(TOP, 3)},
        "interior": {"x": round(IX, 3), "y": round(IY, 3), "z": round(IH, 3), "floorTop": FL},
        "lid": {"mode": lid["mode"], "splitHeight": (zs if split else None), "explodedLift": lift},
        "placements": [{"occurrence": pl.id, "board": pl.board["id"], "rotation": pl.rotation,
                        "offset": [round(pl.tx, 3), round(pl.ty, 3), round(pl.tz, 3)], "matrix": pl.matrix(),
                        "heightAbove": {"value": round(occ_heights[pl.id][0], 3), "basis": occ_heights[pl.id][1]}}
                       for pl in placements],
        "supports": supports,
        "lidPosts": lid_posts,
        "openings": openings,
        "volumes": {"base": round(base_p.volume, 1), "lid": round(lid_p.volume, 1)},
        "params": p,
    }
    log(f"took {time.time() - t_start:.2f} s")
    with open(os.path.join(out_dir, "result.json"), "w") as f:
        json.dump(result, f, indent=2)
    emit("result.json", "result", "application/json")
    return outputs, findings, result


# --------------------------------------------------------------------------- entry

def hand_over(out_dir: str) -> None:
    """Running as root (no --user): give the outputs to whoever owns the output directory."""
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
        import OCP  # noqa: F401
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
        outputs, findings, result = generate(req, OUT)
        for o in outputs:
            o["sha256"] = sha256_file(os.path.join(OUT, o["path"]))
        manifest["outputs"] = outputs
        manifest["findings"] = [{"level": lv, "message": m} for lv, m in findings]
        manifest["status"] = "ok"
        log(f"outer {result['outer']} mm, {len(result['placements'])} occurrence(s), {len(result['openings'])} opening(s)")
    except Invalid as e:
        manifest["findings"].append({"level": "error", "message": str(e)})
        log(f"invalid request: {e}")
    except Exception as e:  # noqa: BLE001 - geometry failures are reported, not crashed on
        manifest["findings"].append({"level": "error", "message": f"Generation failed: {type(e).__name__}: {e}"})
        log(traceback.format_exc())
    with open(os.path.join(OUT, "log.txt"), "w") as f:
        f.write("\n".join(LOG) + "\n")
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    hand_over(OUT)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
