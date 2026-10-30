# Firmware projects

A firmware project keeps a board's firmware source and configuration, compiles it through an
isolated, pinned toolchain, and keeps the results. Open it from **Workshop → Firmware**, from a
board record's **Firmware** row, or from the **Firmware** rows in a design's inspector.

## What a project holds

| | |
|---|---|
| Board | the `pcbas` record the firmware runs on (optional while drafting) |
| Target | a supported toolchain target, listed from what the tool packs declare: `d1_mini` (ESP8266), `uno` (ATmega328P), `esp32dev` (ESP32), `pico` (RP2040, makes a `.uf2`) — all Arduino — or `esphome` (an ESPHome YAML config) |
| Source | uploaded files (`platformio.ini`, `src/…`) or one `.zip` / `.tar.gz`, stored by content hash |
| Configuration | `NAME = value` pairs, passed to the build as C macros (`-DNAME=value`) |
| Occurrences | placements of the board in designs (design + board instance id), each with its own overrides — pins, bus addresses, names |
| Builds | each compile: the exact configuration and source hashes it was given, its binaries (`.bin` / `.hex` / `.uf2` / `.elf`), size report and log, and the toolchain identity (tool pack and version, PlatformIO version, platform and package versions, image content id) |

Records are catalog documents (`data/firmware/projects.json`, `data/firmware/builds/<id>.json`);
bytes are in the blob store (`WIREHUB_BLOBS`) under `firmware/sha256/…`, or beside the catalog in
`data/.firmware-blobs/` when no blob store is configured.

Use **Edit project details** to change its name, board, target or source reference.
Create a project with a descriptive name; the hub assigns its internal identifier automatically.

An occurrence whose design or board instance is missing, or whose instance is a different board,
is shown as a finding; it does not block saving.

## Compiling

**Compile** builds the project defaults; **Compile for this occurrence** builds with that
occurrence's overrides on top. The compile runs the `firmware-platformio` tool pack
(`tools/firmware-platformio/`) with no network on a read-only container; every platform and
toolchain package is inside the image. Libraries listed in `lib_deps` can be vendored under
`lib/`, or enable **Allow this compile to download project dependencies** before compiling.
The checkbox applies to the next compile, including a selected placement. It starts off unchecked.

A compile is a `firmware-compile` job (`docs/jobs-and-tool-packs.md`): the build appears as
waiting, then compiling with the job's latest step, and has **Cancel** (the container is killed);
a compile interrupted by a worker restart reads as such and can be run again from the Jobs page.
A compile for an occurrence names its design, so the job records the design's effective inputs.
Compiles run where jobs run with a tool runner: the worker with `WIREHUB_TOOL_RUNNER=docker` on the
database backend, or the web process itself with that setting on the file backend.

An administrator can configure a tool registry so the hub downloads the pinned image on first use
(see [tool packs](jobs-and-tool-packs.md)). Alternatively, build the images on the host that runs compiles:

```sh
docker build -t wirehub-tool-firmware-platformio:0.1.0 tools/firmware-platformio
docker build --build-arg FAMILY=esp32 -t wirehub-tool-firmware-platformio-esp32:0.1.0 tools/firmware-platformio
docker build --build-arg FAMILY=rp2040 -t wirehub-tool-firmware-platformio-rp2040:0.1.0 tools/firmware-platformio
docker build -t wirehub-tool-firmware-esphome:0.1.0 tools/firmware-esphome
```

One image per platform family keeps each one a sensible size (1.2 to 2 GB; the ESPHome image is about 4 GB); build only the
families you compile for. A target's pack and image come from its `pack.json`
(`tools/firmware-*`), so the target list follows the images. For an `esphome` project, upload
`config.yaml` (plus included files and a `secrets.yaml` of placeholder values); configuration
`NAME = value` pairs become ESPHome substitutions. ESPHome images carry the ESP32 and ESP8266
Arduino toolchains and common component libraries; other platforms or libraries need a rebuild.

## Commissioning: flashing a unit, recorded

Compiling makes files only; WireHub does not flash, monitor or operate a device, and the hub has
no device access (no USB passthrough, and the tool runner has no network). Putting firmware on a
unit is an operator step at the bench, and WireHub keeps the record of it.

- **Flash bundle** (on a compiled build): a zip with the build's firmware files, `SHA256SUMS`,
  `manifest.json` (project, build, target, configuration, source hashes, toolchain identity) and a
  `README.txt` with the flashing command for the target (esptool for ESP8266/ESP32, avrdude for the
  Uno, the UF2 drive for the Pico, factory/OTA images for ESPHome).
- **Record commissioning** (the project's Commissioning section): which build and which firmware
  file (by sha256), which unit (a loose reference — a built-unit id, asset tag or serial — plus an
  optional serial), the method (USB serial bootloader, UF2 drive, over the air, debug probe, other),
  the result (works as expected / flashed, not fully verified / failed), what was observed (optional), who
  did it and when (the operator may record it later; the record also keeps who entered it and when).
  The record copies the artifact's path, hash and toolchain identity, so it stays meaningful after
  the build drops off the project's list, and its firmware file stays downloadable.
- Records are append-only. A correction is a new record that names the one it corrects; the
  earlier record is shown as superseded.
- `GET /api/firmware/commissions?unit=<ref>` lists every project's records for one unit.

**Authority.** Recording commissioning is separate from compiling: owners may record it, and
editors only when an owner names them under **Who may record commissioning** (their sign-in
emails, kept in `data/settings/commissioning.json`, which only owners can read). Viewers and API
tokens cannot record it, and the generic document routes refuse writes to the records. No save of any
kind (a History restore, a batch, an import) can rewrite or remove one, and a pack cannot supply them.

Records are catalog documents (`data/firmware/commissions/<project>.json`). The Unit field offers
the inventory's built units; a reference that is a built-unit id, or a serial exactly one built
unit carries, is linked to it (`inventoryUnit`), and the unit's panel in the inventory lists its
commissioning (`docs/inventory.md` § Units and test results).
