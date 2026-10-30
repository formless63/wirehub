/**
 * The released document manifest — `GET /api/designs/:id/versions/:rev/documents`
 * (`docs/document-manifest.md`).
 *
 * One locked saved revision's whole document package: every document kind in each format it
 * comes in (except the CSVs, which the exports already are, and the label PNG/LBX prints), and
 * every base export, each with the URL that downloads it, the exact SHA-256 of the bytes that URL
 * returns, its size and its render key. `packageHash` hashes the names and content hashes only,
 * so a receiver can tell "same package" from "changed" without downloading anything.
 *
 * The renders come from the document cache (`document-cache.ts`): the first render of a revision
 * is kept and served afterwards, so a later save, a live library edit or a newer hub never moves a
 * released revision's hashes. A missing render is made lazily here (no warm-up job).
 */

import { isDesignId } from '@wirehub/catalog';
import { BASE_EXPORTS } from '@wirehub/docs';
import { stableJson, type DesignVersionFile } from '@wirehub/model';

import type { ApiResponse } from './api.ts';
import { sha256Hex } from './document-cache.ts';
import { downloadName, loadRevision, releasedOf, renderContextOf, resolveRevision, serveRevision, type DocumentDeps, type Loaded } from './documents.ts';
import { DOCUMENT_KIND_FORMATS, DOCUMENT_KINDS } from './render/index.ts';
import { runtimeEnv } from './runtime-settings.ts';

export const MANIFEST_FORMAT = 'wirehub.document-manifest';

export interface ManifestDocument {
  name: string;
  source: 'document' | 'export';
  /** the document kind (`drawing`), or the export id (`bom.csv`) */
  kind: string;
  format: string;
  url: string;
  mediaType: string;
  fileName: string;
  size: number;
  /** hex SHA-256 of the bytes `url` returns */
  sha256: string;
  renderKey: string;
  /** how a PDF was made (`browser`, `text-layout`, `raster`, `vector`) */
  renderer?: string;
}

export interface DocumentManifest {
  format: typeof MANIFEST_FORMAT;
  version: 1;
  design: { id: string; label: string; productRef?: string };
  rev: number;
  locked: true;
  released: boolean;
  approval?: { state: string; at: string; by: string };
  savedAt: string;
  versionEtag: string;
  packageHash: string;
  documents: ManifestDocument[];
  unavailable: { name: string; reason: string }[];
  links: { version: string; inputs: string; package: string };
}

/** What the manifest lists: documents (kind order, then format order), then the base exports. */
export function manifestEntries(): { name: string; source: 'document' | 'export'; kind: string; format: string }[] {
  const out: { name: string; source: 'document' | 'export'; kind: string; format: string }[] = [];
  for (const kind of DOCUMENT_KINDS) {
    for (const format of DOCUMENT_KIND_FORMATS[kind]) {
      // the CSVs are the exports below; the label PNG and LBX are prints for one printer
      if (format === 'csv' || (kind === 'labels' && (format === 'png' || format === 'lbx'))) continue;
      out.push({ name: `documents/${kind}.${format}`, source: 'document', kind, format });
    }
  }
  for (const format of BASE_EXPORTS) out.push({ name: `exports/${format.id}`, source: 'export', kind: format.id, format: format.id.slice(format.id.lastIndexOf('.') + 1) });
  return out;
}

