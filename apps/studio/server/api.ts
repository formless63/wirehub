/**
 * The workbench API — request in, response out, no IO.
 *
 * Every endpoint under `/api/` is handled by `handleWorkbenchRequest`, a pure
 * function of `(request, deps)`. The Vite plugin in `plugin.ts` is the only
 * part that knows about sockets; this file is the only part that knows the
 * rules. That split is what lets the whole surface be tested without a server,
 * and what lets the future ERP host reuse the rules with its own transport.
 *
 * The rules the spec fixes (specs/studio-workbench.md, "Architecture"):
 *
 * 1. **Validate before write.** Every candidate runs through the model's
 *    `validateDesign` (and every registered module rule) against the live definition db. Errors → 422 with the
 *    issue list; nothing touches disk.
 * 2. **Ids are slugs, never paths.** A request naming `../../etc/passwd` is
 *    refused before the store is consulted (and the store refuses it again).
 * 3. **Destructive operations need an explicit confirm token** from the UI.
 * 4. **`src` is required.** Provenance is an input, not an afterthought.
 *
 * Errors are written for a person: `error` is a sentence about what happened,
 * `hint` is what to do next, and `issues` (422 only) is the validator's own
 * list, which the GUI renders in plain language. Nothing here ever dead-ends.
 */

import { isDesignId, type DesignId } from '@wirehub/catalog';
import { designChangeLines, errors, isReadableSchemaVersion, upgradeDesignSchema, validateDesign, type CableDesign, type Db, type Issue } from '@wirehub/model';
import type { ModuleRegistry } from '@wirehub/modules';

import { cableListEntry, type CableListContext, type CableListEntry, type CableListPnContext } from '../src/cable-list.ts';
import { assetSummaryWithDataUri, isImageAsset, isModelAsset, type AssetStore } from './assets.ts';
import type { ConvertedModel } from './models/convert.ts';
import type { ModelLinkStore } from './models/links.ts';
import type { ModelCache } from './models/cache.ts';
import { cachedModelFile, handleModelRequest, isModelPath, modelDepsOf, MODEL_ROUTES } from './models/api.ts';
import { BUILDS_ROUTES, handleBuildsRequest, type BuildsStore } from './builds.ts';
import type { DefinitionStore } from './definition-store.ts';
import { DEFINITION_ROUTES, handleDefinitionRequest } from './definitions.ts';
import { readDrawingMeta, readPhoto, type DrawingStore } from './drawings.ts';
import type { DesignStore } from './designs.ts';
import { handleWireLibraryRequest, WIRE_LIBRARY_ROUTES, type WireLibraryStore } from './wire-library.ts';
import { checkIfMatch, contentETag, staleWriteResponse } from './etag.ts';
import { VOCAB_ROUTES, handleVocabRequest } from './vocab.ts';
import { VERSION_ROUTES, handleVersionRequest, workingStatus, type VersionStore } from './versions.ts';
import { LOCAL_FALLBACK, ME_ROUTES, type StudioUser } from './me.ts';
import { BACKUP_DISABLED, type BackupControl } from './backup/status.ts';
import type { TagStore, VocabStore } from './vocab-store.ts';
import { LOCK_ROUTES } from './locks/lock-api.ts';
import type { LockStore } from './locks/lock-store.ts';
import type { DerivedStore } from './derived.ts';
import { ReadOnlyBackendError, StaleRecordError, type Awaitable, type ChangeSet, type CommitResult, type DerivedKind } from './storage/change-set.ts';
import { UnitOfWork } from './storage/unit-of-work.ts';
import { withWriteLock } from './storage/write-lock.ts';
import { handleSetupRequest, isSetupPath, type SetupDeps } from './setup.ts';
import { isWriteMethod } from './request-guard.ts';
import type { CatalogExport } from './pg/export.ts';

/* ------------------------------------------------------------------ *
 * Transport-shaped, transport-free
 * ------------------------------------------------------------------ */

export interface ApiRequest {
  method: string;
  /** the path as requested, `/api` prefix included */
  path: string;
  /** the parsed JSON body, when the request carried one */
  body?: unknown;
  /**
   * Request headers this router reads, lower-cased keys. Currently just
   * `if-match` (the stale-write guard,) — everything else
   * an adapter receives from the socket stops at the adapter.
   */
  headers?: Record<string, string>;
  /**
   * The signed-in person, when the host has a login and a session
   *. Absent → `deps.localUser`.
   */
  user?: StudioUser;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /**
   * Raw bytes instead of JSON (a stored file, `GET /api/assets/:id`) — the
   * adapters send these as they are, with `contentType`.
   */
  bytes?: Uint8Array;
  contentType?: string;
  /**
   * Response headers an adapter should forward verbatim — today just `ETag`,
   * the version a caller echoes back as `If-Match` on its next write.
   */
  headers?: Record<string, string>;
  /**
   * What a design save changed, as change-log lines (`designChangeLines`:
   * joints added / removed / moved with the note a re-pin cleared, parts
   * added / removed / changed). Server-side only — never sent to the
   * client; the backup commit lists them under its subject
   *.
   */
  changes?: string[];
}

