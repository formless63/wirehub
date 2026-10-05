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

import { isDesignId, type DesignId, type InstalledPacks } from '@wirehub/catalog';
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
import { refuseTakenDesignNumber } from './part-number-guard.ts';
import { SETTINGS_ROUTES, handleSettingsRequest } from './settings.ts';
import { VOCAB_ROUTES, handleVocabRequest } from './vocab.ts';
import { VERSION_ROUTES, handleVersionRequest, workingStatus, type VersionStore } from './versions.ts';
import { LOCAL_FALLBACK, ME_ROUTES, type StudioUser } from './me.ts';
import { BACKUP_DISABLED, type BackupControl } from './backup/status.ts';
import type { TagStore, VocabStore } from './vocab-store.ts';
import { LOCK_ROUTES } from './locks/lock-api.ts';
import type { LockStore } from './locks/lock-store.ts';
import type { DerivedStore } from './derived.ts';
import { CommitRefusedError, ReadOnlyBackendError, StaleRecordError, type Awaitable, type ChangeSet, type CommitResult, type DerivedKind } from './storage/change-set.ts';
import { UnitOfWork } from './storage/unit-of-work.ts';
import { withWriteLock } from './storage/write-lock.ts';
import { handleSetupRequest, isSetupPath, type SetupDeps } from './setup.ts';
import { packOwnerOf, packRecordRefusal } from './pack-guard.ts';
import { PACKS_ROUTES, handlePacksRequest, isPacksPath } from './packs.ts';
import { STORE_ROUTES, handleStoreRequest, isStorePath, type StoreDeps } from './store.ts';
import { isWriteMethod } from './request-guard.ts';
import type { CatalogExport } from './pg/export.ts';
import type { DepictionDeps, DepictionStore } from './depictions.ts';
import { isDocPath, type CatalogFileStore, type DocStore } from './storage/doc-store.ts';
import { moduleJobsFor } from './jobs/module-queues.ts';
import { deriveContinuityExport, type TestParameters } from '@wirehub/docs';
import { handleDocumentRequest, DOCUMENT_ROUTES } from './documents.ts';
import { parseModuleIoPath, proposalOf, runExporter, runImporter, type ModuleIoPath } from './module-io.ts';
import { batchItemRequest, dryRunAnswer, isDryRun, readBatch } from './batch.ts';
import type { JobService } from './jobs/types.ts';
import { handleJobRequest, isJobPath, JOB_ROUTES, startImportJob } from './jobs/api.ts';
import type { EventHub } from './events.ts';

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
   * The signed-in person, when the host has a login and a session.
   * Absent → `deps.localUser`.
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
   * client; the backup commit lists them under its subject.
   */
  changes?: string[];
}

