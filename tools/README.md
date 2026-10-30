# Tool packs

A tool pack runs one native tool (KiCad, a CAD kernel, a firmware toolchain …)
in a pinned container, started by the worker for one job step and gone
afterwards. Nothing in a pack runs in the web app, and a pack has no network.

Contract v0:

- `tools/<pack>/` holds a `Dockerfile` (pinned base image by digest, pinned tool
  versions), an entry script and a short README. The image is tagged
  `wirehub-tool-<pack>:<packVersion>`.
- The runner (`apps/studio/server/tools/`) invokes it exactly as

      docker run --rm --network none --read-only --tmpfs /tmp \
        -v <in>:/work/in:ro -v <out>:/work/out <image> <op> /work/in/request.json

  and a pack must not assume more (no network, no writable root, only `/tmp`
  and `/work/out` writable).
- `request.json`: `{ "op", "params": {…}, "inputs": [{ "path": "rel/path", "sha256" }] }`.
  The pack checks each input's sha256 before reading it.
- The pack writes `/work/out/manifest.json`:

      { "pack", "packVersion", "tool": { "name", "version" }, "op",
        "inputs": [{ "path", "sha256" }],
        "outputs": [{ "path", "sha256", "role", "mediaType" }],
        "log": "log.txt", "status": "ok" | "failed",
        "findings": [{ "level": "info" | "warn" | "error", "message" }] }

  plus the output files and `log.txt`. Exit code 0 even for an honest
  `failed`; a non-zero exit means the pack itself crashed.
- The runner records the exact inputs and tool identity, enforces a timeout,
  cancels by killing the container, re-hashes every output against the
  manifest and registers the outputs (`docs/jobs-and-tool-packs.md`).

Build a pack: `docker build -t wirehub-tool-kicad:10.0.6-7 tools/kicad`
(the version must match `apps/studio/server/tools/packs.ts`).
