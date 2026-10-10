# Revisions of library records, and compare

A design saves **versions** (`specs/design-versions.md`). A library record — a connector, a board, a
shell, a component, a wire stock, a kit, a body or a pinout — saves **revisions**: numbered
snapshots with a note, so a shop can say which revision of a part a cable was built with, give a
changed part the next variant number, and compare two revisions (or two parts) field by field, in
2D and in 3D.

The engine is in the base (`@wirehub/model` `record-revisions.ts`); revisions from somewhere else (a
file share where a board's revisions live, a PLM) come in through a module (`revisionSources`) or
the API.

## A revision

`data/revisions/<kind>/<id>.json` holds one record's history:

```json
{
  "kind": "pcbas", "id": "pair-terminal-board",
  "revisions": [
    { "rev": 1, "note": "first release", "savedAt": "2026-10-05T12:00:00.000Z", "savedBy": "Olive Owner",
      "partNumber": "PCA-00001", "record": { "id": "pair-terminal-board", "…": "…" },
      "art": { "view": "board-top", "svg": "<svg …>" }, "model": { "asset": "<sha256>" } },
    { "rev": 2, "label": "Rev B", "note": "termination moved", "partNumber": "PCA-00001-01", "record": { "…": "…" } }
  ]
}
```

- `record` is the record as the library had it (a connector with its pins composed);
- `partNumber` is the record's number at that revision;
- `art` keeps the record's drawn 2D view (SVG text, at most 512 KB) and `model` the content
  address of its 3D model, so later changes do not lose what the revision looked like;
- `label` is how people name it when not by number.

`saveRecordRevision` adds the next one; `revisionOfRecord` finds the revision a record equals now
(none: it changed since); `recordRevisionProblems` checks a history sent through the API.

## Part numbers and variants

Saving a revision can first give the record the numbering scheme's **next variant** of its number
(`renumber`): the scheme's `suggest` with `variantOf` the current number. A declarative scheme with a
variant segment fills it (`1C-000012-00` → `-01`); the built-in prefix scheme, which allows a
revision suffix, gives the next free two-digit suffix (`CON-00012` → `CON-00012-01` → `-02`). The
record is saved with the new number through the definition's own checks (a number in use, an
immutable scheme), in the same change set as the revision. Each revision keeps the number it had,
so the history reads as the variants.

## Where used, per revision

`revisionsWhereUsed` reads the saved design versions: a version froze the definitions it used, so
the revision whose snapshot equals a version's frozen copy is the one that version was built with
(the released one is marked). Working copies use the record as it is now: under its revision when
it equals one, else listed as using a state no revision recorded. The record's page shows it per
revision.

## Compare

The Library's **Compare** (a record's head, the list's pick-two mode, and **Compare with now** on a
revision) opens the base compare view, or a module's for the kinds it declares
(`CompareViewContribution`; its sides may carry `rev`). The base view compares two records, a record
and one of its revisions, or two revisions:

- **Fields**: the field diff, changed fields by default.
- **2D**: each side's drawn art — a revision's as saved — side by side, or laid over each other in
  difference blending, where only what changed stays bright.
- **3D**, when both sides have a model: side by side in the 3D viewer, or laid over each other in two
  colours with a fade between A and B (`ModelOverlay3d`).

A revision's model is kept by content address: stored models stay with the hub's assets after they
are detached from the record, so an old revision still shows its model unless someone deletes that
stored model (the revision then lists it as missing).

## Revisions from outside: `revisionSources`

A module may answer for revisions the hub does not keep (`docs/modules.md`, module API 1.2):

```ts
revisionSources: [{
  id: 'share', label: 'Board revisions on the share', kinds: ['pcbas'],
  list: async ({ kind, id, record }, db) => [{ rev: 'Rev6', note: 'released', partNumber: '…', record: { … }, src: 'the share, board folder' }],
}]
```

`list` runs on the server for every revision listing of a record of those kinds; what it returns is
shown beside the hub's revisions, read-only, with its `src` (a source that throws is shown as not
readable, the page stays up). A runtime code module can contribute one; it applies live.

The other way in is the API: `PUT /api/revisions/:kind/:id` replaces a record's history with one
built elsewhere (checked first), so a script can import a file share's revision table.

## In the app

The record's page in the Library has a **Revisions** section: what the record is now (revision N, or
changed since N), each revision with its note, number, date, author, whether it kept art and a
model, the versions built with it, **Compare with now**; the outside sources' revisions; and **Save a
revision…** with a note, an optional name and **give it the next variant number**.

## The API

| Route | |
| --- | --- |
| `GET /api/revisions/:kind/:id` | the summaries, the current state, where each is used, the outside sources' revisions, the ETag |
| `GET /api/revisions/:kind/:id/:rev` | one revision in full |
| `POST /api/revisions/:kind/:id` | `{ note, label?, art?, model?, renumber?, force? }`: save the record as the next revision (refused, 409, when nothing changed since the last unless `force`) |
| `PUT /api/revisions/:kind/:id` | `{ kind, id, revisions }`: replace the history (If-Match) |
| `GET /api/revisions/:kind/:id/next-number` | the scheme's next variant of the record's number |

The history is a catalog document written through the unit of work, on files and on Postgres.

## What a private source supplies

Only its revisions: a module that reads where they live, or a script that imports them through the
API. The compare views, where used and numbering are the base's.

### Source models without definition snapshots

The Library also lists **Source model revisions** from model links keyed as
`revisions/<record-id>/<source-revision>` or `revisions/<part-number>/<source-revision>`.
An exact record-id link takes precedence over its part-number alias. **View 3D** opens
that source asset read-only, including its citation and build status. This works when
the pack provides no saved definition snapshots. It does not create hub revisions or
imply historical electrical definitions, where-used history or released cable designs.

Each Library model panel shows asset coverage: generated approximation, source model,
missing model or awaiting build; front/back (or board top/bottom) artwork; and the
material data declared in the file. Reflected anchors describe pin placement, not an
invented opposite-side image. Source kind, citation and material presence do not verify
the part match, dimensions, manufacturer accuracy or physical finish. Source bytes and
materials remain unchanged. Where the host has not queried artwork, including source
model previews without revision artwork, coverage says **artwork not inspected**.