export interface WorkbenchDeps {
  designs: DesignStore;
  /** the definition library every candidate is validated against */
  loadDb: () => Awaitable<Db>;
  /**
   * A token that changes whenever the stored catalog does (storage seams).
   * Given one, the unit of work loads `loadDb()` once
   * per catalog version instead of once per request. Absent: every request
   * loads its own.
   */
  catalogVersion?: () => Awaitable<string | undefined>;
  /**
   * Bytes by content address (`GET /api/blobs/:sha`, plan §5.3): any blob the
   * catalog names — uploads, saved artwork, depiction files. Absent → 501.
   */
  blob?: (sha256: string) => Promise<{ bytes: Uint8Array; mediaType: string } | undefined>;
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
  /** the organisation's default continuity test parameters (`WIREHUB_TEST_DEFAULTS`) */
  testDefaults?: TestParameters;
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
  /** the wire parts library and stock recipes; optional like the rest */
  wireLibrary?: WireLibraryStore;
  /** the board build files (`data/builds/*.json`); optional like the rest */
  builds?: BuildsStore;
  /**
   * The artwork store (`depictions.ts`). Given here, artwork writes are
   * staged and commit with the rest of a change set (B7); the artwork routes
   * themselves still answer through `DepictionDeps`.
   */
  depictions?: DepictionStore;
  /** catalog documents by path (`storage/doc-store.ts`): the `doc` change-set kind */
  docs?: DocStore;
  /** binary catalog files by path (`data/art/…`, a pack's art): the `catalog-file` change-set kind */
  files?: CatalogFileStore;
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
  /** what changed, for `GET /api/events` (`events.ts`); absent → no stream */
  events?: EventHub;
  /**
   * What the browser shows about this instance (`GET /api/me`): a development
   * instance's banner (§8.7), and whether people, invitations and API tokens
   * exist (the database backend with sign-in on).
   */
  instance?: { env?: 'dev' | 'prod'; accounts?: boolean };
  /**
   * True while the hub has no organisation yet (the database backend before
   * first-run setup, plan §9.1): every route but `/api/setup` answers 503.
   */
  setupMode?: () => boolean;
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
  /**
   * The installed catalog packs (`packs.json`, layers and merged): which records came
   * from a pack. Those are read-only through the definition routes (fork to edit).
   */
  installedPacks?: () => Awaitable<InstalledPacks>;
  /**
   * The store indexes this deployment trusts (`store.ts`): absent → read from
   * `WIREHUB_STORE_INDEXES` on each request.
   */
  store?: StoreDeps;
  /**
   * Jobs (`jobs/`, plan §2): module imports, model conversion and builds, and
   * the worker's housekeeping — run in this process (files) or by the worker
   * (pg). Absent → `/api/jobs` answers 501.
   */
  jobs?: JobService;
  /** Called after every committed change set (the model-cache trigger, §5.5). Never fails the request. */
  afterCommit?: (set: ChangeSet) => void | Promise<void>;
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
  // is stored at the one current version (migrate-schema.ts)
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
  // a design a pack ships is the pack's: fork (duplicate) to edit
  const origin = await packOwnerOf(deps, `designs/${id}.json`, id);
  if (origin !== undefined) return packRecordRefusal('design', id, origin, `POST /api/designs/${id}/duplicate copies it under a new id of your own.`);
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
  const taken = await refuseTakenDesignNumber(deps, id, 'productRef', parsed.design.productRef, current.productRef);
  if (taken !== undefined) return taken;

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

