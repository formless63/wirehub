# Workbench UX rules

The rules the studio's screens follow, and where each is enforced. The generic spec of
`apps/studio` (`src/`, `server/`) and `packages/editor-react`. They exist so that a person who
builds cables, not code, can use WireHub without a terminal, and so that no screen leaves
them stuck. Where a rule is a mechanism, the file that holds it is named.

## 1. The shape of the app

| Surface | What it is |
| --- | --- |
| **Rail** (left, 48 px) | section icons (Cables, Library, and the modules' sections) with tooltips, the signed-in person's initials at the bottom |
| **Top bar** | breadcrumb, quick open (Ctrl+K), the cable menu and unsaved marker on a cable's page, the backup indicator, the theme toggle |
| **Cables** | the list of designs (label, destination, wire, boards, parts, joints, product number, status, release state), with a text filter over those fields and every part number a cable answers to |
| **A cable** | the editor with views **Canvas**, **Schematic**, **Documents** and **Artwork**; a status bar with error and warning counts, part and joint counts, and the unsaved state |
| **Library** | `specs/library.md` |
| **Versions** | per cable, `specs/design-versions.md` |
| **History, Jobs, Settings, Part numbers, Modules, Setup** | the hub's own sections |

Selection is in the URL (`/cables/:id`, `/library/:kind/:id`), so every screen is linkable and
the browser's back button is the app's. Light and dark themes follow the system until a person
picks one; the choice is theirs alone.

## 2. The rules

1. **No JSON as the primary UI.** Every record has a structured form. A JSON view exists for
   export, import and the shapes a form deliberately does not cover (a wire stock outside the
   builder's shape); it is the last tab, never the first.
2. **Provenance is an input.** A record cannot be saved without a `src`. The Source field is a
   normal field, not metadata.
3. **Plain-language errors, never a dead end.** Every refusal is a sentence about what
   happened, a hint for what to do next, and, for a validation failure, the validator's own
   issue list (`{ error, hint?, issues? }`). A screen that cannot render a document says why
   and keeps the others working. Nothing says "invalid" without saying what and where.
4. **Validate before write.** A candidate runs through the model's `validateDesign` (and every
   module rule) against the live library; errors answer `422` and nothing touches storage. The
   editor applies the same rule on every edit: a candidate that introduces an error is dropped
   whole, the previous design, issues and layout survive, and the validator's message is shown
   verbatim (`store.ts`, the one door into `state.design`).
5. **Warnings do not block, and they are said out loud.** A cable being built is legitimately
   incomplete. Save lists the warnings and asks for "save anyway" (`explainWarnings`).
6. **Destructive operations need an explicit confirmation.** A delete that takes joints along
   says so ("Delete j1 and its 12 wires?") and is one undo; a delete of a record in use names
   its referrers; replacing the working copy with an old version needs the revision echoed
   back as `confirm`.
7. **Ids are slugs, never paths.** Refused before any store is consulted, and again by the
   store.
8. **Nothing is lost by accident.**
   - Undo and redo cover every edit; one edit is one undo step.
   - Leaving the page with unsaved edits asks first (`useUnsavedChangesGuard`); in-app
     navigation keeps drafts.
   - Replacing a working copy keeps the displaced one as a draft (`specs/design-versions.md`).
   - A write quotes the version it was based on (`If-Match` and an ETag); a stale write is
     refused with `409` and says what changed.
9. **Drafts and saved are never ambiguous.** A document says whether it shows the working
   copy or a saved revision, and the working copy prints UNRELEASED. The chip in the Documents
   view reads Saved, Draft or Unsaved, with one sentence saying what that means for the
   documents.
10. **Documents are derived, never stored.** A document is a pure function of the open design
    and the definition library; the view throws it away and rebuilds it (debounced) whenever
    either changes. Rendering never throws into the screen: a failure is `{ error }` shown in
    place.
11. **No explanatory text on the page where a tooltip will do.** Icons, columns and controls
    carry `title` text; blurbs are one plain sentence for someone who has not met the document
    before.
12. **Per-viewer conveniences stay in the browser.** Column choice, pane width, theme, a
    remembered tab live in local storage, every access guarded, and the screen works at its
    defaults without it. State other people or Claude must see lives in the backend.
13. **Deterministic output.** The same design gives the same document bytes. A date is stamped
    only when the sheet settings ask for it.
14. **Two people, one record.** An edit lock (a short lease, renewed by heartbeat) is taken on
    the first change; a write to a leased record must present the token or is refused with
    `423` naming the holder. The `If-Match` check stays as the backstop for scripts.
15. **Keyboard.** Ctrl+K quick open (works while a text field has focus); in quick open a
    leading `>` lists commands only and Ctrl+Enter opens in a new tab; the Schematic view pans
    with the arrows, zooms with + and -, fits with 0; Ctrl+B folds the Library list.

## 3. The API's side of the rules

The workbench API is one pure function of `(request, deps)` (`apps/studio/server/api.ts`):
no sockets, no files, so the rules can be tested without a server and reused by any transport.
Every host applies the same write rails before a request reaches it (`request-guard.ts`): a body
over 4 MB (24 MB for an artwork upload) is `413` unread, a cross-site write is `403`, and a write
that is not `application/json` (or multipart for an upload) is `415`; a request with no
`Origin` (a script) is allowed. A hub with sign-in on uses the signed-in user and ignores a name
a client sends. Batch calls apply several
writes in one unit and a dry run reports what would change without writing
(`docs/exports.md`, `specs/postgres-backend.md`).

## 4. Testing the rules

Server rules are tested against memory stores without a socket (`apps/studio/test/*.server.test.ts`);
UI rules against a DOM without a browser (`*.dom.test.tsx`); pure logic with no React at all.
A rule that is only visible in a browser is a rule that is not held, so each one above has a
function behind it that a test can call.
