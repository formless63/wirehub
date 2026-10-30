"""The drawing sheets as one vector PDF, a page per SVG the pack writes (`assemble.py` drawing_svg).

Only the subset that SVG uses: rect, circle, path (M L H V l Z), text (x, y, font size, anchor,
translate + rotate(-90), bold) and the class styles below. Text is set in the PDF base fonts
(Helvetica, WinAnsi): nothing embedded, nothing fetched. Cut faces are filled light grey (the
SVG's hatch pattern). Deterministic: the same SVG gives the same bytes.
"""

import re
import xml.etree.ElementTree as ET

PT = 72.0 / 25.4      # points per millimetre
NS = "{http://www.w3.org/2000/svg}"

# class → (stroke rgb | None, stroke width mm, dash mm | None, fill rgb | None)
STYLE = {
    "v": ((0.07, 0.07, 0.07), 0.35, None, None),
    "h": ((0.47, 0.47, 0.47), 0.18, (1.6, 0.9), None),
    "c": ((0.07, 0.07, 0.07), 0.35, None, (0.85, 0.85, 0.85)),
    "cl": ((0.16, 0.30, 0.61), 0.25, (4, 1, 0.8, 1), None),
    "d": ((0.16, 0.30, 0.61), 0.18, None, None),
    "b": ((0.16, 0.30, 0.61), 0.25, None, (1, 1, 1)),
    "f": ((0.07, 0.07, 0.07), 0.5, None, None),
    "g": ((0.07, 0.07, 0.07), 0.2, None, None),
}
TEXT = {  # class → (rgb, size mm, bold)
    "dt": ((0.16, 0.30, 0.61), 3.2, False), "bt": ((0.16, 0.30, 0.61), 2.4, False),
    "t": ((0.07, 0.07, 0.07), 3.0, False), "tl": ((0.33, 0.33, 0.33), 2.2, False),
    "tt": ((0.07, 0.07, 0.07), 5.0, True), "vl": ((0.07, 0.07, 0.07), 3.2, True),
}
NUM = r"-?(?:\d+\.?\d*|\.\d+)(?:[eE]-?\d+)?"


def _n(v):
    return f"{v:.3f}".rstrip("0").rstrip(".") or "0"


def _rgb(c, op):
    return f"{_n(c[0])} {_n(c[1])} {_n(c[2])} {op}"


def _path_ops(d):
    """SVG path data (M L H V l Z, absolute but for l) → PDF path operators, in mm."""
    out, x, y, sx, sy = [], 0.0, 0.0, 0.0, 0.0
    for cmd, args in re.findall(r"([MLHVlZz])([^MLHVlZz]*)", d):
        nums = [float(v) for v in re.findall(NUM, args)]
        if cmd == "M":
            x, y = nums[0], nums[1]
            sx, sy = x, y
            out.append(f"{_n(x)} {_n(y)} m")
            for i in range(2, len(nums) - 1, 2):
                x, y = nums[i], nums[i + 1]
                out.append(f"{_n(x)} {_n(y)} l")
        elif cmd == "L":
            for i in range(0, len(nums) - 1, 2):
                x, y = nums[i], nums[i + 1]
                out.append(f"{_n(x)} {_n(y)} l")
        elif cmd == "l":
            for i in range(0, len(nums) - 1, 2):
                x, y = x + nums[i], y + nums[i + 1]
                out.append(f"{_n(x)} {_n(y)} l")
        elif cmd == "H":
            for v in nums:
                x = v
                out.append(f"{_n(x)} {_n(y)} l")
        elif cmd == "V":
            for v in nums:
                y = v
                out.append(f"{_n(x)} {_n(y)} l")
        else:
            out.append("h")
            x, y = sx, sy
    return out


def _paint(cls, closed_fill=False):
    stroke, width, dash, fill = STYLE.get(cls, STYLE["v"])
    ops = [_rgb(stroke, "RG"), f"{_n(width)} w", f"[{' '.join(_n(v) for v in dash)}] 0 d" if dash else "[] 0 d"]
    if fill is not None:
        ops.append(_rgb(fill, "rg"))
    return ops, ("B*" if fill is not None else "S")


def _text_width(s, size, bold):
    # Helvetica's average advance: an estimate for anchoring only
    return len(s) * size * (0.56 if bold else 0.52)