export interface WorkbenchDeps {
  designs: DesignStore;
  /** the definition library every candidate is validated against */
  loadDb: () => Awaitable<Db>;
  /**
   * A token that changes whenever the stored catalog does (storage seams,
   *). Given one, the unit of work loads `loadDb()` once
   * per catalog version instead of once per request. Absent: every request
   * loads its own.
   */
  catalogVersion?: () => Awaitable<string | undefined>;
  /**
   * The on-demand export (`GET /api/export`): the catalog as file text, the
   * same on every backend (`pg/export.ts`). Absent → 501.
   */
  exportCatalog?: () => Promise<CatalogExport>;
  /**
   * Commit a request's change set in the backend's own transaction (the
   * Postgres backend, `pg/`). Absent: `commitChangeSet` applies it through
   * the stores above (the file backend).
   */
  commit?: (set: ChangeSet, derive: ReadonlySet<DerivedKind>) => Promise<CommitResult>;
  /**
   * The derived records the commit recomputes when a save changes their inputs
   * (a module's reports and exports — `derived.ts`). Absent: none.
   */
  derived?: DerivedStore;
  /**
   * The four editable catalog files, when this host lets definitions be
   * edited. Optional so a read-only host — or a test that only cares about
   * designs — can leave it out; `/api/definitions` then says so in words.
   */
  definitions?: DefinitionStore;
  /** drawing-sheet sidecars; optional so a design-only host can leave it out */
  drawings?: DrawingStore;
  /**
   * The part-number configuration as stored, unparsed (the catalog's
   * `part-numbers.json`) — for `GET /api/part-numbers`, so the browser's PN
   * suggest reads today's file.
   */
  loadPartNumberFiles?: () => Awaitable<PartNumberFiles>;
  /**
   * The shared, content-addressed image asset store
   * — what the drawing photo picker lists and dedupes against. Optional so a
   * design-only host can leave it out; `GET /api/assets` then says so.
   */
  assets?: AssetStore;
  /**
   * Which stored 3D model each Library record shows (
   * `data/models.json`); the bytes are in `assets`. Optional like the rest —
   * absent, `/api/models` says so.
   */
  modelLinks?: ModelLinkStore;
  /**
   * The generated cache of imported models (`models/cache.ts`,
   * `data/.model-cache/`, gitignored): `GET /api/assets/:id` serves from it
   * what the asset store does not hold.
   */
  modelCache?: ModelCache;
  /** STL/STEP/GLB → the stored GLB; injectable for tests (the real one forks the STEP child) */
  convertModel?: (bytes: Uint8Array, name: string) => Promise<ConvertedModel>;
  /** the controlled lists (`data/vocab/*.json`); optional so a read-only host can leave it out */
  vocab?: VocabStore;
  /**
   * The generated tag table and the review file it is built from
   * (`data/tags/*`). Given one, every definition write rebuilds the table, so
   * it never goes stale behind a Library save.
   */
  tags?: TagStore;
  /** the wire parts library and stock recipes (pci.17); optional like the rest */
  wireLibrary?: WireLibraryStore;
  /** the board build files (`data/builds/*.json`, pci.10); optional like the rest */
  builds?: BuildsStore;
  /** today, YYYY-MM-DD, for a record's date (injected by tests) */
  today?: () => string;
  /**
   * Saved, locked design versions (
   * `data/designs/_versions/`); optional like the rest.
   */
  versions?: VersionStore;
  /** now, as an ISO time stamp, for a version's `savedAt` (injected by tests) */
  now?: () => string;
  /** who is using a studio without a login (`WIREHUB_LOCAL_USER`, else git's user.name) */
  localUser?: StudioUser;
  /**
   * The optional git export (`WIREHUB_GIT_AUTOCOMMIT=true` on the standalone
   * server). Absent → `GET /api/backup` answers "off".
   */
  backup?: BackupControl;
  /**
   * Edit locks: the lease table the transports'
   * lock layer (`locks/lock-api.ts`) reads before a request reaches this
   * router. Absent → no locks; writes are guarded by If-Match alone.
   */
  locks?: LockStore;
  /** now, epoch ms, for lease times (injected by tests) */
  lockClock?: () => number;
  /**
   * The deployment's modules (`modules.config.ts`, `docs/modules.md`): their
   * validation rules run with `validateDesign`, their integrations answer
   * under `/api/modules/<id>/…`. Absent → none.
   */
  modules?: ModuleRegistry;
  /**
   * First-run setup (`setup.ts`): where domain modules' packs are installed
   * and the selection is kept. Absent → `/api/setup` answers 501.
   */
  setup?: SetupDeps;
}

/** `GET /api/part-numbers`' file half; `designs` and `drawings` come from the stores. */
export interface PartNumberFiles {
  /** `part-numbers.json`, or absent (the scheme's defaults) */
  scheme?: unknown;
}

/** The error body every failing endpoint returns. */
export interface ApiError {
  error: string;
  hint?: string;
  /** the validator's own findings — 422 only */
  issues?: Issue[];
}

function fail(status: number, error: string, hint?: string, issues?: Issue[]): ApiResponse {
  const body: ApiError = { error, ...(hint === undefined ? {} : { hint }) };
  if (issues !== undefined) body.issues = issues;
  return { status, body };
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): ApiResponse {
  return { status, body, ...(headers === undefined ? {} : { headers }) };
}