  // a copy is a new part: it does not inherit the original's product reference (a number is never reused)
  const { productRef: _original, ...inherited } = source;
  const copy: CableDesign = {
    ...inherited,
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
  const origin = await packOwnerOf(deps, `designs/${id}.json`, id);
  if (origin !== undefined) return packRecordRefusal('design', id, origin, `POST /api/designs/${id}/duplicate copies it under the new id.`);
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
  const origin = await packOwnerOf(deps, `designs/${id}.json`, id);
  if (origin !== undefined) return packRecordRefusal('design', id, origin, `to keep a changed copy, POST /api/designs/${id}/duplicate; the pack's own designs go with the pack (Library, Packs, Disable).`);
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
    if (method === 'GET') return ok({ ...(await drawings.read(id)), ...(deps.testDefaults === undefined ? {} : { testDefaults: deps.testDefaults }) }, 200, await tagOf());
    if (method !== 'PUT') return methodNotAllowed(method, ['GET', 'PUT']);
    const guard = checkIfMatch(ifMatch, contentETag(await drawings.read(id)), 'drawing', id);
    if (guard !== undefined) return guard;
    const parsed = readDrawingMeta(body);
    if (!parsed.ok) {
      return fail(422, 'Those drawing details could not be saved.', `Nothing was changed. ${parsed.problems.join(' ')}`);
    }
    const taken = await refuseTakenDesignNumber(deps, id, 'drawing', parsed.meta.partNumber, (await drawings.read(id)).meta.partNumber);
    if (taken !== undefined) return taken;
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

/** Every stored file, bytes left out — what a wire stock's vendor documents link to. */
async function getAssetIndex(deps: WorkbenchDeps): Promise<ApiResponse> {
  if (deps.assets === undefined) {
    return fail(501, 'This studio does not keep a shared asset library.', 'There are no stored files to link.');
  }
  // models are listed by `/api/models`: a GLB is not a vendor document
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
    // an imported 3D model lives in the generated cache, not the asset store
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
  'GET    /api/blobs/:sha',
  'POST   /api/batch',
  'GET    /api/docs/*path',
  'PUT    /api/docs/*path',
  'DELETE /api/docs/*path',
  'GET    /api/part-numbers',
  ...DOCUMENT_ROUTES,
  'GET    /api/drawings',
  'GET    /api/drawings/:id',
  'PUT    /api/drawings/:id',
  'PUT    /api/drawings/:id/photo',
  'GET    /api/assets',
  'GET    /api/assets/index',
  'GET    /api/assets/:id',
  ...DEFINITION_ROUTES,
  ...MODEL_ROUTES,
  ...SETTINGS_ROUTES,
  ...VOCAB_ROUTES,
  ...WIRE_LIBRARY_ROUTES,
  ...BUILDS_ROUTES,
  ...ME_ROUTES,
  'GET    /api/backup',
  'POST   /api/backup/retry',
  ...JOB_ROUTES,
  'ANY    /api/modules/:module/…',
  'POST   /api/modules/:module/_import/:importer',
  'GET    /api/modules/:module/_export/:exporter',
  'GET    /api/setup',
  'POST   /api/setup',
  ...PACKS_ROUTES,
  ...STORE_ROUTES,
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
function findModuleRoute(request: ApiRequest, modules: ModuleRegistry | undefined, jobs?: WorkbenchDeps['jobs']): { writes?: boolean; run: () => Promise<ApiResponse> } | undefined {
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
  const moduleJobs = moduleJobsFor(moduleId, jobs, modules, request.user);
  return {
    ...(route.writes === undefined ? {} : { writes: route.writes }),
    run: async () => {
      const out = await route.handle({
        ...(request.body === undefined ? {} : { body: request.body }),
        query: new URLSearchParams(query),
        ...(request.user === undefined ? {} : { user: request.user }),
        ...(moduleJobs === undefined ? {} : { jobs: moduleJobs }),
      });
      return { status: out.status, body: out.body };
    },
  };
}

/** `/api/modules/<module>/_import/<id>` and `_export/<id>` (`module-io.ts`). */
async function handleModuleIo(request: ApiRequest, io: ModuleIoPath, deps: WorkbenchDeps): Promise<ApiResponse> {
  const method = request.method.toUpperCase();
  if (io.kind === 'export') {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    const query = new URLSearchParams(request.path.split('?')[1] ?? '');
    return runExporter(deps.modules, io, query, async (id) => (isDesignId(id) ? deps.designs.read(id) : undefined), await deps.loadDb(), async (design, db) => {
      const parameters = (await deps.drawings?.read(design.id))?.meta.test;
      return deriveContinuityExport(design, db, {
        ...(parameters === undefined ? {} : { parameters }),
        ...(deps.testDefaults === undefined ? {} : { defaults: deps.testDefaults }),
      });
    });
  }
  if (method !== 'POST') return methodNotAllowed(method, ['POST']);
  // `job: true`: the importer runs as a job (the worker on Postgres) and keeps a plan to publish (§7.5)
  if ((request.body as { job?: unknown } | undefined)?.job === true) return startImportJob(request, io, deps);
  const db = await deps.loadDb();
  const ran = await runImporter(deps.modules, io, request.body, db);
  if (!ran.ok) return ran.response;
  const ids = new Set((await deps.designs.list()).map((d) => d.id));
  const { proposal, requests } = proposalOf(ran.result, db, ids);
  if (!ran.accept) return ok({ accepted: false, proposal });
  if (requests.length === 0) return fail(409, 'There is nothing new to add.', 'Every record in the proposal is already in the library.');
  const message = `Import ${(request.body as { fileName?: string }).fileName ?? 'a file'} with ${io.module}/${io.id}`;
  const done = await withWriteLock(() => runBatch({ ...request, body: { message, requests } }, deps));
  if (done.status >= 400) return done;
  return { ...done, body: { accepted: true, proposal } };
}

/**
 * The whole API surface, one request in a unit of work (storage seams):
 * the router runs against staged stores, and what it
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
  // 3D models keep their own write discipline: a STEP conversion
  // takes seconds and must not hold every other save behind the write lock,
  // so the handler takes the lock itself around the link write only
  // module integrations answer for themselves; a route that writes takes the lock
  if (deps.setupMode?.() === true && !isSetupPath(request.path) && !['/api', '/api/me'].includes((request.path.split('?')[0] ?? '').replace(/\/+$/, ''))) {
    return { status: 503, body: { state: 'setup', error: 'This hub is not set up yet.', hint: 'Open /setup to create the organisation, its catalog and the admin.' } };
  }
  // jobs: a job's state, an import's plan published (§7.5)
  if (isJobPath(request.path)) return handleJobRequest(request, deps);
  const io = parseModuleIoPath(request.path);
  if (io !== undefined) return handleModuleIo(request, io, deps);
  const moduleRoute = findModuleRoute(request, deps.modules, deps.jobs);
  if (moduleRoute !== undefined) return moduleRoute.writes === true ? withWriteLock(moduleRoute.run) : moduleRoute.run();
  // first-run setup installs packs straight into the catalog (journaled by
  // the installer), outside the unit of work, under the write lock
  if (isSetupPath(request.path)) {
    const run = (): Promise<ApiResponse> => handleSetupRequest(request, deps.setup, deps.modules);
    return isWriteMethod(request.method) ? withWriteLock(run) : run();
  }
  // the store: verified indexes, and install through the pack lifecycle below
  if (isStorePath(request.path, request.method)) {
    const run = (): Promise<ApiResponse> => handleStoreRequest(request, deps.setup, deps.modules, deps.store);
    return isWriteMethod(request.method) ? withWriteLock(run) : run();
  }
  // the pack lifecycle: the same direct-write handler shape, on files and (through `setup.transact`) on Postgres
  if (isPacksPath(request.path)) {
    const run = (): Promise<ApiResponse> => handlePacksRequest(request, deps.setup, deps.modules);
    return isWriteMethod(request.method) ? withWriteLock(run) : run();
  }
  if (isModelPath(request.path)) {
    const ifMatch = request.headers?.['if-match'];
    return handleModelRequest(
      { method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: request.body }), ...(ifMatch === undefined ? {} : { ifMatch }) },
      {
        ...modelDepsOf(deps, request.user),
        // the link (and an upload's bytes) commit as one change set (B0)
        transact: (write) =>
          withWriteLock(async () => {
            const uow = new UnitOfWork(deps);
            const answered = await write(modelDepsOf(uow.deps, request.user));
            if (isDryRun(request.path)) return dryRunAnswer(uow, answered);
            const response = await commitUnit(uow, request, answered);
            if (response.status < 400 && uow.changes.length > 0) await publishCatalog(deps);
            return response;
          }),
      },
    );
  }
  if ((request.path.split('?')[0] ?? '') === '/api/batch') {
    if (request.method.toUpperCase() !== 'POST') return methodNotAllowed(request.method.toUpperCase(), ['POST']);
    return withWriteLock(() => runBatch(request, deps));
  }
  const run = async (): Promise<ApiResponse> => {
    const uow = new UnitOfWork(deps);
    const answered = await routeWorkbenchRequest(request, uow.deps);
    // a dry run: everything up to the commit, then nothing (§4.5)
    if (isDryRun(request.path) && isWriteMethod(request.method)) return dryRunAnswer(uow, answered);
    const response = await commitUnit(uow, request, answered);
    if (response.status < 400 && uow.changes.length > 0) await publishCatalog(deps);
    return response;
  };
  return isWriteMethod(request.method) ? withWriteLock(run) : run();
}

/**
 * Artwork writes in a unit of work over `workbench` (B7): the depiction
 * store is staged with everything else, and the change set commits through
 * the backend (`commitUnit`). The host calls this with its workbench deps.
 */
export function transactingDepictionDeps(deps: DepictionDeps, workbench: WorkbenchDeps, user?: StudioUser, dryRun = false): DepictionDeps {
  return {
    ...deps,
    transact: async (run) => {
      // the artwork deps' store is the authority; board maps go through the
      // workbench's doc store only when both describe the same catalog tree
      const probe = (store: DepictionStore | undefined): string | undefined => store?.dirFor('probe');
      const sameTree = workbench.depictions === deps.store || (probe(deps.store) !== undefined && probe(deps.store) === probe(workbench.depictions));
      const { docs, ...rest } = workbench;
      const uow = new UnitOfWork({ ...rest, depictions: deps.store, ...(sameTree && docs !== undefined ? { docs } : {}) });
      const staged = uow.deps.depictions as DepictionStore;
      const response = await run({ ...deps, store: staged, loadDb: uow.deps.loadDb });
      if (dryRun) {
        const answer = await dryRunAnswer(uow, 'body' in response ? { status: response.status, body: response.body } : { status: response.status, body: null });
        return { status: answer.status, body: answer.body };
      }
      const committed = await commitUnit(uow, { method: 'POST', path: '/api/depictions', ...(user === undefined ? {} : { user }) }, 'body' in response ? { status: response.status, body: response.body } : { status: response.status, body: null });
      if (committed.status < 400 && uow.changes.length > 0) await publishCatalog(workbench);
      return committed.status === response.status ? response : { status: committed.status, body: committed.body };
    },
  };
}

/** `POST /api/batch`: every request in one unit of work; one change set, or nothing (§4.5). The caller holds the write lock. */
async function runBatch(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  const batch = readBatch(request.body);
  if (!batch.ok) return fail(400, batch.error, 'Nothing was written.');
  const scopes = request.user?.apiTokenScopes;
  if (scopes !== undefined && !scopes.includes('imports') && batch.requests.some((r) => r.path.startsWith('/api/docs/'))) {
    return fail(403, 'The token lacks scope imports.', 'Nothing was written.');
  }
  const uow = new UnitOfWork(deps);
  const results: { status: number; body: unknown; etag?: string }[] = [];
  for (const [i, item] of batch.requests.entries()) {
    const answer = await routeWorkbenchRequest(batchItemRequest(item, request), uow.deps);
    const etag = answer.headers?.ETag;
    results.push({ status: answer.status, body: answer.body, ...(etag === undefined ? {} : { etag }) });
    if (answer.status >= 400) {
      return { status: answer.status, body: { committed: false, failed: i, error: `Request ${i} was refused, so nothing was written.`, results } };
    }
  }
  if (batch.dryRun || isDryRun(request.path)) return dryRunAnswer(uow, { status: 200, body: { results } }, { results });
  const committed = await commitUnit(uow, { method: 'POST', path: '/api/batch', body: { message: batch.message ?? `Batch of ${batch.requests.length} requests` }, ...(request.user === undefined ? {} : { user: request.user }) }, { status: 200, body: { committed: true, results } });
  if (committed.status >= 400) return { status: committed.status, body: { ...(committed.body as object), committed: false, results } };
  if (uow.changes.length > 0) await publishCatalog(deps);
  return committed;
}

/** Tell the event stream the catalog moved (a backend that hears its own NOTIFY drops this). */
export async function publishCatalog(deps: WorkbenchDeps): Promise<void> {
  if (deps.events === undefined) return;
  deps.events.publish({ type: 'catalog', version: String((await deps.catalogVersion?.()) ?? '') });
}

/**
 * `/api/docs/*path` (§4.5): a module's imported documents and reports, read
 * and written by path. Only paths a module declares (`documents`) may be
 * written; truth files keep their own routes and derived files are never
 * written. A write quotes the version it read (If-Match).
 */
async function docRequest(method: string, path: string, body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This studio does not keep catalog documents by path.');
  if (!isDocPath(path)) return fail(400, `${JSON.stringify(path)} is not a catalog document path.`, 'A document lives under data/ and ends in .json, .md or .txt.');
  if (method === 'GET') {
    const value = await deps.docs.read(path);
    return value === undefined ? fail(404, `There is no document ${path}.`) : ok(value, 200, { ETag: contentETag(value) });
  }
  if (method !== 'PUT' && method !== 'DELETE') return methodNotAllowed(method, ['GET', 'PUT', 'DELETE']);
  const owner = deps.modules?.documentFor(path);
  if (owner === undefined) return fail(403, `${path} is not a document any module imports or reports.`, 'Truth files have their own routes; derived files are never written by hand.');
  const current = await deps.docs.read(path);
  const guard = checkIfMatch(ifMatch, contentETag(current ?? null), 'document', path);
  if (guard !== undefined) return guard;
  if (method === 'DELETE') {
    if (current === undefined) return fail(404, `There is no document ${path}.`);
    await deps.docs.remove(path);
    return ok({ removed: path }, 200, { ETag: contentETag(null) });
  }
  if (!path.endsWith('.json') && typeof body !== 'string') return fail(400, `${path} is a text document; send its text as a JSON string.`);
  if (body === undefined) return fail(400, 'Send the document as the body.');
  await deps.docs.write(path, body);
  return ok({ path, module: owner.module }, 200, { ETag: contentETag(body) });
}

/**
 * Commit what a unit of work staged when the handler answered < 400, mapping
 * a stale precondition to the 409 and a read-only backend to 503 — nothing
 * is written in either case.
 */
export async function commitUnit(uow: UnitOfWork, request: Pick<ApiRequest, 'method' | 'path' | 'user' | 'body'>, response: ApiResponse): Promise<ApiResponse> {
  if (response.status >= 400) return response;
  try {
    await uow.commit({
      method: request.method.toUpperCase(),
      path: request.path,
      ...(request.user === undefined ? {} : { user: request.user }),
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.user?.apiTokenId === undefined ? {} : { apiTokenId: request.user.apiTokenId }),
    });
  } catch (error) {
    if (error instanceof StaleRecordError) return staleWriteResponse(error.kind, error.key);
    if (error instanceof CommitRefusedError) return fail(error.status, error.message, error.hint);
    if (error instanceof ReadOnlyBackendError) return fail(503, error.message, 'Nothing was written. This studio serves its catalog read-only for now.');
    throw error;
  }
  return response;
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
    return method === 'GET' ? ok({ user, ...(deps.instance === undefined ? {} : { instance: deps.instance }) }) : methodNotAllowed(method, ['GET']);
  }

  if (head === 'backup') {
    if (id === undefined) return method === 'GET' ? ok((await deps.backup?.status()) ?? BACKUP_DISABLED) : methodNotAllowed(method, ['GET']);
    if (id === 'retry' && action === undefined) {
      if (method !== 'POST') return methodNotAllowed(method, ['POST']);
      const current = (await deps.backup?.status()) ?? BACKUP_DISABLED;
      if (current.state === 'database') return fail(404, 'Not used with the database backend.', 'Its saves are the database itself; backups are database dumps (docs/self-hosting.md).');
      deps.backup?.retry();
      return ok((await deps.backup?.status()) ?? BACKUP_DISABLED);
    }
  }

  if (head === 'blobs' && id !== undefined && action === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    if (!/^[0-9a-f]{64}$/.test(id)) return fail(400, `${JSON.stringify(id)} is not a content address.`, 'A blob is named by the sha256 of its bytes: 64 lowercase hex digits.');
    if (deps.blob === undefined) return fail(501, 'This studio does not serve blobs by content address.', 'Use /api/assets/:id for uploaded files.');
    const found = await deps.blob(id);
    if (found === undefined) return fail(404, `There is no blob ${id}.`, 'It may never have been uploaded, or it was removed after nothing used it.');
    return {
      status: 200,
      body: null,
      bytes: found.bytes,
      contentType: found.mediaType,
      headers: {
        ETag: `"${id}"`,
        'cache-control': 'private, max-age=31536000, immutable',
        ...(found.mediaType === 'image/svg+xml' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" } : {}),
      },
    };
  }

  if (head === 'docs' && id !== undefined) return await docRequest(method, parts.slice(2).join('/'), request.body, deps, request.headers?.['if-match']);

  if (head === 'export' && id === undefined) {
    if (method !== 'GET') return methodNotAllowed(method, ['GET']);
    if (deps.exportCatalog === undefined) return fail(501, 'This studio does not offer a catalog export.', 'Export the catalog files from the host instead.');
    return ok(await deps.exportCatalog());
  }

  if (head === 'db' && id === undefined) {
    return method === 'GET' ? ok(await deps.loadDb()) : methodNotAllowed(method, ['GET']);
  }

  if ((head === 'exports' && id === undefined) || (head === 'designs' && (action === 'documents' || action === 'exports'))) {
    const documents = await handleDocumentRequest(method, parts, new URLSearchParams(request.path.split('?')[1] ?? ''), deps);
    if (documents !== undefined) return documents;
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

  const settings = await handleSettingsRequest(method, parts, request.body, deps, ifMatch);
  if (settings !== undefined) return settings;

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
