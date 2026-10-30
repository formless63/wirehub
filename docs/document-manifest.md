# Released document manifest

A locked saved revision's whole document package as one JSON answer: every document and export
it comes with, the URL that downloads each one, and the exact SHA-256 of the bytes that URL
returns. A receiver (an ERP, a PLM, a document control system) checks one hash, `packageHash`,
to decide whether anything changed, and downloads only what it needs. Code:
`apps/studio/server/document-manifest.ts` and `document-cache.ts`.

```
GET /api/designs/:id/versions/:rev/documents
```

`:rev` is a revision number, `latest`, or `released` (the latest approved revision when release
approvals are on, else the latest saved). The answer and every URL in it use the number. There
is no query. Viewers and `read` API tokens may call it. A revision that does not exist is a 404;
one that is unlocked for an edit is a 409 (its documents can still change: lock it first).

```json
{
  "format": "wirehub.document-manifest", "version": 1,
  "design": { "id": "lead-a", "label": "Synthetic lead A", "productRef": "EXAMPLE-0001" },
  "rev": 3, "locked": true, "released": true,
  "approval": { "state": "approved", "at": "2026-10-05T14:03:11.000Z", "by": "Olive Owner" },
  "savedAt": "2026-10-05T12:00:00.000Z", "versionEtag": "\"9f2c…\"",
  "packageHash": "sha256:5b1e…",
  "documents": [
    { "name": "documents/drawing.pdf", "source": "document", "kind": "drawing", "format": "pdf",
      "url": "https://hub.example/api/designs/lead-a/documents/drawing?format=pdf&rev=3",
      "mediaType": "application/pdf", "fileName": "lead-a-rev3-drawing.pdf", "size": 120334,
      "sha256": "<64 hex>", "renderKey": "<64 hex>", "renderer": "browser" },
    { "name": "exports/bom.csv", "source": "export", "kind": "bom.csv", "format": "csv",
      "url": "https://hub.example/api/designs/lead-a/exports/bom.csv?rev=3", "mediaType": "text/csv; charset=utf-8",
      "fileName": "lead-a-rev3-bom.csv", "size": 2211, "sha256": "…", "renderKey": "…" }
  ],
  "unavailable": [{ "name": "exports/wire-list.csv", "reason": "…" }],
  "links": { "version": "…/versions/3", "inputs": "…/versions/3/inputs", "package": "…/api/repro/designs/lead-a/3/package" }
}
```

- **Entries.** Every document kind in every format it comes in (`docs/exports.md`, "API"),
  except `csv` (the same data as the exports) and the label sheet's `png` and `lbx` (prints for
  one printer); then every base export (`GET /api/exports`). Module exporters are not listed.
  Order: the document kinds in their usual order, each in its format order, then the exports.
  Something that cannot be made for this design (no wires, no labels …) is in `unavailable`
  with the reason instead.
- `approval` is present when the revision has been through a release approval step; `released`
  says whether this is the revision `released` resolves to. `productRef` is present when the
  design has one. `renderer` is present on PDFs (`browser`, `text-layout`, `raster`, `vector`).
- **URLs** are absolute when the hub knows its public address (`WIREHUB_PUBLIC_URL`), else paths.
  `fileName` is the name the download carries (`Content-Disposition`).

## Hashes

- `sha256` is the hex SHA-256 of the exact bytes the entry's `url` returns.
- `packageHash` is `sha256:` + the SHA-256 of the stable JSON (keys sorted, no spaces) of the
  `[name, sha256]` pairs sorted by name. URLs and render keys are left out, so the same files
  under another address hash the same. Use it as an idempotency key: an unchanged hash means
  nothing to fetch.
- `versionEtag` is the content tag of the saved version file, approval included.

## Stable renders: first render wins

A revision's documents do not move once made. Each one is stored under a **render key** the first
time it is rendered, and served from the store afterwards:

```
renderKey = sha256(stableJson({ key: 'wirehub.render-key/1', cache: DOCUMENT_CACHE_VERSION,
  design, rev, version: <the version file's tag, approval included>, name,
  drawing: <the drawing sidecar's tag, without its revision field, with the photo's hash>,
  branding: <the branding and documents settings' tag>, engineering: <the effective test defaults' tag>,
  approvalsOn, pdfEngine: 'browser' | 'none', modules: ['<id>@<version>', …] }))
```

So approving a revision, changing the title block or branding, turning release approvals on, or
configuring a PDF engine renders it again (new keys, new hashes where the bytes differ); saving a
newer revision, editing the working copy or the live library, and upgrading the hub do not. The
hub's own version and the live library are left out on purpose: a revision renders from its
frozen definitions and copied artwork, and the first render is the one a receiver may already
have. `DOCUMENT_CACHE_VERSION` (`document-cache.ts`) is bumped on purpose when a change to the
renderers should reach saved revisions.

Revision renders print the release date in a date stamp (the approval's date when approved, else
when the version was saved), never today's, and leave out part-number proposals for unnumbered
parts (those read today's numbering).

## The document routes

`GET /api/designs/:id/documents/:kind?rev=…&format=…` and `GET /api/designs/:id/exports/:id?rev=…`
with nothing else in the query (the manifest's URLs) are served through the same store, with:

| Header | Value |
| --- | --- |
| `ETag` | `"sha256:<hex>"` |
| `X-WireHub-Content-SHA256` | `<hex>` |
| `X-WireHub-Render-Key` | `<hex>` |
| `X-WireHub-PDF-Renderer`, `X-WireHub-PDF-Fallback` | as stored with the render |

`If-None-Match` with the ETag answers `304 Not Modified`. Any other option (`paper=`, `page=`,
`variation=` …) renders per request as before, without these headers. A missing render is made
when it is asked for (there is no warm-up job on release).

## Where renders are kept

- **Files:** `packages/catalog/data/.document-cache/<aa>/<key>.json` (media type, file name,
  renderer, when) and `<key>.bin` (the bytes); gitignored, never part of the catalog.
- **Postgres:** a derived blob: `derived_blob` with `cache = 'document'`, `key` = the render key,
  `part = ''`, `builder_version = DOCUMENT_CACHE_VERSION`, and `inputs`
  `[{kind:'design-revision', ref:'<id>@<rev>'}, {kind:'meta', mediaType, fileName, renderer?, fallback?, renderedAt}]`;
  the bytes are a `derived` blob (not backed up; they can always be rendered again, though a
  re-render may differ in bytes, which is why the first one is kept). The blob GC keeps these
  rows until `DOCUMENT_CACHE_VERSION` changes. Without a blob store the file cache is used.

Renders are derived data: never in `GET /api/export`.

## Webhooks

`version.*` events that name a revision carry `fetch.documents`, this manifest's URL
(`docs/webhooks.md`). The design-version package (`GET /api/repro/designs/:id/:rev/package`,
linked as `links.package`) holds the version file, its effective inputs and the text exports.