/* ------------------------------------------------------------------ *
 * Shared checks
 * ------------------------------------------------------------------ */

const ID_RULE =
  'Ids are lowercase words joined by hyphens, like `rj45-patch-t568b` — no spaces, capitals, dots or slashes.';

function badId(value: unknown, what: string): ApiResponse {
  return fail(
    400,
    `${JSON.stringify(String(value))} cannot be used as ${what}.`,
    ID_RULE,
  );
}

function notFound(id: string): ApiResponse {
  return fail(
    404,
    `There is no design called '${id}'.`,
    'Pick one from the design list, or make a new one with New.',
  );
}

function alreadyExists(id: string): ApiResponse {
  return fail(
    409,
    `A design called '${id}' already exists.`,
    `Choose a different id, or open '${id}' and edit it instead.`,
  );
}

/**
 * The structural gate an untrusted body passes before the validator sees it.
 *
 * `validateDesign` answers "is this cable buildable"; it assumes it was handed
 * a design. This answers "is this a design at all", in the same plain voice —
 * a truncated upload or a pasted definition file should say so, not throw.
 */
export function readDesignBody(value: unknown): { ok: true; design: CableDesign } | { ok: false; response: ApiResponse } {
  const say = (error: string, hint: string): { ok: false; response: ApiResponse } => ({
    ok: false,
    response: fail(400, error, hint),
  });

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return say(
      'That is not a cable design document.',
      'The body of this request has to be a single design object.',
    );
  }
  const candidate = value as Partial<CableDesign>;
  if (!isReadableSchemaVersion(candidate.schemaVersion)) {
    return say(
      `This document says it is schema version ${JSON.stringify(candidate.schemaVersion)}, and this studio reads versions 1 to 4.`,
      'It was probably written by a different (or much older) version of the tool.',
    );
  }
  if (!isDesignId(candidate.id)) {
    return say(
      `${JSON.stringify(String(candidate.id))} cannot be used as this design's id.`,
      ID_RULE,
    );
  }
  if (typeof candidate.label !== 'string' || candidate.label.trim() === '') {
    return say(
      'This design has no name.',
      'Give it a label — the sentence a builder would read at the top of the build sheet.',
    );
  }
  if (typeof candidate.src !== 'string' || candidate.src.trim() === '') {
    return say(
      'This design does not say where its information comes from.',
      'Fill in "Where does this information come from?" — a document, a measurement, or a note that the values were inferred.',
    );
  }
  const instances = candidate.instances;
  if (
    typeof instances !== 'object' ||
    instances === null ||
    !Array.isArray(instances.connectors) ||
    !Array.isArray(instances.segments) ||
    !Array.isArray(instances.components) ||
    !Array.isArray(instances.pcbas)
  ) {
    return say(
      'This design is missing its parts list.',
      'A design needs connectors, segments, components and pcbas lists, even when some of them are empty.',
    );
  }
  if (!Array.isArray(candidate.joints)) {
    return say(
      'This design is missing its joints list.',
      'A design with nothing soldered yet still needs an empty joints list.',
    );
  }
  // an older document (a tab opened before the migration, an imported file)
  // is stored at the one current version (migrate-schema.ts, 50a.49)
  return { ok: true, design: upgradeDesignSchema(value as CableDesign).design };
}

/**
 * Rule 1, in one place: a candidate that the validator finds errors in is
 * refused with those errors, and the caller never gets as far as the store.
 * Warnings do not block a save — a design can be legitimately incomplete
 * while it is being built up, and refusing to store work in progress would
 * push the user back to a text editor, which is exactly what this API exists
 * to make unnecessary.
 */
function validated(design: CableDesign, db: Db, modules?: ModuleRegistry): ApiResponse | undefined {
  const issues = [...validateDesign(design, db), ...(modules?.validate(design, db) ?? [])];
  const failures = errors(issues);
  if (failures.length === 0) return undefined;
  return fail(
    422,
    failures.length === 1
      ? `'${design.id}' has a problem that has to be fixed before it can be saved.`
      : `'${design.id}' has ${failures.length} problems that have to be fixed before it can be saved.`,
    'Nothing was written — the stored design is untouched. Fix the problems listed below and save again.',
    issues,
  );
}

/** `{ newId, newLabel }`, the body duplicate and rename share. */
function readMoveBody(
  value: unknown,
  action: string,
): { ok: true; newId: DesignId; newLabel: string | undefined } | { ok: false; response: ApiResponse } {
  const body = (typeof value === 'object' && value !== null ? value : {}) as {
    newId?: unknown;
    newLabel?: unknown;
  };
  if (!isDesignId(body.newId)) {
    return {
      ok: false,
      response: fail(
        400,
        `${JSON.stringify(String(body.newId))} cannot be used as the new id.`,
        `${ID_RULE} Pick a name for the ${action} and try again.`,
      ),
    };
  }
  if (body.newLabel !== undefined && (typeof body.newLabel !== 'string' || body.newLabel.trim() === '')) {
    return {
      ok: false,
      response: fail(
        400,
        'The new name is empty.',
        'Give the design a label — the sentence a builder would read at the top of the build sheet.',
      ),
    };
  }
  return {
    ok: true,
    newId: body.newId,
    newLabel: typeof body.newLabel === 'string' ? body.newLabel : undefined,
  };
}

