/**
 * Photos stored before uploads were stripped (`image-metadata.ts`) still carry EXIF/GPS, XMP and
 * comments at rest. `POST /api/knowledge/strip-photo-metadata` (owner; `?dryRun=1` only reports)
 * strips each one losslessly, stores the clean bytes as a new asset and repoints what named the old
 * sha: note and project attachments (and the index), drawing photos, and cover choices of a note
 * photo. Idempotent: a clean photo strips to itself and is left alone.
 *
 * The pre-strip copies (`drop` in the answer) are removed after the repoint is committed, through
 * `removeUnreferencedAssets`: only those no current record or version names; a history entry may
 * still name one, and restoring it then reads the clean copy (`assets/replaced.json`).
 */
import { createHash } from 'node:crypto';

import { PHOTO_MIMES, summaryOfNote, type Attachment, type KnowledgeIndex, type Note, type Project } from '../src/knowledge.ts';
import type { CoverChoice, CoverKind, RepresentationView } from '../src/representations.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { removeUnreferencedAssets, type RemoveAssetsOutcome } from './asset-remove.ts';
import { decodeImageDataUri } from './assets.ts';
import { commitUnit, publishCatalog } from './catalog-commit.ts';
import { UnitOfWork } from './storage/unit-of-work.ts';
import { withWriteLock } from './storage/write-lock.ts';
import { stripPhotoMetadata } from './image-metadata.ts';
import { KNOWLEDGE_INDEX_PATH, notePath, photoLineage, projectPath } from './knowledge.ts';
import { coverPath, handleRepresentationRequest } from './representations.ts';

