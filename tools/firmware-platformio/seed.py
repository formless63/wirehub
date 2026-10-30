#!/usr/bin/env python3
"""Build-time helper: write the seed project and install list for a family's pack.json."""
import json, sys
from pathlib import Path

pack = json.loads(Path(sys.argv[1]).read_text())
dest = Path(sys.argv[2])
(dest / "src").mkdir(parents=True, exist_ok=True)
(dest / "src" / "main.cpp").write_text("#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n")
ini = ["; Generated at image build from pack.json: builds once per target to pre-fetch its packages."]
for t in pack["targets"]:
    ini += ["", f"[env:{t['id']}]", f"platform = {t['platform']}", f"board = {t['board']}", f"framework = {t['framework']}", *t.get("ini", [])]
(dest / "platformio.ini").write_text("\n".join(ini) + "\n")