/* ------------------------------------------------------------------ *
 * Endpoints
 * ------------------------------------------------------------------ */

/**
 * The cable list needs more than `DesignStore.list()`'s id+label — see
 * `cable-list.ts`. Reading each design back is one extra file read per design
 * (`list()` already read every one once, for its label); at the catalog's
 * current and near-future size that is cheaper than teaching `DesignStore` a
 * second, richer listing shape for one caller.
 */
async function getDesigns(deps: WorkbenchDeps): Promise<ApiResponse> {
  const db = await deps.loadDb();
  let wireVendors: Record<string, string> | undefined;
  try {
    const recipes = (await deps.wireLibrary?.read())?.recipes;
    // one db read for the whole list (was one per recipe)
    const makers = new Map((db.vocab?.manufacturers?.entries ?? []).map((e) => [e.id, e.label] as const));
    wireVendors = recipes === undefined ? undefined : Object.fromEntries(recipes.flatMap((r) => (r.manufacturer === undefined ? [] : [[r.id, makers.get(r.manufacturer) ?? r.manufacturer]])));
  } catch {
    wireVendors = undefined;
  }
  const listContext: CableListContext = wireVendors === undefined ? {} : { wireVendors };
  const designs: CableListEntry[] = [];
  for (const summary of await deps.designs.list()) designs.push(await listRow(summary));
  return ok({ designs });

  async function listRow(summary: { id: string; label: string }): Promise<CableListEntry> {
    const design = await deps.designs.read(summary.id);
    // gone between the list() read and this one (a concurrent delete) — a
    // plain fallback row beats dropping it from the count silently
    if (design === undefined) {
      return {
        id: summary.id,
        label: summary.label,
        status: 'active',
        source: summary.label,
        destination: '',
        destinationMain: '',
        destinationShort: '',
        wires: [],
        features: [],
        wireLabels: [],
        boardLabels: [],
        partCount: 0,
        jointCount: 0,
        partNumbers: [],
        partNumber: { basis: 'none', note: 'No part number assigned yet' },
      };
    }
    // the drawing's PN and lengths and the parts' PNs make the row findable by part number
    let drawing: CableListPnContext['drawing'];
    try {
      drawing = (await deps.drawings?.read(summary.id))?.meta;
    } catch {
      drawing = undefined;
    }
    const entry = cableListEntry(design, db, {
      ...listContext,
      ...(drawing === undefined ? {} : { drawing }),
    });
    if (deps.versions === undefined) return entry;
    // the release chip: current saved rev + unreleased changes
    const release = await workingStatus(deps, summary.id, design);
    return {
      ...entry,
      ...(release.basedOnRev === undefined ? {} : { rev: release.basedOnRev }),
      unreleased: release.unreleased,
    };
  }
}

async function getDesign(deps: WorkbenchDeps, id: DesignId): Promise<ApiResponse> {
  const design = await deps.designs.read(id);
  return design === undefined ? notFound(id) : ok(design, 200, { ETag: contentETag(design) });
}

/**
 * Validate-then-write. The id in the path is the one that counts.
 *
 * Stale-write guard ( absorbing): a
 * caller that sends `If-Match` is asking "is this still the version I loaded?"
 * — read the version on disk *right now*, before validating or writing
 * anything, and refuse with 409 the moment it disagrees. A caller that sends
 * nothing is refused with 428: it cannot know what it would overwrite.
 */
async function putDesign(deps: WorkbenchDeps, id: DesignId, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const parsed = readDesignBody(body);
  if (!parsed.ok) return parsed.response;
  if (parsed.design.id !== id) {
    return fail(
      400,
      `This save is for '${id}', but the document says its id is '${parsed.design.id}'.`,
      "Use Rename to change a design's id — saving cannot move it.",
    );
  }
  const current = await deps.designs.read(id);
  if (current === undefined) return notFound(id);
  const guard = checkIfMatch(ifMatch, contentETag(current), 'design', id);
  if (guard !== undefined) return guard;

  const rejection = validated(parsed.design, await deps.loadDb(), deps.modules);
  if (rejection !== undefined) return rejection;

  await deps.designs.write(id, parsed.design);
  const stored = await deps.designs.read(id);
  const changes = designChangeLines(current, stored ?? parsed.design);
  return {
    ...ok(stored, 200, stored === undefined ? undefined : { ETag: contentETag(stored) }),
    ...(changes.length === 0 ? {} : { changes }),
  };
}

async function postDesign(deps: WorkbenchDeps, body: unknown): Promise<ApiResponse> {
  const parsed = readDesignBody(body);
  if (!parsed.ok) return parsed.response;
  const id = parsed.design.id;
  if (await deps.designs.has(id)) return alreadyExists(id);

  const rejection = validated(parsed.design, await deps.loadDb(), deps.modules);
  if (rejection !== undefined) return rejection;

  await deps.designs.write(id, parsed.design);
  const created = await deps.designs.read(id);
  return ok(created, 201, created === undefined ? undefined : { ETag: contentETag(created) });
}

