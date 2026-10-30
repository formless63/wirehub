/** The offline verifier shipped in every package (`package.ts`): Python 3 standard library only. */

export const VERIFY_PY = String.raw`#!/usr/bin/env python3
"""Check a WireHub package offline: every file manifest.json lists is present with its
sha256 and size, and no file was added. Python 3 standard library only.

    python3 verify.py                 # the folder this script is in
    python3 verify.py <folder|.zip>   # an unpacked package, or the zip itself
"""
import hashlib
import json
import os
import sys
import zipfile

OWN = {"manifest.json", "verify.py", "SHA256SUMS", "README.txt"}


def from_folder(root):
    found = {}
    for base, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(base, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            found[rel] = full
    def read(rel):
        digest = hashlib.sha256()
        size = 0
        with open(found[rel], "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
                size += len(chunk)
        return digest.hexdigest(), size
    def raw(rel):
        with open(found[rel], "rb") as handle:
            return handle.read()
    return set(found), read, raw


def from_zip(path):
    archive = zipfile.ZipFile(path)
    names = [n for n in archive.namelist() if not n.endswith("/")]
    tops = {n.split("/", 1)[0] for n in names}
    prefix = (tops.pop() + "/") if len(tops) == 1 and all("/" in n for n in names) else ""
    found = {n[len(prefix):]: n for n in names}
    def read(rel):
        data = archive.read(found[rel])
        return hashlib.sha256(data).hexdigest(), len(data)
    def raw(rel):
        return archive.read(found[rel])
    return set(found), read, raw


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    if os.path.isfile(target) and zipfile.is_zipfile(target):
        names, read, raw = from_zip(target)
    elif os.path.isdir(target):
        names, read, raw = from_folder(target)
    else:
        print("not a package folder or zip: " + target)
        return 2
    if "manifest.json" not in names:
        print("FAILED  manifest.json is missing")
        return 1
    manifest_bytes = raw("manifest.json")
    manifest = json.loads(manifest_bytes.decode("utf-8"))
    if not str(manifest.get("format", "")).startswith("wirehub-package/"):
        print("FAILED  manifest.json is not a WireHub package manifest")
        return 1
    problems = 0
    listed = set()
    for entry in manifest.get("files", []):
        rel = entry["path"]
        listed.add(rel)
        if rel not in names:
            print("MISSING " + rel)
            problems += 1
            continue
        sha, size = read(rel)
        if sha != entry["sha256"] or size != entry["size"]:
            print("FAILED  " + rel + "  (sha256 " + sha[:16] + "..., expected " + entry["sha256"][:16] + "...)")
            problems += 1
        else:
            print("ok      " + rel)
    for rel in sorted(names - listed - OWN):
        print("EXTRA   " + rel + "  (not in the manifest)")
        problems += 1
    print("")
    print("manifest sha256 " + hashlib.sha256(manifest_bytes).hexdigest())
    if problems:
        print("%d problem(s) in %d file(s): this package is NOT as it was made." % (problems, len(listed)))
        return 1
    print("%d file(s) match the manifest." % len(listed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
