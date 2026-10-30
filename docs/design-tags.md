# Design tags: filtering, grouping and bulk tagging

A design can carry free **tags**: short words such as `Batch 7`, `Phase 1` or `export`. They are part
of the design's working copy (`tags` in the design JSON), so they save, version and show in the
change history like any other edit. Validation rules can select designs by them
([validation rules](validation-rules.md)), and the Designs list filters by them.

Tags, projects and the sourcing route together let a shop see one piece of work as a group. A
contract-manufactured order, for example, can be a project (`Batch 7`) that lists its designs, with
its two build phases as tags (`Phase 1`, `Phase 2`): filter the list by the project to see the whole
order, then add a tag to see one phase.

## A tag

- Letters, digits, spaces, dash, underscore, dot or slash, starting with a letter or digit, at
  most 40 characters (`@wirehub/model` `design-tags.ts`; the `invalid-tags` check).
- At most 50 tags on one design. A tag is kept as written: `Phase 1` and `phase 1` are two tags.
- Set one design's tags in the editor (the Notes panel, **Design tags**, comma-separated), or many
  designs' at once from the Designs list (below).

## The Designs list

Every filter is kept in the address, so a link or a reload opens the same view.

| Filter | Address | Shows |
| --- | --- | --- |
| Text | `q=` | label, id, part numbers, destination, wire, boards, notes, and tags |
| Tags | `tag=` | designs carrying any of the chosen tags |
| Project | `project=` | designs a chosen project lists as items (project ids) |
| Route | `route=` | `make`, `contract` (CM), `buy`, or `none` (the design does not say) |
| Kind | `kind=` | `cable` or `subassembly` (a design without `kind` is a cable; `docs/products.md`) |

The other chips (Source end, Destination end, Wire, Board, Status) work as before. Filters combine:
a design shows when it matches every chip that has a choice, and any of the choices within a chip.
A single value may be written by hand: `/cables?project=batch-7&tag=Phase%201`.

A design's tags show as small chips in the Tags column (once any design has a tag), on the phone
card and in the side panel. The **Tags** column sorts by them.

A project's page lists its designs with their tags, and **Show in Designs** opens the list filtered
to that project.

## Tagging many designs

Tick the designs in the list, or **select N** to tick every design the filter shows (the bar offers
**Select all N matching** again after the filter changes). Then **Add tag…** (a new tag, or one
already in use) or **Remove tag…** (the tags the ticked designs carry, with how many carry each). A
toast says how many designs changed, how many already were as asked, and which were skipped and why.

Tagging is an edit: viewers do not see the tick boxes, and the offline copy of the list is read-only.

## The API

`POST /api/design-tags` adds and removes tags on many designs in one request:

```json
{ "designs": ["lead-a", { "id": "lead-b", "etag": "\"…\"" }], "add": ["Phase 1"], "remove": ["Phase 2"] }
```

- `designs`: 1 to 500 design ids, or `{ id, etag }` to require that version (an `ETag` from
  `GET /api/designs/:id`); repeats are folded.
- `add`, `remove`: lists of tags; at least one tag in all. Added tags are appended in order and never
  duplicated; removal matches exactly. A tag cannot be in both.
- A tag that is not valid refuses the whole request (`422`, an `invalid-tags` issue per tag) and
  nothing is written.

Each design whose tags change is saved through the same path as `PUT /api/designs/:id`: the same
validation, a `design.saved` event (and its [webhook](webhooks.md)) per design, and one change set
for the whole request in the history (`tag 3 designs: +Phase 1`). `?dryRun=1` previews it.

A design the request may not change is **skipped and reported**, and the others are still tagged:

| `reason` | Why |
| --- | --- |
| `not-found` | no such design |
| `locked` | someone else holds an edit lock on it; quote your own lease's token in `x-edit-lock` to tag a design you hold |
| `read-only` | an installed pack's design (fork it to edit) |
| `stale` | the `etag` given is not the current version |
| `invalid`, `refused` | the save was refused (its `error` says why) |

The answer is `200` with every design's result:

```json
{
  "add": ["Phase 1"], "remove": [], "changed": 1, "unchanged": 1, "skipped": 1,
  "results": [
    { "id": "lead-a", "outcome": "changed", "tags": ["Batch 7", "Phase 1"], "etag": "\"…\"" },
    { "id": "lead-b", "outcome": "unchanged", "tags": ["Phase 1"], "etag": "\"…\"" },
    { "id": "lead-c", "outcome": "skipped", "reason": "locked", "error": "Sam is editing it." }
  ]
}
```

It needs the same permission as saving a design: an editor or an owner, or an API token with
`catalog:write` or the draft-work grant `drafts:write`.