export interface PhotoRewriteReport {
  dryRun: boolean;
  checked: number;
  rewritten: { from: string; to: string; removed: string[] }[];
  notes: string[];
  projects: string[];
  drawings: string[];
  covers: string[];
  failed: { asset: string; reason: string }[];
  /** the pre-strip copies that go once nothing current names them */
  drop: { id: string; name: string; bytes: number }[];
  /** after the repoint: what was removed and what stays, with why */
  removed?: RemoveAssetsOutcome['removed'];
  kept?: RemoveAssetsOutcome['kept'];
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The cover a note photo's link names: `design:<id>` or `definition:<kind>:<id>` for a kind with covers. */
function coverOf(record: string): [CoverKind, string] | undefined {
  const [type, a, b] = record.split(':');
  if (type === 'design' && a !== undefined && b === undefined) return ['designs', a];
  if (type === 'definition' && (a === 'pcbas' || a === 'wires' || a === 'mechanicals') && b !== undefined) return [a, b];
  return undefined;
}

export async function rewriteLegacyPhotos(deps: WorkbenchDeps, apply: boolean): Promise<PhotoRewriteReport> {
  const report: PhotoRewriteReport = { dryRun: !apply, checked: 0, rewritten: [], notes: [], projects: [], drawings: [], covers: [], failed: [], drop: [] };
  const seen = new Map<string, string | undefined>();
  const assets = deps.assets;

  /** The clean asset for a stored photo (stored once, when applying), or undefined when it is already clean or cannot be read. */
  const clean = async (asset: string): Promise<string | undefined> => {
    if (seen.has(asset)) return seen.get(asset);
    seen.set(asset, undefined);
    const found = await assets?.get(asset);
    if (found === undefined || !PHOTO_MIMES.includes(found.record.mime as never)) return undefined;
    report.checked += 1;
    const stripped = stripPhotoMetadata(found.bytes, found.record.mime, Number.MAX_SAFE_INTEGER);
    if (stripped === undefined || !stripped.ok) {
      report.failed.push({ asset, reason: stripped?.ok === false ? stripped.reason : 'Not a photo.' });
      return undefined;
    }
    if (stripped.bytes.equals(found.bytes)) return undefined;
    const to = apply && assets !== undefined
      ? (await assets.put(stripped.bytes, found.record.mime, found.record.originalName, `${found.record.src} Metadata removed at rest (${stripped.removed.join(', ') || 'ancillary data'}).`)).id
      : sha256(stripped.bytes);
    report.rewritten.push({ from: asset, to, removed: stripped.removed });
    seen.set(asset, to);
    return to;
  };
  const repoint = async (list: Attachment[]): Promise<{ next: Attachment[]; moved: [string, string][] }> => {
    const moved: [string, string][] = [];
    const next: Attachment[] = [];
    for (const a of list) {
      const to = PHOTO_MIMES.includes(a.mime) ? await clean(a.asset) : undefined;
      if (to === undefined) { next.push(a); continue; }
      const found = apply ? await assets?.get(to) : undefined;
      next.push({ ...a, asset: to, ...(found === undefined ? {} : { bytes: found.bytes.length }) });
      moved.push([a.asset, to]);
    }
    return { next, moved };
  };

  if (deps.docs !== undefined) {
    const docs = deps.docs;
    const stored = (await docs.read(KNOWLEDGE_INDEX_PATH)) as Partial<KnowledgeIndex> | undefined;
    const index: KnowledgeIndex = { notes: stored?.notes ?? [], projects: stored?.projects ?? [] };
    let indexChanged = false;
    for (const summary of [...index.notes]) {
      const note = (await docs.read(notePath(summary.id))) as Note | undefined;
      if (note === undefined || note.attachments.length === 0) continue;
      const { next, moved } = await repoint(note.attachments);
      if (moved.length === 0) continue;
      report.notes.push(note.id);
      // cover choices of these photos, while the old candidates still resolve (their identity gives the new lineage)
      for (const link of note.links) {
        const cover = coverOf(link.record);
        if (cover === undefined) continue;
        const [kind, id] = cover;
        const choice = (await docs.read(coverPath(id, kind))) as CoverChoice | null | undefined;
        const hit = choice == null ? undefined : moved.find(([from]) => choice.view === `note-photo-${from.slice(0, 12)}`);
        if (choice == null || hit === undefined) continue;
        const view = await handleRepresentationRequest({ method: 'GET', path: `/api/representations/${kind}/${id}` }, ['api', 'representations', kind, id], deps);
        const candidate = view.status === 200 ? (view.body as RepresentationView).candidates.find((c) => c.view === choice.view && c.lineage === choice.lineage) : undefined;
        if (candidate === undefined) continue;
        report.covers.push(`${kind}/${id}`);
        if (apply) await docs.write(coverPath(id, kind), { view: `note-photo-${hit[1].slice(0, 12)}`, lineage: photoLineage(candidate.identity, hit[1]) } satisfies CoverChoice);
      }
      if (!apply) continue;
      // a maintenance rewrite, not an edit: who and when stay as they were
      const updated: Note = { ...note, attachments: next };
      await docs.write(notePath(note.id), updated);
      index.notes = index.notes.map((n) => (n.id === note.id ? summaryOfNote(updated) : n));
      indexChanged = true;
    }
    for (const summary of index.projects) {
      const project = (await docs.read(projectPath(summary.id))) as Project | undefined;
      if (project === undefined || project.attachments.length === 0) continue;
      const { next, moved } = await repoint(project.attachments);
      if (moved.length === 0) continue;
      report.projects.push(project.id);
      if (apply) await docs.write(projectPath(project.id), { ...project, attachments: next });
    }
    if (apply && indexChanged) await docs.write(KNOWLEDGE_INDEX_PATH, index);
  }

  if (deps.drawings !== undefined) {
    for (const { id } of (await deps.designs.list())) {
      const sheet = await deps.drawings.read(id);
      const photo = sheet.photo === undefined ? undefined : decodeImageDataUri(sheet.photo);
      if (photo === undefined) continue;
      const key = sha256(photo.bytes);
      if (seen.has(key) && seen.get(key) === undefined) continue;
      report.checked += seen.has(key) ? 0 : 1;
      const stripped = stripPhotoMetadata(photo.bytes, photo.mime, Number.MAX_SAFE_INTEGER);
      if (stripped === undefined || !stripped.ok) {
        if (!seen.has(key)) report.failed.push({ asset: key, reason: stripped?.ok === false ? stripped.reason : 'Not a photo.' });
        seen.set(key, undefined);
        continue;
      }
      if (stripped.bytes.equals(photo.bytes)) { seen.set(key, undefined); continue; }
      if (!seen.has(key)) report.rewritten.push({ from: key, to: sha256(stripped.bytes), removed: stripped.removed });
      seen.set(key, sha256(stripped.bytes));
      report.drawings.push(id);
      if (apply) await deps.drawings.writePhoto(id, { mime: photo.mime, bytes: stripped.bytes });
    }
  }
  const listed = new Map(((await assets?.list()) ?? []).map((r) => [r.id, r]));
  for (const { from } of report.rewritten) {
    const record = listed.get(from);
    if (record !== undefined) report.drop.push({ id: from, name: record.originalName, bytes: record.bytes });
  }
  return report;
}

export async function handlePhotoRewrite(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  if (request.method.toUpperCase() !== 'POST') return { status: 405, body: { error: 'This address accepts POST.' }, headers: { Allow: 'POST' } };
  const role = (request.user ?? deps.localUser)?.role;
  if (role !== undefined && role !== 'owner') return { status: 403, body: { error: 'Only an owner rewrites stored photos.' } };
  if (deps.assets === undefined) return { status: 501, body: { error: 'This hub does not keep uploaded files.' } };
  const dryRun = new URLSearchParams(request.path.split('?')[1] ?? '').get('dryRun') === '1';
  return { status: 200, body: await rewriteLegacyPhotos(deps, !dryRun) };
}

/**
 * The rewrite for real: repoint and commit, then remove the pre-strip copies nothing current names
 * any more and commit that (two change sets, so the reference check reads the repointed state).
 */
export async function handlePhotoRewriteCommitted(request: ApiRequest, deps: WorkbenchDeps): Promise<ApiResponse> {
  return withWriteLock(async () => {
    const first = new UnitOfWork(deps);
    const answered = await handlePhotoRewrite(request, first.deps);
    const committed = await commitUnit(first, request, answered);
    if (committed.status >= 400) return committed;
    if (first.changes.length > 0) await publishCatalog(deps);
    const report = committed.body as PhotoRewriteReport;
    if (report.drop.length === 0) return committed;
    const second = new UnitOfWork(deps);
    const who = (request.user ?? deps.localUser)?.name;
    const replacedBy = Object.fromEntries(report.rewritten.map((r) => [r.from, r.to]));
    const outcome = await removeUnreferencedAssets(second.deps, report.drop.map((d) => d.id), { replacedBy, ...(who === undefined ? {} : { by: who }) });
    const body: PhotoRewriteReport = { ...report, removed: outcome.removed, kept: outcome.kept };
    const message = `Remove ${outcome.removed.length} photo(s) replaced by copies without metadata`;
    const done = await commitUnit(second, { method: 'POST', path: request.path, body: { message }, ...(request.user === undefined ? {} : { user: request.user }) }, { status: 200, body });
    if (done.status < 400 && second.changes.length > 0) await publishCatalog(deps);
    // the repoint stands even when the removal could not be committed: say so, keep the 200
    return done.status >= 400 ? { status: 200, body: { ...report, removed: [], kept: report.drop.map((d) => ({ id: d.id, reason: 'Not removed: the removal could not be saved.' })) } } : done;
  });
}
