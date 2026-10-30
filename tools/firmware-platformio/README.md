# firmware-platformio tool pack

Compiles a PlatformIO project offline. One Dockerfile, one image per platform **family**, so no
image carries every toolchain (sizes from `docker images`, disk usage).

| Family (`FAMILY` build arg) | Image | Targets | Size |
|---|---|---|---|
| `classic` | `wirehub-tool-firmware-platformio:0.1.0` | `d1_mini` (ESP8266, `platformio/espressif8266@4.2.1`), `uno` (ATmega328P, `platformio/atmelavr@5.3.0`) | 1.2 GB |
| `esp32` | `wirehub-tool-firmware-platformio-esp32:0.1.0` | `esp32dev` (ESP32 DevKit, Arduino, `platformio/espressif32@6.13.0`) | 2.0 GB |
| `rp2040` | `wirehub-tool-firmware-platformio-rp2040:0.1.0` | `pico` (Raspberry Pi Pico, Arduino-Pico core by Earle Philhower via `maxgerhardt/platform-raspberrypi` pinned to commit `5d4561a`; makes `firmware.uf2`) | 1.6 GB |

Base `python:3.12.12-slim-bookworm` (pinned by digest), PlatformIO Core 6.2.0, Ops `compile` and
`identity`. A family's targets are declared in `families/<family>/pack.json`; the same file builds
the image (the seed project is generated from it and compiled once per target, pulling every
platform, framework, toolchain and build tool) and feeds the target list in the WireHub UI
(`apps/studio/server/firmware/targets.ts`). To add a target, add it to a `pack.json` and rebuild.
A compile then runs with `--network none` on a read-only root; the project is copied to `/tmp`
and the core directory is linked from the image.

```sh
for f in classic esp32 rp2040; do   # pack names: firmware-platformio[-esp32|-rp2040]
  docker build --build-arg FAMILY=$f -t wirehub-tool-$(jq -r .pack tools/firmware-platformio/families/$f/pack.json):0.1.0 tools/firmware-platformio
done
docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$IN:/work/in:ro" -v "$OUT:/work/out" \
  wirehub-tool-firmware-platformio-esp32:0.1.0 compile /work/in/request.json
```

## Request

```json
{ "op": "compile",
  "params": { "target": "d1_mini", "environment": "d1_mini",
              "defines": { "LED_PIN": 2, "DEVICE_NAME": "bench-unit-a" } },
  "inputs": [ { "path": "project/platformio.ini", "sha256": "…" },
              { "path": "project/src/main.cpp", "sha256": "…" } ] }
```

- `inputs` are project files, or one `.zip` / `.tar.gz` archive (links and escaping paths are
  refused). Without a `platformio.ini`, one is generated for `target`; loose `.ino/.cpp/.h`
  files move into `src/`.
- `defines` become `-D` build flags: names are C macro names, values numbers, booleans, null
  (defined without a value) or short text (quoted as a C string).
- `environment` picks one `[env:…]` when the project file has several.

## Outputs

`firmware.bin` / `firmware.hex` / `firmware.uf2` (Pico) (role `firmware`, whichever the platform makes),
`firmware.elf` (role `debug-image`), `size.json` (RAM/flash used and total, from PlatformIO's
summary), `log.txt`, and `manifest.json`. The manifest's `toolchain` lists the exact platform
and package versions in the image. A failed build is `status: "failed"` with the compiler's error
lines as findings; exit code 0.

## Network

Libraries a project lists in `lib_deps` are **not** in the image. Vendor them under `lib/`, or
the caller may opt in to network access for that run (the runner drops `--network none`); the
pack warns when it sees `lib_deps` without that opt-in, and names a failed download as such.

## Not here

No `upload`, monitor or OTA op: compiling is not device operation. Flashing and commissioning
are a separate, explicitly authorised record that does not exist yet. ESPHome YAML is the sibling pack `tools/firmware-esphome/`.
