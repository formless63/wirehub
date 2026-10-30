"""A static isometric preview PNG of tessellated solids: flat Lambert shading and a z-buffer.

No GL, no display: tessellate with OCC, project, rasterise each triangle with numpy at 2x into a
depth buffer, then downsample with Pillow. Good enough for a cover/thumbnail, not a renderer.
"""

import math

import numpy as np
from PIL import Image

SIZE = (960, 720)
SCALE = 2
BACKGROUND = (246, 247, 249)


def render_png(parts, path, tolerance=0.15):
    az, el = math.radians(-40), math.radians(32)   # from the front-left, above
    ca, sa, ce, se = math.cos(az), math.sin(az), math.cos(el), math.sin(el)
    light = np.array([-0.35, -0.55, 0.76])
    light /= np.linalg.norm(light)

    tris, cols = [], []
    for shape, rgb in parts:
        verts, faces = shape.tessellate(tolerance)
        if not faces:
            continue
        pts = np.array([(v.X, v.Y, v.Z) for v in verts], dtype=float)
        f = np.array(faces, dtype=int)
        a, b, c = pts[f[:, 0]], pts[f[:, 1]], pts[f[:, 2]]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n, axis=1)
        keep = ln > 1e-12
        shade = 0.42 + 0.58 * np.abs((n[keep] / ln[keep, None]) @ light)
        x1 = pts[:, 0] * ca - pts[:, 1] * sa
        y1 = pts[:, 0] * sa + pts[:, 1] * ca
        scr = np.stack([x1, y1 * se + pts[:, 2] * ce, y1 * ce - pts[:, 2] * se], axis=1)
        tris.append(scr[f[keep]])
        cols.append(np.clip(np.outer(shade, rgb) * 255, 0, 255))
    if not tris:
        raise ValueError("nothing to draw")
    T = np.concatenate(tris)          # (n, 3 vertices, [sx, sy, depth])
    C = np.concatenate(cols)

    w, h = SIZE[0] * SCALE, SIZE[1] * SCALE
    xs, ys = T[:, :, 0], T[:, :, 1]
    span = max(xs.max() - xs.min(), (ys.max() - ys.min()) * w / h, 1e-6)
    k = 0.86 * w / span
    cx, cy = (xs.max() + xs.min()) / 2, (ys.max() + ys.min()) / 2
    P = np.empty_like(T)
    P[:, :, 0] = w / 2 + (xs - cx) * k
    P[:, :, 1] = h / 2 - (ys - cy) * k
    P[:, :, 2] = T[:, :, 2]

    zbuf = np.full((h, w), np.inf)
    img = np.empty((h, w, 3))
    img[:] = BACKGROUND
    for (p0, p1, p2), col in zip(P, C):
        x0, x1_ = int(max(min(p0[0], p1[0], p2[0]), 0)), int(min(max(p0[0], p1[0], p2[0]) + 1, w))
        y0, y1_ = int(max(min(p0[1], p1[1], p2[1]), 0)), int(min(max(p0[1], p1[1], p2[1]) + 1, h))
        if x0 >= x1_ or y0 >= y1_:
            continue
        den = (p1[1] - p2[1]) * (p0[0] - p2[0]) + (p2[0] - p1[0]) * (p0[1] - p2[1])
        if abs(den) < 1e-9:
            continue
        gx, gy = np.meshgrid(np.arange(x0, x1_) + 0.5, np.arange(y0, y1_) + 0.5)
        l0 = ((p1[1] - p2[1]) * (gx - p2[0]) + (p2[0] - p1[0]) * (gy - p2[1])) / den
        l1 = ((p2[1] - p0[1]) * (gx - p2[0]) + (p0[0] - p2[0]) * (gy - p2[1])) / den
        l2 = 1 - l0 - l1
        inside = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
        if not inside.any():
            continue
        z = l0 * p0[2] + l1 * p1[2] + l2 * p2[2]
        zb = zbuf[y0:y1_, x0:x1_]
        win = inside & (z < zb)
        zb[win] = z[win]
        img[y0:y1_, x0:x1_][win] = col
    Image.fromarray(img.astype(np.uint8)).resize(SIZE, Image.LANCZOS).save(path, "PNG", optimize=True)
