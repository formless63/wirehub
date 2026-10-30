"""The pack's entry point: `enclosure-generate` runs enclosure.py, `device-assemble` assemble.py."""

import sys

if __name__ == "__main__":
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    if op == "device-assemble":
        from assemble import main
    else:
        from enclosure import main
    sys.exit(main(sys.argv))
