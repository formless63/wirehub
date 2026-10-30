# Linked knowledge: notes, decisions, files and projects

Workshop knowledge sits beside the records it is about. It never copies them.

## Records

- **Note** (`data/knowledge/notes/<id>.json`): `kind` `note` or `decision`, a title, a markdown
  `body`, `links`, `attachments`, optional `tags`, and who/when it was created and last changed. A
  decision also has a `status`: `proposed`, `accepted`, `superseded` or `rejected`. Status is a
  record of what was decided, not an approval step: nothing waits on it.
- **Project** (`data/knowledge/projects/<id>.json`): a title, markdown `summary`, `status`
  (`active`, `paused`, `done`), `items` and its own `attachments`. Its notes are the notes that link
  `project:<id>`.
- **Index** (`data/knowledge/index.json`): one summary per note and project (title, kind/status,
  links, photo hashes, file count, plain text up to 2000 characters). It is written in the same change
  set as the record it summarises. Lists, search and cover candidates read it.

Ids are kebab-case and come from the title (`-2`, `-3` … when taken).

## Item references

A link or project item is the record key the edit locks and history already use:
`design:<id>`, `definition:<kind>:<id>` (`pcbas`, `wires`, `connectors`, `components`,
`mechanicals`, `kits`, `bodies`, `interfaces`), `build:<name>`, `vocab:<list>`, plus
`project:<id>`. Later record types (enclosures, firmware) join by adding their key form. A reference
to a record that no longer exists stays. It is shown as removed, not hidden or rewritten.
Projects group records, not other projects.

## Attachments

An attachment is a shared asset (`data/assets/<sha256>.<ext>`; `studio.asset` + `studio.blob` on
PostgreSQL), uploaded with `POST /api/knowledge/attachments` `{ name, data }` (base64, at most
24 MB) and then named by the note or project. The server decides the type from the bytes: PNG and
JPEG are photos, `%PDF-` is a PDF, a ZIP is a ZIP, and anything else is
`application/octet-stream` (`.bin`; migration 0027). `GET /api/knowledge/files/:sha?name=` always
answers as a download with `nosniff` and a sandboxing content policy.

A photo is stored without its metadata (`server/image-metadata.ts`), losslessly: a JPEG keeps its
frame, tables, scan data, JFIF header, ICC profile and Adobe flag and loses EXIF (GPS, camera,
times, the EXIF thumbnail), XMP, IPTC, comments, other application segments and anything after the
end of the image; its orientation is kept as a fresh one-entry EXIF block. A PNG keeps its picture
and colour chunks only. It fails closed: a photo the walk cannot follow is refused (422) and
nothing is stored, and the result must survive a second strip unchanged. The upload answers with
`metadataRemoved`. Photos stored before this keep what they came with.

A gallery shows `GET /api/knowledge/files/:sha/thumb`: a PNG (longest side 320 px, no metadata)
drawn by the hub's SVG rasteriser with the photo's orientation applied, kept as derived data
(`.thumb-cache/` beside the catalog on files; `derived_blob` cache `thumbnail` on PostgreSQL,
expired by the blob GC once the photo is no longer an asset). The link opens the full photo.

## Photos as covers

A photo on a note that links `definition:pcbas:<id>` is an extra candidate in that board's shared
cover resolver (`GET /api/representations/pcbas/:id`, `specs/depictions.md` §8). It appears after
the native views, so automatic covers are unchanged. Its lineage is the board identity plus the photo
hash. Deleting the note, or the board's revision/build changing, makes a chosen photo unavailable or
stale in the usual way. A photo never replaces geometry or terminal anchors.

## API and seams

`GET /api/knowledge` (the index), `GET /api/knowledge/notes?record=<item>` (full notes linked to an
item, each with its `etag`), `POST /api/knowledge/notes`, `GET|PUT|DELETE /api/knowledge/notes/:id`,
`GET|POST /api/knowledge/projects`, `GET|PUT|DELETE /api/knowledge/projects/:id`. A write runs in the
request's unit of work through the document store, so it behaves the same on files and on
PostgreSQL. A write to an existing note or project needs `If-Match` (428 without, 409 when stale). A
dry run stages and discards. Every save is a change set in the hub history, with the person
attributed, and it raises the catalog event that refreshes open pages. Viewers read. The
role/token gates refuse their writes before the handler, and the handler refuses them again. Notes
are their own records: someone holding a board's edit lock does not lock its notes.

## Markdown

Notes render through a small React renderer, never through an HTML string. It supports headings,
paragraphs, lists and task boxes, quotes, fenced code, rules, inline code, bold, italic and links.
Raw HTML shows as text. Links may be `http(s)`, `mailto` or same-site paths. Images are shown only
from the hub's own `/api/blobs/<sha>`, so nothing loads from elsewhere.

## Search

Quick open (Ctrl K) lists matching **Projects** and **Notes** beside designs and library records.
It uses the same case-insensitive substring match over title, plain text and tags, in the browser.
That matches how quick open already searches. It needs no `pg_trgm` index, because the index
document is loaded whole. Revisit a server-side trigram or full-text index when one hub's notes
outgrow a single document.

## UI

- A **Notes** panel on Library records (under the record's history and revisions), on a design (in
  the inspector column) and on a project page. It lets you add, edit and delete notes. A note can
  link more items, attach photos and files, and preview its markdown.
- **Projects** in the rail: a filterable list, and a project page with its summary/status, items
  grouped by type (with note counts and removed items marked), files and project notes.
