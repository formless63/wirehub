# Saving and findings

Saving preserves work; it does not certify it. Partial information, provisional parts,
disconnected pins, experimental incompatible connections and estimated values all save, with
concise findings. Unknown, zero, estimate and chosen stay distinct: an absent value is stored as
absent (or empty text), never as a guessed number.

Every finding falls in one of three classes (`packages/model/src/save-policy.ts`):

| Class | Example | What happens |
| --- | --- | --- |
| (a) Representation integrity | two parts or records under one id, a sub-assembly that places itself, a malformed field, two builds under one key | the save is refused, nothing is written |
| (b) Design finding | unknown definition, missing pin or port, open shield, a shop rule's error, no source yet | saved with the work; the response carries `X-WireHub-Findings`, the Issues panel and record chips show them |
| (c) Release criterion | any error at release or publication | the deliberate release (or pack publication) refuses |

Authorization, stale-write protection (`If-Match`), upload and path safety, signed packs and
inventory ledger rules (no negative stock, no receipt of nothing) are integrity checks and are
unchanged.

## What each save path does now

| Save path | Refused before | Now |
| --- | --- | --- |
| Design working copy (`PUT/POST /api/designs`, duplicate, rename) | any validator error; empty `src` | only class (a); the rest saved, counted in `X-WireHub-Findings`, listed by `GET /api/designs/:id/issues` |
| Editor edits (`commit`) | any error, including ones already in the design | only a new integrity problem or an edit slip (a pin, part or definition that is not there); existing findings never freeze editing |
| Editor Save | a "Save anyway" confirmation for warnings | saves straight through; the status reads "saved — N problems, M warnings to look at" |
| Import JSON in the editor | unknown definitions | kept as findings; only class (a) refuses |
| New design dialog and wizard | an empty Reference | allowed; a `missing-src` finding |
| Library records (connectors, components, wire stocks, boards, hardware, kits, bodies, pinouts) | any error the change introduced anywhere (a design losing a pin); empty `src`; connector or body family; board part number or revision | only introduced class (a) and duplicate part numbers; findings counted in `X-WireHub-Findings`; a record shows its own as one chip |
| Wire stock recipes and wire parts (server and the stock builder's Save) | compile errors; library errors; empty `src`, lay or web citation | only duplicate core or part ids; a core naming a part not yet in the library is a finding; the builder shows them as one chip |
| Board build files | any build error | only two builds under one key |
| Product families | any error (a variant naming a missing design) | only duplicate ids |
| Resolver devices, recipes, hazards | any error (a port naming a missing pinout) | only duplicate or malformed ids, extends cycles |
| Board proposal accepted | refused when no part number could be suggested | creates the board with an empty number |
| Firmware projects | empty `src` | allowed; the response lists `findings`, the page says "not said yet" |
| Enclosures, knowledge notes and projects, inventory | (already advisory, or ledger/shape checks only) | unchanged |
| Saved versions and release | — | unchanged: a version keeps its findings, a release refuses on errors |
| Depiction anchors and guides, packs | path, terminal-key and signature checks | unchanged (integrity) |

Not changed yet: a connector body still needs a gender (the record type has no "unknown"
gender), and a pinout position that is listed must name a signal (leave the position out instead).
