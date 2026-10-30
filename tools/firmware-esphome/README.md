# firmware-esphome tool pack

Compiles an ESPHome YAML config offline. Image `wirehub-tool-firmware-esphome:0.1.0`.

| | |
|---|---|
| Base | `python:3.12.12-slim-bookworm` (pinned by digest) |
| Tool | ESPHome 2026.9.0, `pip freeze` kept at `/etc/wirehub-pip-freeze.txt` |
| Target | `esphome`: the YAML names its own board (ESP32 or ESP8266, Arduino framework). Declared in `pack.json`, which also feeds the WireHub target list |
| Ops | `compile`, `identity` |

The build compiles `seed/seed-esp8266.yaml` and `seed/seed-esp32.yaml` (wifi, api, ota, web
server, i2c, gpio, …) so the PlatformIO platforms, frameworks, toolchains and the libraries those
components need are inside. Components needing other libraries, or other platforms (RP2040, ESP-IDF
frameworks, …) need seeds added and a rebuild.

```sh
docker build -t wirehub-tool-firmware-esphome:0.1.0 tools/firmware-esphome
docker run --rm --network none --read-only --tmpfs /tmp \
  -v "$IN:/work/in:ro" -v "$OUT:/work/out" \
  wirehub-tool-firmware-esphome:0.1.0 compile /work/in/request.json
```

Request: `{ "op": "compile", "params": { "target": "esphome", "defines": { "relay_pin": "GPIO5" }, "config": "config.yaml" }, "inputs": [ {"path":"config.yaml"}, {"path":"secrets.yaml"} ] }`.
`defines` become substitutions (`-s NAME value`); `config` picks the main YAML (default `config.yaml`).
Inputs may also be one `.zip` / `.tar.gz`. Use placeholder values in `secrets.yaml`; real
credentials do not belong in a firmware project's stored source.

Outputs: `firmware.factory.bin` / `firmware.ota.bin` (ESP32) or `firmware.bin` (ESP8266), `firmware.elf`,
`size.json`, `log.txt`, `manifest.json` (toolchain: ESPHome, platform and package versions).
Image size is about 4 GB (the ESP-IDF framework, ESP32 toolchain and ESP8266 toolchain).

Offline limits: an ESP32 config is compiled at a fixed build path (a generated `wirehub-build.yaml`
sets `esphome: build_path`) so that the ESP-IDF managed components copied from the seed
(Arduino core, mdns, multipart-parser) match their lock file. A config whose set of managed
components differs (for example `web_server`, `json`/`mqtt` users) cannot resolve them without
a network and fails with a clear finding; add a seed variant for such sets, or allow network for the run.
ESP8266 builds have no such restriction beyond the libraries in the seed.

Compile only: no upload, logs or OTA op.

Examples (synthetic): `examples/relay-node/` (ESP32), `examples/d1-node/` (ESP8266).
