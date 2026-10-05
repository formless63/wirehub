# Design versions

How WireHub saves, locks, releases and replays a design. This is the generic spec of what
the code does today (`packages/model/src/versions.ts`, `apps/studio/server/versions.ts`,
`apps/studio/src/versions/`); every example is from the starter catalog. When SPEC.md
disagrees, SPEC wins.

A design has one **working copy** (`data/designs/<id>.json`, what the editor edits) and any
number of **saved versions**: numbered, locked snapshots that each carry a frozen copy of
every definition they use. A version is what a bench or a purchaser is handed: it renders
the same bytes whatever the Library does afterwards.

## 1. The snapshot

A version is one file (`wirehub/design-version@2`):

| Field | Meaning |
| --- | --- |
| `designId`, `rev` | the design and its revision number |
| `savedAt`, `savedBy`, `note` | when, by whom, and the release note (required) |
| `basedOnRev` | the revision the working copy descended from when this was saved |
| `design` | the `CableDesign`, deep-copied |
| `definitions` | `FrozenDefinitions`: the connectors, bodies, interfaces, wire stocks, components, boards and mechanical parts the design references, each a deep copy, plus the signal-tag rows for those ids |
| `depictions` | per definition id, its artwork files as `name -> sha256:<hex>` (section 3) |
| `unlocked` | present only while an unlock is open: `{ at, by, reason }` |
| `approval` | the latest approval step (section 6); absent means draft |
| `history` | an append-only list of `{ action, at, by, note?, changes? }` |

Only what the design references is frozen (`referencedDefinitionIds`): a version of
`dc-led-lead` carries its terminal block, JST XH housing, resistor, wire stock and
heat-shrink, and nothing else. Kits and vocabulary lists are not frozen; `versionDb` takes
them from the live library, because a version never pins them.

Files are canonical (`canonicalVersionFile`): keys in one fixed order, definitions sorted by id,
two-space JSON, trailing newline. The same inputs always give the same bytes, so a write that
says nothing new leaves the file untouched.

`DESIGN_VERSION_FORMAT_V1` files, which held one hash per definition and no artwork, are still
read and rendered against today's artwork. They are never written.

## 2. Numbering and saving

`POST /api/designs/:id/versions` with `{ note }` saves the working copy as the next revision.

- The number is `latest + 1`. A design's first version takes the numeric revision on its drawing
  sidecar when it has one (the paper already says that number), else `0` (`nextRevision`).
- The note is required. The working copy must validate against the live library with no
  errors (warnings do not block); a failing design answers `422` with the issues and writes
  nothing.
