# Tool pack `slicer-orcaslicer`

FDM print preparation with the OrcaSlicer 2.4.2 command line (AGPL-3.0) and the printer,
filament and process presets OrcaSlicer ships for each printer maker. The pack lists the
presets of the QIDI and Bambu Lab folders by default (any shipped folder can be asked for).
Image: `wirehub-tool-slicer-orcaslicer:2.4.2-2` (about 1.7 GB).

    docker build -t wirehub-tool-slicer-orcaslicer:2.4.2-2 tools/slicer-orcaslicer

The build downloads the official Linux AppImage
(`OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage`) and checks it against its release
sha256 (`ADD --checksum`), unpacks it (no FUSE at run time), and installs the GUI libraries
it links from the Ubuntu 24.04 archive as it stood on one date (snapshot.ubuntu.com), on an
Ubuntu base pinned by digest. A different OrcaSlicer release is a new pack version.

The pack prepares files. It never connects to or operates a printer, and it refuses
print-host and post-processing settings.

| op | inputs | params | outputs (role) |
|---|---|---|---|
| `profiles` | none | `vendors` (profile folders, default `["BBL", "Qidi"]`) | `profiles.json` (`profiles`): each printer preset with the process and filament presets offered for it, its default process and filament, bed size, and every preset's hash |
| `slice` | one or more `.stl` parts, or one `.3mf` | `presets` (`{ printer, material, process }` by OrcaSlicer preset name), `overrides` (OrcaSlicer keys over the presets: supports, brim …), `orientation` (`as-designed` or `flat`), `parts` (`[{ path, copies }]`), `name`, `printer3mf` (`auto`: Bambu Lab printers) | `<name>.gcode` (`gcode`), `<name>.gcode.3mf` (`gcode-3mf`: the sliced plate Bambu Lab printers take, with `Metadata/plate_1.gcode` and its `.md5`), `<name>.summary.json` (`summary`), `<name>.effective.ini` (`effective-profile`: every setting the slicer used, read back from the G-code), `<name>.request.json` (`requested-profile`), `<name>.preview.png` (`preview`) |

How presets are used: the pack resolves each preset's `inherits` chain itself (parent first,
child wins; a filament parent missing from the maker's folder comes from
`OrcaFilamentLibrary`), applies the overrides, and hands the slicer the result as a user
preset over the system one it came from, so OrcaSlicer's own compatibility check still sees
the system names. A process or filament preset that the maker does not offer for the
printer is refused. The preset hashes in `profiles.json` and the summary are the sha256 of
the resolved preset, so a run names exactly what it sliced with.

Parts: STL parts rest on the bed and OrcaSlicer arranges them (no rotation) around the
printer's excluded areas; a 3MF keeps its own placement and is sliced without its own slicer
project settings or any sliced plate it carries. `flat` lays each STL on its largest flat face
(the same rule as `slicer-prusaslicer`).

Plate preview: OrcaSlicer 2.4.2's CLI draws no thumbnail without a display (it asks glfw for an
"OpenGL 3.4" context, glfw's own version number, which no driver offers), so `preview.py` draws
the arranged plate itself from the sliced 3MF (pure Python, flat shaded in the filament colour,
transparent background). It becomes `<name>.preview.png` (role `preview`), the Bambu Lab 3MF's
`Metadata/plate_1.png` (512x512) and `plate_1_small.png` (128x128), the files the package's
relationships name and the printer's screen shows, and, for other printers, PNG thumbnail
blocks in the G-code at the sizes the printer preset's `thumbnails` setting asks for. The Bambu
plate G-code is left untouched (it must match its `.md5` and the `.gcode` output).

Known limits: the pack fills the plate's `printer_model_id` (the CLI leaves it empty) from the
maker's model preset, which changes `Metadata/slice_info.config` only. The G-code's first lines
carry a generation timestamp, so bytes differ between identical runs; the effective profile (and
its hash) does not.

Try it by hand (a folder with `in/part.stl` and `in/request.json`):

    docker run --rm --network none --read-only --tmpfs /tmp \
      -v "$PWD/in:/work/in:ro" -v "$PWD/out:/work/out" \
      wirehub-tool-slicer-orcaslicer:2.4.2-2 slice /work/in/request.json
