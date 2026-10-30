# Tool pack `slicer-resin`

Resin (masked-LCD / mSLA) print preparation. PrusaSlicer 2.9.2 in SLA mode (Debian trixie
package, AGPL-3.0) slices the parts, generates supports and a pad and writes its own `.sl1`
(a zip of layer images); UVtoolsCmd 7.0.2 (UVtools, AGPL-3.0, the linux-x64 release zip,
SHA-256 checked at build) converts that to the printer's format. Today the pack writes Elegoo
`.goo` (Mars 5 Ultra, Saturn 4 Ultra and other current Elegoo printers). Image: <!-- privacy-check: allow — public printer model names -->
`wirehub-tool-slicer-resin:0.1.1` (about 2.1 GB: the PrusaSlicer GUI libraries plus the
self-contained .NET UVtools build).

    docker build -t wirehub-tool-slicer-resin:0.1.1 tools/slicer-resin

The pack prepares files. It never connects to or operates a printer.

| op | inputs | params | outputs (role) |
|---|---|---|---|
| `slice` | one or more `.stl` parts, or one `.3mf` | `config` (PrusaSlicer SLA settings plus the pack's `resin_*` keys, printer → material → process merged by the caller), `orientation` (`as-designed` / `flat`), `parts`, `name` | `<name>.goo` (`printer-file`), `<name>.summary.json` (`summary`: layers, height, exposure, print time and resin ml estimates, pixel pitch, mirror, the read-back), `<name>.preview.png` (`preview`: the file's own preview), `<name>.sl1` (`sla-slices`: PrusaSlicer's output, opens in PrusaSlicer or UVtools), `<name>.effective.ini` (`effective-profile`), `<name>.request.ini` (`requested-profile`), `<name>.plate.3mf` (`plate`) |

`resin_*` keys (never passed to PrusaSlicer):

- `resin_format`: `goo`.
- `resin_machine_name`: written into the file header as the machine name. UVtools also reads
  it: a name containing "Mars 5 Ultra" or "Saturn 4 Ultra" selects the tilting-vat encoding, <!-- privacy-check: allow — public printer model names -->
  where lift and retract values are written as UVtools' fixed 0.05 placeholders (the printer
  uses its own tilt release).
- `resin_<UVtools custom value, snake case>`: `resin_lift_height`, `resin_lift_speed`,
  `resin_bottom_lift_height`, `resin_retract_speed`, `resin_wait_time_before_cure`,
  `resin_transition_layer_count`, `resin_light_pwm`, … (motion and light values PrusaSlicer
  has no setting for; they go to UVtools as SL1 custom values).

When the profile sets no `initial_layer_height`, the pack sets it to `layer_height`
(PrusaSlicer's SLA default of 0.3 mm is a Prusa SL1 habit).

Every result is read back twice before it counts as `ok`: UVtools' own `print-properties`, and
the pack's small reader of Elegoo's published GOO layout (header fields, every layer's checksum
and Z order, a sample of layers decoded pixel by pixel). Resolution, layer count, layer height,
exposure, bottom exposure, bottom layers and machine name must match what was asked for.

Issue scan: UVtools' `print-issues` then looks for islands, resin traps, suction cups and parts
touching the build area edge; each kind found is one `warn` finding (count, first layers, largest
area in mm²) and the list is in the summary's `issues`. A scan that cannot run is an `info`
finding; the file still counts.

**A .goo from this pack has not been printed by us.** UVtools is the only open writer for the
format, and the header values follow its Mars 5 Ultra handling. Print a small test part (check
that an asymmetric part is not mirrored) before trusting a profile. The starter exposure values
are generic starting points for a standard resin, not tuned.

Hollowing: PrusaSlicer's `hollowing_enable` works in a process profile, but the CLI cannot place
drain holes, so a hollowed part traps resin; it is off in the starter profiles.

Try it by hand (a folder with `in/part.stl` and `in/request.json`):

    docker run --rm --network none --read-only --tmpfs /tmp \
      -v "$PWD/in:/work/in:ro" -v "$PWD/out:/work/out" \
      wirehub-tool-slicer-resin:0.1.1 slice /work/in/request.json