def svg_to_pdf(svg, width_mm, height_mm):
    return svgs_to_pdf([svg], width_mm, height_mm)


def _content(svg, height_mm):
    root = ET.fromstring(svg)
    c = [f"{_n(PT)} 0 0 {_n(-PT)} 0 {_n(height_mm * PT)} cm", "1 J 1 j"]   # mm, y down like the SVG
    for el in root.iter():
        tag = el.tag.replace(NS, "")
        cls = el.get("class", "")
        if tag == "rect":
            x, y, w, h = (float(el.get(a, 0)) for a in ("x", "y", "width", "height"))
            if el.get("fill") == "#fff":
                c += ["1 1 1 rg", f"{_n(x)} {_n(y)} {_n(w)} {_n(h)} re f"]
                continue
            ops, paint = _paint(cls)
            c += ["q", *ops, f"{_n(x)} {_n(y)} {_n(w)} {_n(h)} re", paint, "Q"]
        elif tag == "circle":
            cx, cy, r = (float(el.get(a, 0)) for a in ("cx", "cy", "r"))
            k = 0.5523 * r
            ops, paint = _paint(cls)
            c += ["q", *ops, f"{_n(cx + r)} {_n(cy)} m",
                  f"{_n(cx + r)} {_n(cy + k)} {_n(cx + k)} {_n(cy + r)} {_n(cx)} {_n(cy + r)} c",
                  f"{_n(cx - k)} {_n(cy + r)} {_n(cx - r)} {_n(cy + k)} {_n(cx - r)} {_n(cy)} c",
                  f"{_n(cx - r)} {_n(cy - k)} {_n(cx - k)} {_n(cy - r)} {_n(cx)} {_n(cy - r)} c",
                  f"{_n(cx + k)} {_n(cy - r)} {_n(cx + r)} {_n(cy - k)} {_n(cx + r)} {_n(cy)} c", paint, "Q"]
        elif tag == "path" and cls in STYLE:
            d = el.get("d", "")
            if not d.strip():
                continue
            ops, paint = _paint(cls)
            c += ["q", *ops, *_path_ops(d), paint, "Q"]
        elif tag == "text":
            s = "".join(el.itertext())
            if not s:
                continue
            rgb, size, bold = TEXT.get(cls, TEXT["t"])
            m = re.search(r"font-size:\s*(" + NUM + ")", el.get("style", ""))
            if m:
                size = float(m.group(1))
            if "font-weight:bold" in el.get("style", ""):
                bold = True
            x, y = float(el.get("x", 0)), float(el.get("y", 0))
            rot = 0
            t = re.search(r"translate\((" + NUM + r")[ ,]+(" + NUM + r")\)", el.get("transform", ""))
            if t:
                x, y = float(t.group(1)), float(t.group(2))
                rot = -90 if "rotate(-90)" in el.get("transform", "") else 0
            w = _text_width(s, size, bold)
            shift = {"middle": w / 2, "end": w}.get(el.get("text-anchor", ""), 0)
            enc = s.replace("⌀", "Ø").encode("cp1252", errors="replace")
            lit = enc.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
            font = "/F2" if bold else "/F1"
            # text space: y up (undo the page flip), rotated for vertical dimensions
            mat = f"1 0 0 -1 {_n(x)} {_n(y)}" if rot == 0 else f"0 -1 -1 0 {_n(x)} {_n(y)}"
            c += ["q", f"{mat} cm", "BT", _rgb(rgb, "rg"), f"{font} {_n(size)} Tf", f"{_n(-shift)} 0 Td"]
            c.append(b"(" + lit + b") Tj")
            c += ["ET", "Q"]
    return b"\n".join(x if isinstance(x, bytes) else x.encode("latin-1") for x in c)


def svgs_to_pdf(svgs, width_mm, height_mm):
    """One page per SVG, all the same size."""
    n = len(svgs)
    # 1 catalog, 2 pages, 3-4 fonts, then a page and its content stream per sheet
    kids = " ".join(f"{5 + 2 * i} 0 R" for i in range(n))
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n} >>".encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ]
    for i, svg in enumerate(svgs):
        content = _content(svg, height_mm)
        objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {_n(width_mm * PT)} {_n(height_mm * PT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {6 + 2 * i} 0 R >>".encode())
        objs.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs):
        offsets.append(len(out))
        out += f"{i + 1} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)
