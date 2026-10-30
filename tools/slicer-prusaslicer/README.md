# Tool pack `slicer-prusaslicer`

FDM print preparation with the PrusaSlicer 2.9.2 command line (AGPL-3.0), as Debian
trixie packages it (`prusa-slicer=2.9.2+dfsg-1`, base image pinned by digest). Image:
`wirehub-tool-slicer-prusaslicer:2.9.2-3` (about 1.8 GB; the Debian build links the GUI
libraries even for CLI use).

    docker build -t wirehub-tool-slicer-prusaslicer:2.9.2-3 tools/slicer-prusaslicer

The pack prepares files. It never connects to or operates a printer, and it refuses
print-host and post-processing settings.

| op | inputs | params | outputs (role) |
|---|---|---|---|
| `slice` | one or more `.stl` / `.3mf` parts | `config` (PrusaSlicer settings, printer → material → process merged by the caller), `orientation` (`as-designed` or `flat`: the largest planar face of each STL goes down), `parts` (`[{ path, copies }]`, default every input once), `name` (output stem) | `<name>.gcode` (`gcode`), `<name>.plate.3mf` (`plate`: the STL parts oriented and laid out on the bed, one object each; parts are packed in rows by the pack itself because `--merge`/arrange crashes headless in this build), `<name>.summary.json` (`summary`: print time, filament mm / cm³ / g, layer count, height, slicer identity, effective profile hash), `<name>.effective.ini` (`effective-profile`: every setting the slicer used, read back from the G-code), `<name>.request.ini` (`requested-profile`: the keys the caller set) |

Estimates are PrusaSlicer's own and depend on the printer profile's speeds and limits.
The G-code's first line carries a generation timestamp, so G-code bytes differ between
otherwise identical runs; the effective profile (and its hash) does not.

PrusaSlicer slices with the hub's own profiles: a flat INI format that is easy to generate,
edit, hash and read back from the G-code, from a packaged, version-pinnable Linux build
(Debian). For the presets printer makers ship (QIDI, Bambu Lab …) and the Bambu Lab
`.gcode.3mf`, use the `slicer-orcaslicer` pack beside it (`tools/slicer-orcaslicer/`).

Try it by hand (a folder with `in/part.stl` and `in/request.json`):

    docker run --rm --network none --read-only --tmpfs /tmp \
      -v "$PWD/in:/work/in:ro" -v "$PWD/out:/work/out" \
      wirehub-tool-slicer-prusaslicer:2.9.2-3 slice /work/in/request.json
