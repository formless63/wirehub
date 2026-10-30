"""Make a pack's outputs byte-reproducible: the same inputs in the same image give the same bytes.

Shared by the `kicad` and `enclosure` packs (one copy in each build context; keep them identical,
`cmp tools/kicad/repro.py tools/enclosure/repro.py`). Pure standard library.

- Creation stamps (STEP FILE_NAME, Gerber/drill/job-file dates, SVG titles, GLB `generated_at`)
  are replaced by one fixed stamp: `SOURCE_DATE_EPOCH` when the environment or the request gives
  one, else 2000-01-01T00:00:00 (the date `device-assemble` already wrote).
- STEP entity order: Open CASCADE writes the presentation (colour) section in hash-map order, so
  entity numbers and the order of set-like lists move between identical runs. `normalise_step`
  renumbers the DATA section canonically (a pre-order walk from the roots, roots and set-like
  lists ordered by a structural hash of what they point to). The model is the same; only the
  entity numbers and record layout (one record per line) change.
"""

import datetime
import hashlib
import os
import re
import struct

DEFAULT_EPOCH = 946684800  # 2000-01-01T00:00:00Z


def stamp_of(params=None):
    """The fixed creation time as a UTC datetime (request `sourceDateEpoch`, env, or the default)."""
    raw = (params or {}).get("sourceDateEpoch")
    if raw is None:
        raw = os.environ.get("SOURCE_DATE_EPOCH")
    try:
        epoch = int(raw) if raw not in (None, "") else DEFAULT_EPOCH
    except (TypeError, ValueError):
        epoch = DEFAULT_EPOCH
    return datetime.datetime.fromtimestamp(epoch, tz=datetime.timezone.utc)


# ------------------------------------------------------------------ text stamps (Gerber, drill, SVG)

# a date-time as KiCad writes it: 2026-10-22T11:33:45+00:00, 2026-10-22 11:33:45, 2026-10-22T11:33:45
_DATE = re.compile(r"(\d{4}-\d{2}-\d{2})([T ])(\d{2}:\d{2}:\d{2})([+-]\d{2}:?\d{2}|Z)?")
# only lines that say they carry a creation time are touched
_STAMP_LINE = re.compile(r"CreationDate|Created by|DRILL file|SVG Image created|<date>|generated_at", re.I)


def _fixed_date(stamp):
    day, clock = stamp.strftime("%Y-%m-%d"), stamp.strftime("%H:%M:%S")

    def sub(m):
        zone = m.group(4)
        if zone is None:
            zone = ""
        elif zone != "Z":
            zone = "+00:00" if ":" in zone else "+0000"
        return f"{day}{m.group(2)}{clock}{zone}"
    return sub


def normalise_text_dates(path, stamp):
    """Rewrite the creation stamps in a text output in place. Returns the number of lines changed."""
    with open(path, "rb") as f:
        data = f.read()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return 0
    sub = _fixed_date(stamp)
    changed = 0
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if _STAMP_LINE.search(line):
            new = _DATE.sub(sub, line)
            if new != line:
                lines[i] = new
                changed += 1
    if changed:
        with open(path, "wb") as f:
            f.write("\n".join(lines).encode("utf-8"))
    return changed


# ------------------------------------------------------------------ GLB


def normalise_glb(path, stamp):
    """Fix `generated_at` (and any other creation stamp) in a GLB's JSON chunk, keeping its length."""
    with open(path, "rb") as f:
        data = bytearray(f.read())
    if len(data) < 20 or data[:4] != b"glTF":
        return False
    length, ctype = struct.unpack_from("<I4s", data, 12)
    if ctype != b"JSON":
        return False
    chunk = bytes(data[20:20 + length]).decode("utf-8")
    sub = _fixed_date(stamp)
    new = re.sub(r'("(?:generated_at|createdAt|creationDate|date)"\s*:\s*")([^"]*)(")',
                 lambda m: m.group(1) + _DATE.sub(sub, m.group(2)) + m.group(3), chunk)
    if new == chunk or len(new.encode("utf-8")) != length:
        return False
    data[20:20 + length] = new.encode("utf-8")
    with open(path, "wb") as f:
        f.write(bytes(data))
    return True


# ------------------------------------------------------------------ STEP (ISO 10303-21)

# entity types whose list argument is a set: its order carries no meaning, so it is sorted
SET_LISTS = (
    "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION",
    "DRAUGHTING_MODEL",
    "PRESENTATION_LAYER_ASSIGNMENT",
)
_REF_LIST = re.compile(r"\((#\d+(?:,#\d+)*)\)")


def _split_records(text):
    """Split at `;` outside quoted strings. Returns the pieces (each without its `;`)."""
    out, start, i, n, quoted = [], 0, 0, len(text), False
    while i < n:
        c = text[i]
        if c == "'":
            quoted = not quoted  # '' inside a string toggles twice: still inside
        elif c == ";" and not quoted:
            out.append(text[start:i])
            start = i + 1
        i += 1
    out.append(text[start:])
    return out


def _compact(body):
    """One line, whitespace outside strings dropped (Part 21 tokens need no separators)."""
    out, quoted = [], False
    for c in body:
        if c == "'":
            quoted = not quoted
        if not quoted and c in " \t\r\n":
            continue
        out.append(c)
    return "".join(out)