async function duplicateDesign(deps: WorkbenchDeps, id: DesignId, body: unknown): Promise<ApiResponse> {
  const source = await deps.designs.read(id);
  if (source === undefined) return notFound(id);
  const move = readMoveBody(body, 'copy');
  if (!move.ok) return move.response;
  if (await deps.designs.has(move.newId)) return alreadyExists(move.newId);

  const copy: CableDesign = {
    ...source,
    id: move.newId,
    label: move.newLabel ?? `${source.label} (copy)`,
    // provenance travels with the facts: the copy states its own descent so a
    // reader is never left guessing where the numbers came from
    src: `${source.src} — duplicated from design '${id}' in the studio workbench.`,
  };
  const rejection = validated(copy, await deps.loadDb(), deps.modules);
  if (rejection !== undefined) return rejection;

  await deps.designs.write(move.newId, copy);
  const created = await deps.designs.read(move.newId);
  return ok(created, 201, created === undefined ? undefined : { ETag: contentETag(created) });
}

/**
 * Rename = write the new file, then remove the old one, in that order: an
 * interruption between the two leaves both copies rather than none.
 */
async function renameDesign(deps: WorkbenchDeps, id: DesignId, body: unknown, ifMatch: string | undefined): Promise<ApiResponse> {
  const source = await deps.designs.read(id);
  if (source === undefined) return notFound(id);
  const guard = checkIfMatch(ifMatch, contentETag(source), 'design', id);
  if (guard !== undefined) return guard;
  const move = readMoveBody(body, 'design');
  if (!move.ok) return move.response;
  if (move.newId !== id && await deps.designs.has(move.newId)) return alreadyExists(move.newId);

  const renamed: CableDesign = {
    ...source,
    id: move.newId,
    ...(move.newLabel === undefined ? {} : { label: move.newLabel }),
  };
  const rejection = validated(renamed, await deps.loadDb(), deps.modules);
  if (rejection !== undefined) return rejection;

  if (move.newId !== id && ((await deps.versions?.revisions(move.newId))?.length ?? 0) > 0) {
    return fail(409, `'${move.newId}' still has saved versions from an earlier design.`, 'Choose a different id.');
  }
  await deps.designs.write(move.newId, renamed);
  if (move.newId !== id) {
    await deps.designs.remove(id);
    // the drawing details belong to the cable, whatever it is called now
    await deps.drawings?.move(id, move.newId);
    // …and so do its released revisions
    await deps.versions?.move(id, move.newId);
  }
  const stored = await deps.designs.read(move.newId);
  return ok(stored, 200, stored === undefined ? undefined : { ETag: contentETag(stored) });
}

/**
 * Rule 3: a delete carries the id back as a confirm token, so a stray request
 * — a double-click, a replayed fetch, a script with the wrong variable — cannot
 * remove a design on its own.
 *
 * There is no referential check here because nothing in the catalog references
 * a design: designs point at definitions, never at each other. The definition
 * editors this epic adds next *will* need one (a connector is referenced by
 * every design that uses it), and it belongs in their handler, phrased the same
 * way: name the referrers.
 */
async function deleteDesign(deps: WorkbenchDeps, id: DesignId, body: unknown): Promise<ApiResponse> {
  if (!await deps.designs.has(id)) return notFound(id);
  const confirm = (typeof body === 'object' && body !== null ? (body as { confirm?: unknown }).confirm : undefined);
  if (confirm !== id) {
    return fail(
      400,
      `Deleting '${id}' has to be confirmed.`,
      `Nothing was deleted. Confirm by sending the design's own id ('${id}') back as the confirmation.`,
    );
  }
  const released = await deps.versions?.revisions(id) ?? [];
  if (released.length > 0) {
    return fail(
      409,
      `'${id}' has ${released.length === 1 ? 'a saved version' : `${released.length} saved versions`} (Rev ${released.join(', ')}), so it cannot be deleted.`,
      "Released revisions are kept for good. Set the cable's status to Retired instead.",
    );
  }
  await deps.designs.remove(id);
  await deps.drawings?.remove(id);
  return ok({ deleted: id });
}

/* ------------------------------------------------------------------ *
 * Drawing sidecars
 * ------------------------------------------------------------------ */

