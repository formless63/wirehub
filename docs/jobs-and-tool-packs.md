# Jobs and native tool packs

How WireHub runs native engineering tools (KiCad today; CAD kernels and
firmware toolchains next) as job stages, and why it does so on the existing
PostgreSQL/pg-boss job seam rather than a workflow engine. Decision note,
2026-10.

## The first stage: board outputs

On a board record in the Library, **Generate outputs** runs the `kicad` tool
pack (`tools/kicad/`, KiCad 10.0.6) over the board's native `.kicad_pcb`:

| op | outputs |
|---|---|
| `board-render` | top/bottom layer SVG (`kicad-cli pcb export svg`), top/bottom PNG render (`kicad-cli pcb render`) |
| `board-3d` | STEP and GLB (board body; component models the pack cannot resolve are reported, not invented) |
| `fab` | Gerbers + Excellon drill + drill map as one zip, position file (CSV), a footprint BOM (CSV, read from the board, not a schematic) |
| `netlist` | `nets.json`: each footprint's pads and nets from the board, and each schematic part's pins and nets (`kicad-cli sch export netlist`) when `.kicad_sch` files are sent; the board journey's KiCad check sets it beside the record (not run by Generate) |

1. The studio pins the source: the exact file text is kept as a catalog
   document (`data/model-sources/<sha256>.kicad_pcb.txt`, one change set), and
   the job request records its sha256, the board's revision/build, the pack and
   its version. If the board was imported from a different file than the one
   given, the answer says so and the outputs are recorded against the new hash.
2. The worker re-reads the bytes, checks the hash and runs each op in its own
   throwaway container (below). Each op's outputs are re-hashed against the
   pack's manifest and registered as a **tool run** (`studio.tool_run`,
   `studio.tool_output`, migration 0026): source path + sha256, pack version,
   image id, the tool's own reported version, parameters, findings, log,
   duration. Output bytes are derived blobs (rebuildable from source + pinned
   pack); the five newest runs per record and op are kept and the blob GC keeps
   every byte a run names.
3. Downloads go through `GET /api/blobs/:sha`. The newest `board-render` run
   adds cover candidates (KiCad render top/bottom, KiCad layers top/bottom) to
   the board's representation resolver, tied to the run's source and the
   record's revision/build: a run for an older revision reads as stale, not as
   current geometry.

API: `GET|POST /api/tool-outputs/pcbas/:id`, `GET /api/tool-outputs/runs/:id/log`,
`POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/retry`.

