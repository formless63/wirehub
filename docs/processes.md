# Required processes

A design can say which manufacturing processes it needs beyond plain assembly: overmolding, PCBA
assembly, a printed jacket. The hub keeps a **vocabulary** of processes; a design **declares** the
ones it needs, and a process can be **derived** from the design's parts with a rule-language
condition. Both end up in one list, each entry saying where it came from, in the design's Notes tab
and in the `processes.json` export. A saved version keeps the list it was saved with.

The base ships no processes. A hub adds its own in **Settings → Processes**, or installs a data pack
that ships `processes.json`.

## The vocabulary: `processes.json`

An array of records in the catalog (`data/processes.json`); a pack may ship the same file.

```json
[
  { "id": "overmold", "label": "Overmolding", "description": "A boot moulded over the connector",
    "derive": [{ "each": "mechanical", "where": { "eq": [{ "path": "kind" }, "boot"] }, "note": "a boot is moulded on" }],
    "src": "synthetic example" },
  { "id": "pcba-assembly", "label": "PCBA assembly", "derive": [{ "each": "pcba" }], "src": "synthetic example" },
  { "id": "jacket-print", "label": "Printed jacket",
    "derive": [{ "each": "design", "where": { "contains": [{ "path": "tags" }, "printed-jacket"] } }],
    "src": "synthetic example" }
]
```

- `id`: kebab-case, up to 100 characters; `label` up to 200; `src` (required) up to 2000;
  `description` optional, up to 2000. The id grammar is the same as a standard-work operation's, so a
  shop can use the same ids in both; the base never reads a module's data.
- `derive`: optional, at most 10 selectors. `each` is a design subject of the rule language
  (`design`, `connector`, `segment`, `conductor`, `component`, `pcba`, `mechanical`, `cable-end`,
  `signal-path`), `where` an optional condition in the same language and limits as a validation
  rule's ([validation-rules.md](validation-rules.md)); `note` optional. Every subject a selector picks
  derives the process.
- `enabled: false` switches a process off: declarations of it become warnings and it derives nothing.
- `license` and `provenance` are optional, as on any record.
- At most 200 processes.

A hub's own record with a pack's id shadows the pack's (Settings → Processes: **Override…**, **Turn
off**). An entry the checks reject is a `process-invalid` warning in the library and is skipped; the
pack verifier, a pack install and `PUT /api/processes` refuse it.

## Declaring on a design

```json
"processes": [{ "id": "overmold", "note": "strain relief at J1" }, { "id": "hand-label" }]
```

At most 100 entries, unique ids, `note` up to 500 characters. A malformed list refuses the save
(`invalid-processes`); an id the hub does not know, or has switched off, is a `process-unknown`
warning and is kept. There is no per-design opt-out of a derived process: narrow its `where` (for
example by a design tag) instead. A sub-assembly's processes are its own; a parent does not inherit them.

In the editor, the Notes tab shows the required processes as chips (derived ones marked "auto", the
matching parts on hover), **add process…** declares one, a click on a declared chip edits its note.

## `processes.json` (export)

`GET /api/designs/:id/exports/processes.json?rev=`

```json
{ "format": "wirehub.processes", "version": 1,
  "design": { "id": "lead-a", "label": "Lead A", "productRef": "LEAD-A", "rev": 3 },
  "vocabulary": "captured",
  "processes": [
    { "id": "hand-label", "label": "hand-label", "known": false, "source": "declared", "declared": {} },
    { "id": "overmold", "label": "Overmolding", "known": true, "source": "both",
      "declared": { "note": "strain relief at J1" },
      "derived": { "matches": [{ "each": "mechanical", "subject": "boot-1" }], "more": 0 } },
    { "id": "pcba-assembly", "label": "PCBA assembly", "known": true, "source": "derived",
      "derived": { "matches": [{ "each": "pcba", "subject": "u1" }], "more": 0 } } ],
  "issues": [{ "code": "process-unknown", "severity": "warning", "message": "process 'hand-label' is not in this hub's processes", "where": "processes" }] }
```

- Sorted by id. `source` is `declared`, `derived` or `both`; `label` is the id when the process is unknown.
- `derived.matches`: the first 20 subjects (`subject` is the address an issue's `where` uses: an
  instance id, `w1:core-red`, `w1@a`, the design's id); `more` counts the rest.
- `vocabulary`: `captured` for a saved revision (its own copy of the vocabulary), `live` for the
  working copy. `design.rev` is present for a revision.
- Deterministic: fixed key order, 2-space JSON, trailing newline.

## Saved versions

A saved version captures the vocabulary entries the design declared or matched when saved
(`definitions.processes` in the version file, after `mechanicals`; written only when there is at
least one, so older files keep their bytes). A revision's processes, issues and export read only those
entries, never the live vocabulary: changing or removing a process later leaves Rev N's list as it was.
Editing an unlocked version keeps the entries it captured and takes a newly needed one from the live
vocabulary. The version diff lists captured processes added, removed or changed.

## API

| Route | |
| --- | --- |
| `GET /api/processes` | `{ processes: [...entry, origin: 'local' \| 'pack', pack?, problems], local, limits: { processes: 200, derivePerProcess: 10, declaredPerDesign: 100 }, subjects }`, with an `ETag` |
| `PUT /api/processes` | `{ processes: [...] }` replaces the hub's own processes. `If-Match` required (428 without), 422 with `problems` when an entry cannot be used, 409 when stale. Owner or editor; a token needs `catalog:write`. Raises `catalog.changed` |
| `GET /api/designs/:id/exports/processes.json?rev=` | the export above |

Declarations travel with the design (`GET/PUT /api/designs/:id`); the vocabulary file is in
`GET /api/export` like every catalog file. In code: `requiredProcesses`, `processesInForce`,
`processListProblems`, `declaredProcessIssues` (`@wirehub/model`), `deriveProcessesExport` (`@wirehub/docs`);
module API 1.7.