async function drawingRequest(
  method: string,
  id: string,
  action: string | undefined,
  rest: string[],
  body: unknown,
  deps: WorkbenchDeps,
  ifMatch: string | undefined,
): Promise<ApiResponse> {
  if (!isDesignId(id)) return badId(id, 'a design id');
  if (deps.drawings === undefined) {
    return fail(501, 'This studio does not keep drawing details.', 'The drawing sheet still renders; its title block just cannot be saved here.');
  }
  if (!await deps.designs.has(id)) {
    return fail(404, `There is no design called '${id}' to keep drawing details for.`, 'Save the design first, then its drawing details.');
  }
  const drawings = deps.drawings;
  // one version per sidecar (meta + photo): either save must quote it
  const tagOf = async (): Promise<Record<string, string>> => ({ ETag: contentETag(await drawings.read(id)) });
  if (action === undefined) {
    if (method === 'GET') return ok(await drawings.read(id), 200, await tagOf());
    if (method !== 'PUT') return methodNotAllowed(method, ['GET', 'PUT']);
    const guard = checkIfMatch(ifMatch, contentETag(await drawings.read(id)), 'drawing', id);
    if (guard !== undefined) return guard;
    const parsed = readDrawingMeta(body);
    if (!parsed.ok) {
      return fail(422, 'Those drawing details could not be saved.', `Nothing was changed. ${parsed.problems.join(' ')}`);
    }
    await drawings.writeMeta(id, parsed.meta);
    return ok(parsed.meta, 200, await tagOf());
  }
  if (action === 'photo' && rest.length === 0) {
    if (method !== 'PUT') return methodNotAllowed(method, ['PUT']);
    const guard = checkIfMatch(ifMatch, contentETag(await drawings.read(id)), 'drawing', id);
    if (guard !== undefined) return guard;
    const parsed = readPhoto(body);
    if (!parsed.ok) return fail(422, 'That photo could not be saved.', `Nothing was changed. ${parsed.problem}`);
    await drawings.writePhoto(id, parsed.photo);
    const stored = await drawings.read(id);
    return ok(stored.photo === undefined ? {} : { photo: stored.photo }, 200, await tagOf());
  }
  return fail(404, `/api/drawings/${id}/${action} is not part of the workbench API.`, `Try one of: ${ROUTES.join('; ')}.`);
}

/* ------------------------------------------------------------------ *
 * Part-number data — what the PN suggest and the title blocks read, live
 * ------------------------------------------------------------------ */

async function getPartNumbers(deps: WorkbenchDeps): Promise<ApiResponse> {
  if (deps.loadPartNumberFiles === undefined) {
    return fail(501, 'This studio does not keep part-number data.', 'Part numbers still print from the drawings.');
  }
  const files = await deps.loadPartNumberFiles();
  const designs: CableDesign[] = [];
  for (const summary of await deps.designs.list()) {
    const design = await deps.designs.read(summary.id);
    if (design !== undefined) designs.push(design);
  }
  const drawings: Record<string, unknown> = {};
  for (const design of designs) {
    try {
      const meta = (await deps.drawings?.read(design.id))?.meta;
      if (meta !== undefined && Object.keys(meta).length > 0) drawings[design.id] = meta;
    } catch {
      // an unreadable sidecar just has no PN to offer
    }
  }
  return ok({ ...files, designs, drawings });
}

/* ------------------------------------------------------------------ *
 * Catalog reads
 * ------------------------------------------------------------------ */

/** Every design's drawing details (title-block PN, lengths) — photos left out. */
async function getDrawingIndex(deps: WorkbenchDeps): Promise<ApiResponse> {
  if (deps.drawings === undefined) {
    return fail(501, 'This studio does not keep drawing details.', 'The drawing sheet still renders; its title block just has nothing saved.');
  }
  const drawings: Record<string, unknown> = {};
  for (const summary of await deps.designs.list()) {
    try {
      const meta = (await deps.drawings.read(summary.id)).meta;
      if (Object.keys(meta).length > 0) drawings[summary.id] = meta;
    } catch {
      // an unreadable sidecar has nothing to show
    }
  }
  return ok({ drawings });
}

/* ------------------------------------------------------------------ *
 * The shared asset store — list only; a photo is added to it by saving one
 * through `/api/drawings/:id/photo`, which dedups automatically.
 * ------------------------------------------------------------------ */

async function getAssets(deps: WorkbenchDeps): Promise<ApiResponse> {
  if (deps.assets === undefined) {
    return fail(501, 'This studio does not keep a shared asset library.', 'Uploaded photos still work; there is just nothing to pick from.');
  }
  // the picker's whole list, thumbnails included — the internal tool's own
  // scale (a few dozen photos at most) makes this simpler than a second,
  // per-asset byte-fetching round trip for every thumbnail
  const assets = deps.assets;
  // the photo picker's list: images only (a vendor's PDF is not a photo)
  const list = [];
  for (const summary of (await assets.list()).filter(isImageAsset)) list.push((await assetSummaryWithDataUri(assets, summary.id)) ?? summary);
  return ok({ assets: list });
}

/** Every stored file, bytes left out — what a wire stock's vendor documents link to (pci.29). */
async function getAssetIndex(deps: WorkbenchDeps): Promise<ApiResponse> {
  if (deps.assets === undefined) {
    return fail(501, 'This studio does not keep a shared asset library.', 'There are no stored files to link.');
  }
  // models are listed by `/api/models` (50a.55): a GLB is not a vendor document
  return ok({ assets: (await deps.assets.list()).filter((asset) => !isModelAsset(asset)) });
}

const ASSET_ID = /^[0-9a-f]{64}$/;