**The source is kept at import.** Importing a board from its `.kicad_pcb` (board-import) keeps the
file as `data/model-sources/<sha256>.kicad_pcb.txt` in the same plan as the board, so its outputs
(and an enclosure's native outline) run from the record without uploading it again. A file chosen
at **Generate outputs** is kept the same way and later runs reuse it.

## Firmware compiles and enclosure generation

The same runner runs two more stages, each a job of its own kind with progress and **Cancel**:

| job kind | pack (op) | started from | records |
|---|---|---|---|
| `firmware-compile` | `firmware-platformio` (`compile`) | **Compile** on a firmware project (`POST /api/firmware/:id/compile`, 202) | the build in `data/firmware/builds/<project>.json` (queued → running → ok / failed / error / cancelled), bytes under `firmware/sha256/` |
| `enclosure-generate` | `enclosure` (`enclosure-generate`) | **Generate** in a shell's enclosure panel (`POST /api/enclosures/:id/generate`, 202) | assets + the generated 3D model + `data/enclosures/<id>.json`, one change set; a cancelled or crashed run writes nothing |
| `device-export` | `enclosure` (`device-assemble`) | **Export** in a design's Device view, working copy or the saved version viewed (`POST /api/devices/:id/exports` `{ rev? }`, 202) | a tool run on `designs/<id>` (identity `Rev N`): assembly STEP, GLB, preview, A3 drawing SVG, result; database backend only, like board outputs |

The studio builds each request from the record as the person saved it (a firmware compile's target,
defines and source hashes; an enclosure's outlines, holes and ports), so the worker runs exactly
that and never re-reads a record that changed meanwhile. Each pack declares its ops in
`tools/packs.ts`; that file is the only place a pack's image is named.

### Network opt-in

Every op runs with `NetworkMode: none` unless its entry in `tools/packs.ts` says
`network: 'opt-in'` **and** the request asks for one. Today only `firmware-platformio compile`
opts in (a project whose `platformio.ini` fetches libraries; the compile request's `network: true`);
the build record says whether it had a network.

### Manifest extras and files

A manifest's extra fields pass through untouched (`ToolManifest[extra]`; the firmware pack's
`toolchain`, its platform and package versions). A run's result gives the verified outputs as
`files` (by manifest path) and `read(path)`, the pack's log, the image ref and id, and
`requestSha256`, the hash of the exact `request.json` the pack read.

## Print preparation (FDM)

Every mechanical record shows **Prepare print**. What it can slice, each pinned by its
sha256: the STL parts of the last enclosure generation; the record's 3D model when that
is an STL (since this change a shell's uploaded STL is kept as sent beside the converted
GLB, `ModelLink.original`, because the viewer's GLB may be thinned and is never sliced; a
model uploaded before that says to upload the STL again); an imported model's STL/3MF
source files, read where the model cache reads them (`WIREHUB_MODEL_SOURCES`, checked
against the link's sha256 and put into the asset store at Slice, `server/print/sources.ts`);
and **print files** uploaded
in the panel, STL or 3MF (`data/print/files/<id>.json`, assets `model/stl` / `model/3mf`,
migration 0031). A 3MF is sliced on its own as its own plate; its own slicer project
settings are set aside by the pack, so the hub's profile is the whole profile (per-object
settings in it are kept and listed). Choose the parts, an orientation (as designed, or lay flat: the largest planar face of each
part goes down), a printer, material and process profile, and optionally supports (none,
auto, from the bed only) and a brim width over the process profile (merged last and part
of the profile hash), then **Slice**. The studio
pins each part's sha256 and the merged profile's hash and enqueues a `print-prepare`
job; the worker runs the `slicer-prusaslicer` pack (`tools/slicer-prusaslicer/`,
PrusaSlicer 2.9.2) through the runner and registers the G-code, a summary (print time,
filament length and mass, layer count, height — the slicer's estimates), the effective
profile (every setting the slicer used, read back from the G-code), the requested
settings and the plate as a 3MF against `mechanicals/<id>`. **Save as manufacturing
variant** keeps the run's parts, profile ids and hashes, orientation, slicer identity
and estimates on the record (`data/print/variants/<id>.json`, a change set).

**OrcaSlicer** is the second slicer (`tools/slicer-orcaslicer/`, OrcaSlicer 2.4.2, the
official AppImage pinned by its sha256). Choose it in the panel and pick a printer preset
of the makers it lists (QIDI and Bambu Lab by default; `WIREHUB_ORCA_VENDORS` takes other
OrcaSlicer profile folder names, comma separated), then a filament and a process preset
OrcaSlicer offers for that printer; the printer's own defaults are preselected. The preset
list comes from the pack's `profiles` op, run once per pack version as a `print-prepare` job
(the panel starts it the first time) and registered against `tools/slicer-orcaslicer`. The
supports and brim choices map to OrcaSlicer settings over the process preset. Output is the
G-code and, for Bambu Lab printers, the sliced plate as `<name>.gcode.3mf` (plate G-code and
its MD5) that those printers take. The run records each preset's hash (the preset with its
inheritance resolved), so a variant names exactly what it sliced with. The hub's own
profiles below apply to PrusaSlicer only.

Profiles are one catalog document, `data/print/profiles.json` (a change set, with
history); until someone saves, a small generic starter set is used (a 0.4 mm
220 × 220 mm printer, PLA, PETG, two processes), labelled as synthetic starting values.

**Resin.** A printer profile with `printer_technology = SLA` is a resin printer: the panel
then offers only resin material and process profiles (also `printer_technology = SLA`),
drops the brim, and the job runs the `slicer-resin` pack (`tools/slicer-resin/`:
PrusaSlicer 2.9.2 in SLA mode for supports, pad and layers, then UVtools 7.0.2 to the
printer's own format). The result is a `.goo` (role `printer-file`), the `.sl1`, a summary
(layers, height, exposure, print time and resin ml), the file's preview image and the
effective profile; the pack reads the `.goo` back with UVtools and with its own reader of
Elegoo's published layout and fails on any mismatch. A starter Elegoo Mars 5 Ultra printer,
a standard-resin material and a 0.05 mm supported process are added while the hub has no
resin printer of its own. No `.goo` from the pack has been printed by WireHub yet: print a
small test part before trusting a profile (`docs/print-resin.md`).
Edit them in the panel as PrusaSlicer `key = value` lines; print-host and
post-processing settings are refused. Preparation produces files only: WireHub never
connects to or operates a printer.

API: `GET|PUT /api/print/profiles`, `GET|POST /api/print/slicers/orcaslicer/profiles`, `GET|POST /api/print/mechanicals/:id`,
`POST /api/print/mechanicals/:id/files`, `DELETE /api/print/mechanicals/:id/files/:asset`,
`POST /api/print/mechanicals/:id/variants`. Resin printing is not offered; why, and what
it would take: `docs/print-resin.md`.

## The runner

`apps/studio/server/tools/runner.ts` implements tool-pack contract v0
(`tools/README.md`). Per op it creates a container equivalent to

    docker run --rm --network none --read-only --tmpfs /tmp \
      -v <in>:/work/in:ro -v <out>:/work/out <image> <op> /work/in/request.json

plus `CapDrop=ALL`, `no-new-privileges`, memory/CPU/pids limits, running as the
worker's uid. It enforces the op's timeout and cancels by killing the
container, keeps the pack's `log.txt` and the container output, refuses a
manifest that does not confirm the inputs or names a path outside its folder,
and re-hashes every declared output; undeclared files are ignored. Other stages
code against `runToolPackWith(runner)`: `(pack, op, params, inputs) → manifest
+ verified bytes`.

It talks to the Docker Engine API directly (`tools/docker-engine.ts`, `node:http`,
no SDK or CLI) at `DOCKER_HOST`.

### Who can reach Docker

- **Only the worker.** `WIREHUB_TOOL_RUNNER=docker` is read by the worker's
  handlers; the web app enqueues and reads results but never opens a Docker
  connection. The stage is offered in the UI only when the worker's heartbeat
  lists the `board-outputs` queue, i.e. when a worker with a runner is up.
- **Compose:** the `tools` profile adds `tool-proxy`
  (`wollomatic/socket-proxy`, pinned by digest), the worker's only path to the
  socket. Its allow-list passes image inspect and container
  list/create/start/wait/logs/kill/remove and nothing else (no exec, pull, build,
  volume or network calls), only from the `worker` service, on the internal
  network. A proxy cannot read request bodies, so the image and mounts are
  decided by the worker's code (images come from `TOOL_PACKS`, never from a
  request).
- **Work folders:** in compose they live on the named volume
  `wirehub-tool-work` (mounted into the worker at `/data/tool-work`); each run
  mounts its own `in`/`out` sub-path of it (Docker Engine 26 or later). A
  worker running on the host uses bind mounts of `WIREHUB_TOOL_WORK_DIR`.
- **Images:** a pack is enabled by building (or pulling) its image on the
  worker's Docker: `docker build -t wirehub-tool-kicad:10.0.6-5 tools/kicad`.
  `WIREHUB_TOOL_IMAGE_KICAD` points at a mirror. Without a registry a missing
  image fails the job with that instruction; nothing is pulled at run time.
- **From a registry (optional):** set `WIREHUB_TOOL_REGISTRY` to a prefix such
  as `registry.example.com/owner` and every pack runs as
  `<prefix>/wirehub-tool-<pack>:<version>` (a `WIREHUB_TOOL_IMAGE_<PACK>`
  override still wins). When that image is missing the worker pulls it once
  through the proxy before the run; a re-run pinned to a recorded image id must
  get exactly that id back from the pull, or it fails as before. For a private
  registry set `WIREHUB_TOOL_REGISTRY_USER` and `WIREHUB_TOOL_REGISTRY_TOKEN`
  (a read-only package token). The pull is done by the host's Docker daemon, so
  the registry must be HTTPS or listed in the daemon's `insecure-registries`.
  The proxy must allow `POST /images/create` for this (the compose file's
  `tool-proxy` does); without a registry nothing calls it.
- **Idle cost:** the proxy (a few MB) and nothing else. Tool containers exist
  only while an op runs.

Enable it: `COMPOSE_PROFILES=tools` (plus any others), `WIREHUB_TOOL_RUNNER=docker`,
build the pack image, restart the worker.

**Without a worker.** The file backend runs jobs inside the web process, one at a time, and keeps
them in memory. With `WIREHUB_TOOL_RUNNER=docker` set there it runs firmware compiles and enclosure
generation itself, through the same runner (the web process then talks to Docker: a single-host
choice). Board outputs need the database's `tool_run` tables, so they are offered only with
`WIREHUB_BACKEND=pg`. A single-process database deployment (`WIREHUB_WORKER=off`) may opt in the
same way. In memory a restart forgets the jobs; a build or generation that was running then reads
as interrupted. Without `WIREHUB_TOOL_RUNNER=docker` the buttons say what is missing (503 with the
reason).

## Re-run, compare and packages

Any recorded run of a stage that registers tool runs (board outputs, device
export, print preparation) can be run again exactly: `POST
/api/repro/runs/:runId/rerun` enqueues a new job of the same kind from the
recorded request (inputs pinned by sha256, effective inputs kept as captured),
adds `rerunOf` and `pinImages: { <pack>: <image id> }`, and the stage runs that
exact image id rather than the pack's current tag (`server/repro/pin.ts`). If
that image is gone from the worker the re-run fails and says so.

`GET /api/repro/runs/:runId` answers the newest re-run and the compare
(`server/repro/compare.ts`): per output path same / differs / new / gone with
sizes; for text outputs a count of differing lines with the first few; whether
the image, tool, inputs or parameters moved. A run whose only differences are
lines carrying a date, time or run duration is `same-but-times` (KiCad stamps
its SVGs, for example). The page offers Re-run and the verdict on each run; the
per-file compare, picture overlay and hashes open in a drawer.

Packages are zips a person can check without the hub:
`GET /api/repro/runs/:runId/package` (one run) and
`GET /api/repro/designs/:id/:rev/package` (a saved version: the version file,
its effective inputs, text exports, the device export made from it and the
newest outputs of each board it uses). Each holds `manifest.json` (every file
with sha256 and size, every run with pack, version, image id, tool and the
inputs it read), `SHA256SUMS`, and `verify.py` (Python 3 standard library):
`python3 verify.py [folder|zip]` prints MISSING / FAILED / EXTRA and exits 1 on
any problem. A file the hub no longer stores is listed under `missing`.

## Audit of the job path

| Concern | What the code does | Gap | Decision |
|---|---|---|---|
| Submission | `job_run` row inserted and `pg-boss send` made **in the same transaction** (`JobStore.create(…, within)`, `JobRunner.submitWithin`, pg-boss's `db` option) | — (was: a failed send left a `queued` row nothing ran) | done: the row and its queue entry commit or roll back together; a module queue is created before the transaction opens |
| Cancellation | none before this change (only module-queue reconciliation set `cancelled`) | — | added: `POST /api/jobs/:id/cancel`; a queued job never starts (start requires `queued`); a running handler sees `JobContext.cancelled()`; the tool runner kills the container; `finish`/`fail` never overwrite `cancelled` |
| Retry | queues use `retryLimit: 0`; a person reruns | adequate: stages are idempotent and content-addressed | keep |
| Recovery | a running job holds a **lease** (`job_run.lease_until`, migration 0030) its process renews every 30 s; the worker's reconciler (at start and every heartbeat; with `WIREHUB_WORKER=off`, the web process each minute) marks a `running` row whose lease is 2 min old **`interrupted`** | — (was: the row read as running forever) | done: interrupted jobs show on the Jobs page and on their stage's panel; a repeatable kind (`board-outputs`, `firmware-compile`, `enclosure-generate`, `print-prepare`, `model-cache`, `derive`, `convert`) has **Run again** (`POST /api/jobs/:id/retry`, a new job from the same request, inputs captured again) |
| Orphaned containers | a worker killed mid-op leaves its tool container running to its timeout and then stopped (it is never `--rm`ed by Docker; the runner removes it) | — (was: the proxy had no container list, so a new worker could not find it) | done: each container carries `org.wirehub.tool-owner` (`WIREHUB_TOOL_OWNER`, else the stack's work volume); at start and every heartbeat the worker lists only its own owner's containers and removes those whose job is known and no longer running, or that have no job and have stopped (`tools/sweep.ts`). Another stack's containers, a live job's and an unknown job's are left alone; containers from before the owner label need removing by hand once |
| Input identity | imports keep the upload's sha256 (staged blob, a day); model builds record inputs + builder version | native tools had none | tool runs record source sha256, pack version, image id and the tool's own version; a stage started for a design (`design` in the start request; a firmware compile for an occurrence names its design) records the design's **effective inputs** on the job (`request.effectiveInputs`), shown in the job's panel on the Jobs page |
| Multi-stage | none | board outputs run three ops sequentially in one job; each op is registered on its own, so a later failure keeps earlier outputs; recovery is a rerun (seconds) | sufficient for now |

## Temporal: defer

Temporal would bring durable multi-step execution, activity heartbeats,
timers and a visibility UI. The gaps found are two small reconciliations
inside the existing tables, and the stages are short, idempotent and
content-addressed, so a rerun is the recovery. Adopting Temporal now would add
a server (plus its schema and an operator UI) to every install and a second
retry loop beside pg-boss, for no concrete current need.

**Revisit when any of these becomes real:**

1. a pipeline of three or more dependent stages where one stage takes more
   than ~10 minutes and rerunning earlier stages after a failure is not
   acceptable;
2. a pipeline that waits on people or timers for hours or days between stages
   (e.g. order fabrication → assemble → test → release) and must resume
   exactly;
3. more than one worker host running long activities that need leases and
   heartbeats;
4. the job reconciliation code grows into compensation/saga logic beyond one
   small module.

If it is adopted, it replaces pg-boss for those pipelines (one retry loop per
stage), uses PostgreSQL for persistence/visibility, and ordinary editing never
depends on it.