/** `sha256:<hex>` over the stable JSON of `[name, sha256]` pairs, sorted by name. */
export function packageHashOf(documents: readonly Pick<ManifestDocument, 'name' | 'sha256'>[]): string {
  const pairs = documents.map((d) => [d.name, d.sha256] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `sha256:${sha256Hex(new TextEncoder().encode(stableJson(pairs)))}`;
}

function fail(status: number, error: string, hint?: string): ApiResponse {
  return { status, body: { error, ...(hint === undefined ? {} : { hint }) } };
}

function reasonOf(response: ApiResponse): string {
  const body = response.body as { error?: unknown; hint?: unknown } | null;
  const error = typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
  return typeof body?.hint === 'string' ? `${error} ${body.hint}` : error;
}

/** `GET /api/designs/:id/versions/:rev/documents`; `deps.versions` is there (the version router checked). */
export async function handleDocumentManifest(method: string, id: string, revText: string, deps: DocumentDeps): Promise<ApiResponse> {
  if (method !== 'GET') return fail(405, `${method} is not something this address accepts.`, 'It answers GET.');
  if (!isDesignId(id)) return fail(400, `${JSON.stringify(id)} cannot be used as a design id.`);
  if (deps.versions === undefined) return fail(501, 'This hub does not keep saved revisions.');
  if (!(await deps.designs.has(id))) return fail(404, `There is no design called '${id}'.`, 'Pick one from GET /api/designs.');
  const rev = await resolveRevision(deps, id, revText);
  if (typeof rev !== 'number') return rev;
  const file = await deps.versions.read(id, rev);
  if (file === undefined) return fail(404, `'${id}' has no saved Rev ${rev}.`, 'GET /api/designs/:id/versions lists the revisions.');
  if (file.unlocked !== undefined) return fail(409, `Rev ${rev} is unlocked for an edit, so its documents can still change.`, 'Lock it first (Save & lock, or Lock), then ask again.');
  return { status: 200, body: await buildManifest(deps, id, file) };
}

async function buildManifest(deps: DocumentDeps, id: string, file: DesignVersionFile): Promise<DocumentManifest> {
  const rev = file.rev;
  const context = await renderContextOf(deps, id, file);
  // the revision is loaded once, and only when something has to be rendered
  let loading: Promise<Loaded | ApiResponse> | undefined;
  const loader = (): Promise<Loaded | ApiResponse> => (loading ??= loadRevision(deps, id, rev, file));
  const base = (runtimeEnv(deps)['WIREHUB_PUBLIC_URL'] ?? '').trim().replace(/\/+$/, '');
  const enc = encodeURIComponent;
  const design = `/api/designs/${enc(id)}`;

  const documents: ManifestDocument[] = [];
  const unavailable: { name: string; reason: string }[] = [];
  for (const entry of manifestEntries()) {
    const path = entry.source === 'document' ? `${design}/documents/${entry.kind}?format=${entry.format}&rev=${rev}` : `${design}/exports/${entry.kind}?rev=${rev}`;
    let served: Awaited<ReturnType<typeof serveRevision>>;
    try {
      served = await serveRevision(deps, context, entry.name, loader);
    } catch (error) {
      unavailable.push({ name: entry.name, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (!served.ok) {
      unavailable.push({ name: entry.name, reason: reasonOf(served.response) });
      continue;
    }
    const { doc } = served;
    documents.push({
      name: entry.name,
      source: entry.source,
      kind: entry.kind,
      format: entry.format,
      url: `${base}${path}`,
      mediaType: doc.mediaType,
      fileName: downloadName(doc.fileName),
      size: doc.bytes.byteLength,
      sha256: doc.sha256,
      renderKey: served.key,
      ...(doc.renderer === undefined ? {} : { renderer: doc.renderer }),
    });
  }

  const { released } = await releasedOf(deps, id);
  return {
    format: MANIFEST_FORMAT,
    version: 1,
    design: { id, label: file.design.label, ...(file.design.productRef === undefined ? {} : { productRef: file.design.productRef }) },
    rev,
    locked: true,
    released: released === rev,
    ...(file.approval === undefined ? {} : { approval: { state: file.approval.state, at: file.approval.at, by: file.approval.by } }),
    savedAt: file.savedAt,
    versionEtag: context.versionEtag,
    packageHash: packageHashOf(documents),
    documents,
    unavailable,
    links: {
      version: `${base}${design}/versions/${rev}`,
      inputs: `${base}${design}/versions/${rev}/inputs`,
      package: `${base}/api/repro/designs/${enc(id)}/${rev}/package`,
    },
  };
}