/** One stored file's bytes, as its own type — so a PDF datasheet opens in the browser. */
async function getAssetFile(deps: WorkbenchDeps, id: string): Promise<ApiResponse> {
  if (deps.assets === undefined) {
    return fail(501, 'This studio does not keep a shared asset library.', 'There are no stored files to open.');
  }
  if (!ASSET_ID.test(id)) return badId(id, 'an asset id (64 hex characters)');
  const found = await deps.assets.get(id);
  if (found === undefined) {
    // an imported 3D model lives in the generated cache, not the asset store (50a.55)
    const model = await cachedModelFile(modelDepsOf(deps), id);
    return model ?? fail(404, `No stored file ${id}.`, 'It may have been removed from data/assets/.');
  }
  return { status: 200, body: null, bytes: new Uint8Array(found.bytes), contentType: found.record.mime };
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

/** Every route, for the `/api` index and for the 404's hint. */
const ROUTES = [
  'GET    /api/designs',
  'GET    /api/designs/:id',
  'PUT    /api/designs/:id',
  'POST   /api/designs',
  'POST   /api/designs/:id/duplicate',
  'POST   /api/designs/:id/rename',
  'DELETE /api/designs/:id',
  'GET    /api/db',
  'GET    /api/export',
  'GET    /api/part-numbers',
  'GET    /api/drawings',
  'GET    /api/drawings/:id',
  'PUT    /api/drawings/:id',
  'PUT    /api/drawings/:id/photo',
  'GET    /api/assets',
  'GET    /api/assets/index',
  'GET    /api/assets/:id',
  ...DEFINITION_ROUTES,
  ...MODEL_ROUTES,
  ...VOCAB_ROUTES,
  ...WIRE_LIBRARY_ROUTES,
  ...BUILDS_ROUTES,
  ...ME_ROUTES,
  'GET    /api/backup',
  'POST   /api/backup/retry',
  'ANY    /api/modules/:module/…',
  'GET    /api/setup',
  'POST   /api/setup',
  ...VERSION_ROUTES,
  ...LOCK_ROUTES,
] as const;

/**
 * Percent-decode one path segment. A malformed escape decodes to itself,
 * which then fails the id check — the point is that `%2e%2e%2f` can never
 * become `../` *after* the check has run.
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function methodNotAllowed(method: string, allowed: string[]): ApiResponse {
  return fail(
    405,
    `${method} is not something this address accepts.`,
    `It answers ${allowed.join(' and ')}.`,
  );
}

/**
 * A module integration's route for `request` (`/api/modules/<module>/<path>`),
 * ready to run, or `undefined` when the path is not one.
 */
function findModuleRoute(request: ApiRequest, modules: ModuleRegistry | undefined): { writes?: boolean; run: () => Promise<ApiResponse> } | undefined {
  const [pathPart, query = ''] = request.path.split('?');
  const parts = (pathPart ?? '').split('/').filter((p) => p !== '').map(decodeSegment);
  if (parts[0] !== 'api' || parts[1] !== 'modules' || parts[2] === undefined) return undefined;
  const moduleId = parts[2];
  const sub = parts.slice(3).join('/');
  const method = request.method.toUpperCase();
  const integration = modules?.integrations().find((i) => i.module === moduleId && (i.routes ?? []).some((r) => r.method === method && r.path === sub));
  const route = integration?.routes?.find((r) => r.method === method && r.path === sub);
  if (route === undefined) {
    return { run: async () => fail(404, `${pathPart ?? ''} is not a route any module answers.`, 'Check the deployment\'s modules.config.ts.') };
  }
  return {
    ...(route.writes === undefined ? {} : { writes: route.writes }),
    run: async () => {
      const out = await route.handle({
        ...(request.body === undefined ? {} : { body: request.body }),
        query: new URLSearchParams(query),
        ...(request.user === undefined ? {} : { user: request.user }),
      });
      return { status: out.status, body: out.body };
    },
  };
}

/**
 * The whole API surface, one request in a unit of work (storage seams,
 *): the router runs against staged stores, and what it
 * staged is committed in one step once it has answered < 400 — a refusal
 * never writes. Mutating requests run one at a time (`withWriteLock`), so the
 * If-Match check and the write it guards cannot interleave with another
 * request's; a record that changed underneath anyway (another process, a hand
 * edit) fails the commit's precondition and answers 409, nothing written.
 *
 * This is the thin adapter every host calls; request guards (auth, locks)
 * belong in front of `routeWorkbenchRequest`, here.
 */
export async function handleWorkbenchRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  // 3D models (50a.55) keep their own write discipline: a STEP conversion
  // takes seconds and must not hold every other save behind the write lock,
  // so the handler takes the lock itself around the link write only
  // module integrations answer for themselves; a route that writes takes the lock
  const moduleRoute = findModuleRoute(request, deps.modules);
  if (moduleRoute !== undefined) return moduleRoute.writes === true ? withWriteLock(moduleRoute.run) : moduleRoute.run();
  // first-run setup installs packs straight into the catalog (journaled by
  // the installer), outside the unit of work, under the write lock
  if (isSetupPath(request.path)) {
    const run = (): Promise<ApiResponse> => handleSetupRequest(request, deps.setup, deps.modules);
    return isWriteMethod(request.method) ? withWriteLock(run) : run();
  }
  if (isModelPath(request.path)) {
    const ifMatch = request.headers?.['if-match'];
    return handleModelRequest(
      { method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: request.body }), ...(ifMatch === undefined ? {} : { ifMatch }) },
      modelDepsOf(deps, request.user),
    );
  }
  const run = async (): Promise<ApiResponse> => {
    const uow = new UnitOfWork(deps);
    const response = await routeWorkbenchRequest(request, uow.deps);
    if (response.status >= 400) return response;
    try {
      await uow.commit({ method: request.method.toUpperCase(), path: request.path, ...(request.user === undefined ? {} : { user: request.user }) });
    } catch (error) {
      if (error instanceof StaleRecordError) return staleWriteResponse(error.kind, error.key);
      if (error instanceof ReadOnlyBackendError) return fail(503, error.message, 'Nothing was written. This studio serves its catalog read-only for now.');
      throw error;
    }
    return response;
  };
  return isWriteMethod(request.method) ? withWriteLock(run) : run();
}