def _segments(body):
    """The body as text pieces and integer references, references only outside strings."""
    segs, buf, quoted, i, n = [], [], False, 0, len(body)
    while i < n:
        c = body[i]
        if c == "'":
            quoted = not quoted
            buf.append(c)
            i += 1
            continue
        if c == "#" and not quoted:
            j = i + 1
            while j < n and body[j].isdigit():
                j += 1
            if j > i + 1:
                segs.append("".join(buf))
                buf = []
                segs.append(int(body[i + 1:j]))
                i = j
                continue
        buf.append(c)
        i += 1
    segs.append("".join(buf))
    return segs


def normalise_step(path, stamp):
    """Renumber a STEP file canonically and fix its FILE_NAME time stamp, in place.

    Returns a short note for the log. Leaves the file as it was when it cannot be read as a plain
    Part 21 exchange file (one DATA section)."""
    with open(path, "rb") as f:
        raw = f.read()
    text = raw.decode("latin-1")
    pieces = _split_records(text)
    # find the DATA section (records between `DATA` and `ENDSEC` after it)
    data_at = next((i for i, p in enumerate(pieces) if p.strip() == "DATA"), None)
    if data_at is None:
        return "no DATA section; left as written"
    end_at = next((i for i in range(data_at + 1, len(pieces)) if pieces[i].strip() == "ENDSEC"), None)
    if end_at is None:
        return "no ENDSEC after DATA; left as written"
    header = ";".join(pieces[:data_at])
    trailer = ";".join(pieces[end_at:])
    if pieces[data_at + 1:end_at] == [] or any(p.strip() == "DATA" for p in pieces[end_at:]):
        return "not a single DATA section; left as written"

    ents = {}
    for rec in pieces[data_at + 1:end_at]:
        m = re.match(r"\s*#(\d+)\s*=\s*(.*)\Z", rec, re.S)
        if m is None:
            return "a DATA record without an entity number; left as written"
        ents[int(m.group(1))] = _segments(_compact(m.group(2)))

    # structural hashes, children first (iterative; a reference back into the walk counts as a cycle)
    digest = {}
    sorted_lists = {}
    for start in ents:
        if start in digest:
            continue
        stack, open_ = [start], set()
        while stack:
            e = stack[-1]
            if e in digest:
                stack.pop()
                continue
            kids = [s for s in ents[e] if isinstance(s, int) and s in ents and s not in digest and s not in open_]
            if e not in open_ and kids:
                open_.add(e)
                stack.extend(kids)
                continue
            open_.discard(e)
            stack.pop()
            h = hashlib.blake2b(digest_size=16)
            for s in ents[e]:
                h.update(b"\x00" + (digest.get(s, b"@") if isinstance(s, int) else s.encode("latin-1")))
            body = "".join(s if isinstance(s, str) else f"#{s}" for s in ents[e])
            if body.startswith(SET_LISTS):
                m = _REF_LIST.search(body)
                if m is not None:
                    refs = [int(r[1:]) for r in m.group(1).split(",")]
                    sorted_lists[e] = (m.start(1), m.end(1), refs)
                    h = hashlib.blake2b(digest_size=16)
                    h.update(body[:m.start(1)].encode("latin-1"))
                    for r in sorted(digest.get(r, b"@") for r in refs):
                        h.update(b"\x01" + r)
                    h.update(body[m.end(1):].encode("latin-1"))
            digest[e] = h.digest()

    # pre-order walk; ties (equal hashes) go by the numbers already given to what they point to
    big = 1 << 62
    new_id, order, bodies = {}, [], {}

    def visit(root):
        stack = [root]
        while stack:
            e = stack.pop()
            if e in new_id:
                continue
            new_id[e] = len(order) + 1
            order.append(e)
            body = "".join(s if isinstance(s, str) else f"#{s}" for s in ents[e])
            if e in sorted_lists:
                lo, hi, refs = sorted_lists[e]
                refs = sorted(refs, key=lambda r: (digest.get(r, b"@"), new_id.get(r, big), r))
                body = body[:lo] + ",".join(f"#{r}" for r in refs) + body[hi:]
            bodies[e] = body
            stack.extend(reversed([int(r) for r in re.findall(r"#(\d+)", _strip_strings(body)) if int(r) in ents]))

    referenced = {s for segs in ents.values() for s in segs if isinstance(s, int)}
    for pool in (sorted((e for e in ents if e not in referenced), key=lambda e: digest[e]), sorted(ents, key=lambda e: digest[e])):
        i = 0
        while i < len(pool):
            j = i
            while j < len(pool) and digest[pool[j]] == digest[pool[i]]:
                j += 1
            group = [e for e in pool[i:j] if e not in new_id]
            while group:
                group.sort(key=lambda e: ([new_id.get(s, big) for s in ents[e] if isinstance(s, int)], e))
                visit(group.pop(0))
                group = [e for e in group if e not in new_id]
            i = j

    def renumber(body):
        segs = _segments(body)
        return "".join(s if isinstance(s, str) else f"#{new_id.get(s, s)}" for s in segs)

    fixed = stamp.strftime("%Y-%m-%dT%H:%M:%S")
    header = re.sub(r"(FILE_NAME\s*\(\s*'(?:[^']|'')*'\s*,\s*')[^']*(')", lambda m: m.group(1) + fixed + m.group(2), header, count=1)
    lines = [f"#{new_id[e]}={renumber(bodies[e])};" for e in order]
    out = header.rstrip() + ";\nDATA;\n" + "\n".join(lines) + "\n" + trailer.lstrip()
    with open(path, "wb") as f:
        f.write(out.encode("latin-1"))
    return f"{len(order)} entities renumbered"


def _strip_strings(body):
    return re.sub(r"'(?:[^']|'')*'", "''", body)