- A working copy identical to the revision it descends from answers `409` ("nothing new to
  release"). "Identical" is `designsDiffer`: a structural comparison of the design bodies.
- A version also validates against its own frozen definitions (`validateVersion`) before it is
  written, so what is stored is always self-consistent.
- After a save the working state records `basedOnRev` (`working.json`), and the drawing
  sidecar's revision is set to the released number, so the title block and the CLI agree.

The editor reads **unreleased changes** from `workingStatus`: the working copy differs from
`basedOnRev`'s design, or nothing is saved yet. The next number to be taken is offered on the
Save version button.

## 3. Frozen definitions and artwork

A saved version is rendered, validated and diffed against its own definitions: `versionDb`
overlays the frozen records over the live library, so a definition that has since been
edited, renamed or deleted does not change the revision. The live library only supplies what
the version never referenced.

Artwork is part of the snapshot. At save time the host copies each referenced definition's
depiction files (`meta.json`, the `.svg` views, raster images) into the version's artwork
store, content-addressed as `<hex>.<ext>` and written once per hash. A later revision that
repeats the same artwork costs nothing. A blob is written before the file that names it, so
a version never points at a missing blob. `GET .../versions/:rev/artwork` serves the copy in
the shape the depiction modules use; a definition whose copy cannot be read back is listed as
`missing` and falls back to the abstract block. `GET .../versions/:rev` also returns
`artworkChanged`: which definitions' artwork differs today from the copy the revision keeps.
The revision still draws its own copy; the list only says the Library has moved on.

## 4. Locking

A saved version is **locked**: it is never overwritten except by a recorded unlock, edit and
re-lock.

1. `POST .../:rev/unlock` with `{ reason }` (required) opens the version for an edit. It
   records `unlocked` and an `unlock` history line; unlocking an unlocked version is `409`.
2. `PUT .../:rev` with `{ design }` saves the edit. A locked version answers `409`
   ("unlock it with a reason first"); a design of another id answers `400`. The edited design
   must validate against the version's definitions plus the live library, or `422`.
3. `editVersion` re-freezes: definitions the version already had stay frozen, a part new to it
   is frozen from the live library, artwork already kept stays the version's own and a new
   part's artwork is copied as it is today. The change is written to history as an `edit`
   line carrying `diffLines`, under the unlock's reason. The version is locked again.
4. `POST .../:rev/lock` re-locks without an edit and records a `relock` line.

An edit that changes content takes the version back to draft: changed content is no longer
what was approved (section 6). The trail stays in `history`.

### Diffs

`diffVersions(before, after)` reports instances added, removed and changed, joints added,
removed and moved, definitions added, removed and changed, and top-level fields. A removed
joint and an added one that share exactly one landing, and are not the same terminal twice,
are one **move** (a re-pin), reported once: `moved w1:core-purple.center@b from j1:15 to j1:4`.
`diffLines` writes the result as short lines: `+` added, `−` removed, `~` changed. The same
function prints the history, the backup commit message, and the Versions panel.

## 5. Releasing, branching, drafts

- **Which revision is released.** `releasedRevision`: with approvals on, the latest *approved*
  revision; with approvals off, the latest saved. Documents are asked for it with
  `?rev=released`, for a number with `?rev=2`, for the latest with `?rev=latest`, and for the
  working copy by leaving `rev` out (`docs/exports.md`).
- **The working copy is marked.** A document rendered from the working copy prints UNRELEASED
  (a diagonal mark on the HTML sheets, the sheet status on the drawing). A saved revision
  prints its number and RELEASED; with approvals on, only an approved one does, and it names
  its approver. Anything else prints UNRELEASED or UNAPPROVED.
- **New version from this.** `POST .../:rev/branch` with `{ confirm: <rev> }` makes an old
  revision the working copy. The working copy it displaces, if it differs, is kept as a
  **draft** (`drafts/<n>.json`, with who, when and why) so nothing is lost. The old design
  must still validate against the *current* library, or the branch is refused with the
  problems listed. `POST .../drafts/:n/restore` with `{ confirm: <n> }` brings a draft back
  the same way.
- **Rename.** A design rename moves its version directory with it and rewrites each snapshot's
  `designId` and `design.id`.

## 6. Approval

When the hub turns release approvals on (Settings, Release approvals) a saved version is a
draft until someone approves it:

| Step | Who | Needs | Effect |
| --- | --- | --- | --- |
| `submit` | an editor or above | a comment | `approval.state = submitted`; a rejected version may be submitted again |
| `approve`, `reject` | a role listed in the hub's approver roles | a comment | records `by`, `at`, `comment`, and the submitter |

`approvalStepProblem` refuses a step that does not fit: an unlocked version, a version already
awaiting approval or already approved, a decision on one that was not submitted. A viewer
can do none of them (`403`). Every step is a `history` line, so the trail is complete even
after `approval` shows only the latest step. With approvals off the endpoints answer `409`.

## 7. Storage

The file backend keeps `data/designs/_versions/<id>/<rev>.json`, `working.json`
(`{ basedOnRev }`), `drafts/<n>.json` and `artwork/<hex>.<ext>`. The Postgres backend keeps
the same paths in its document tree (`specs/postgres-backend.md`); both sit behind one
`VersionStore` interface, so the routes do not know which they have. `memoryVersionStore` serves tests and
read-only hosts.

## 8. Edit locks are a different thing

A version's lock is about **released content**. An **edit lock** (`apps/studio/server/locks`)
is a short lease on a *record* (a design's working copy, a definition) so two people do not
edit it at once: acquired when the first change is made, renewed by heartbeat every 15 s, and
lapsing 60 s after the last one. A write to a leased record must present the lease's token or
it is refused (`423`, naming the holder); a record nobody holds is written as before, and the
`If-Match` check stays as the backstop. The two never interact: unlocking a version does not
take an edit lock.

## 9. API

```
GET    /api/designs/:id/versions                     list, working status, drafts
GET    /api/designs/:id/versions/:rev                one version (with artworkChanged)
GET    /api/designs/:id/versions/:rev/artwork        the copied artwork
POST   /api/designs/:id/versions                     { note }
PUT    /api/designs/:id/versions/:rev                { design }   an unlocked version's edit
POST   /api/designs/:id/versions/:rev/unlock         { reason }
POST   /api/designs/:id/versions/:rev/lock
POST   /api/designs/:id/versions/:rev/submit|approve|reject   { comment }
POST   /api/designs/:id/versions/:rev/branch         { confirm: rev }
POST   /api/designs/:id/versions/drafts/:n/restore   { confirm: n }
```

Every refusal is `{ error, hint? , issues? }` in sentences (`specs/workbench-ux.md`).