/**
 * The router. `request.path` may carry a query string; only module routes
 * read it — every other endpoint ignores it.
 */
export async function routeWorkbenchRequest(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  const path = request.path.split('?')[0] ?? '';
  const parts = path.split('/').filter((part) => part !== '').map(decodeSegment);
  if (parts[0] !== 'api') {
    return fail(404, `${path} is not part of the workbench API.`, `Try one of: ${ROUTES.join('; ')}.`);
  }
  const [, head, id, action, ...rest] = parts;

  if (head === undefined) {
    return method === 'GET'
      ? ok({ workbench: 'wirehub', routes: ROUTES })
      : methodNotAllowed(method, ['GET']);
  }

  const user = request.user ?? deps.localUser ?? LOCAL_FALLBACK;
  if (head === 'me' && id === undefined) {
    return method === 'GET' ? ok({ user }) : methodNotAllowed(method, ['GET']);
  }

  if (head === 'backup') {
    if (id === undefined) return method === 'GET' ? ok(deps.backup?.status() ?? BACKUP_DISABLED) : methodNotAllowed(method, ['GET']);
    if (id === 'retry' && action === undefined) {
      if (method !== 'POST') return methodNotAllowed(method, ['POST']);
      deps.backup?.retry();
      return ok(deps.backup?.status() ?? BACKUP_DISABLED);
    }
  }

  if (head === 'export' && id === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    if (deps.exportCatalog === undefined) return fail(501, 'This studio does not offer a catalog export.', 'Export the catalog files from the host instead.');
    return ok(await deps.exportCatalog());
  }

  if (head === 'db' && id === undefined) {
    return method === 'GET' ? ok(await deps.loadDb()) : methodNotAllowed(method, ['GET']);
  }

  if (head === 'part-numbers' && id === undefined) {
    return method === 'GET' ? await getPartNumbers(deps) : methodNotAllowed(method, ['GET']);
  }
  if (head === 'drawings' && id === undefined) {
    return method === 'GET' ? await getDrawingIndex(deps) : methodNotAllowed(method, ['GET']);
  }

  const ifMatch = request.headers?.['if-match'];

  // the definition editors live in their own module and answer `undefined`
  // for anything that is not theirs
  const definitions = await handleDefinitionRequest(method, parts, request.body, deps, ifMatch);
  if (definitions !== undefined) {
    // a new pin or a changed label changes what the tag generator proposes:
    // the commit rebuilds the table with the save (unit-of-work.ts, derivedFor)
    return definitions;
  }

  const vocab = await handleVocabRequest(method, parts, request.body, deps, ifMatch);
  if (vocab !== undefined) return vocab;

  const wireLibrary = await handleWireLibraryRequest(method, parts, request.body, deps, ifMatch);
  if (wireLibrary !== undefined) return wireLibrary;

  const builds = await handleBuildsRequest(method, parts, request.body, deps, ifMatch);
  if (builds !== undefined) return builds;

  const versions = await handleVersionRequest(method, parts, request.body, deps, user);
  if (versions !== undefined) return versions;

  if (head === 'drawings' && id !== undefined) return await drawingRequest(method, id, action, rest, request.body, deps, ifMatch);

  if (head === 'assets' && id === undefined) {
    return method === 'GET' ? await getAssets(deps) : methodNotAllowed(method, ['GET']);
  }
  if (head === 'assets' && action === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    return id === 'index' ? await getAssetIndex(deps) : await getAssetFile(deps, id!);
  }

  if (head === 'designs') {
    if (id === undefined) {
      if (method === 'GET') return await getDesigns(deps);
      if (method === 'POST') return await postDesign(deps, request.body);
      return methodNotAllowed(method, ['GET', 'POST']);
    }
    // rule 2: the id is checked before it can reach anything that opens a file
    if (!isDesignId(id)) return badId(id, 'a design id');

    if (action === undefined) {
      if (method === 'GET') return await getDesign(deps, id);
      if (method === 'PUT') return await putDesign(deps, id, request.body, ifMatch);
      if (method === 'DELETE') return await deleteDesign(deps, id, request.body);
      return methodNotAllowed(method, ['GET', 'PUT', 'DELETE']);
    }
    if (rest.length === 0 && (action === 'duplicate' || action === 'rename')) {
      if (method !== 'POST') return methodNotAllowed(method, ['POST']);
      return action === 'duplicate'
        ? await duplicateDesign(deps, id, request.body)
        : await renameDesign(deps, id, request.body, ifMatch);
    }
  }

  return fail(404, `${path} is not part of the workbench API.`, `Try one of: ${ROUTES.join('; ')}.`);
}
