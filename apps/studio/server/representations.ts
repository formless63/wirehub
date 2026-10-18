/** Shared presentation choices, stored through the same document/UoW seam on files and Postgres. */
import { createHash } from 'node:crypto';
import { parseDepictionMeta } from '@wirehub/catalog';
import { resolveCover, type CoverChoice, type RepresentationCandidate, type RepresentationView } from '../src/representations.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from './api.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import { isDepictionDefId } from './depictions.ts';

export const REPRESENTATION_ROUTES = ['GET    /api/representations/pcbas/:id', 'PUT    /api/representations/pcbas/:id'] as const;
export const coverPath = (id: string): string => `data/presentation/covers/pcbas/${id}.json`;
const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const fail = (status: number, error: string): ApiResponse => ({ status, body: { error } });

export async function handleRepresentationRequest(request: ApiRequest, parts: string[], deps: WorkbenchDeps): Promise<ApiResponse> {
  const [, , kind, id] = parts;
  if (parts.length !== 4 || kind !== 'pcbas' || !isDepictionDefId(id)) return fail(404, 'There is no representation at this address.');
  // These endpoints describe working records only. Historical geometry must come from a frozen
  // revision's depiction source, never by silently treating ?rev as a live read.
  if (new URLSearchParams(request.path.split('?')[1]).has('rev')) return fail(400, 'This address describes the working board. Open the saved revision for historical artwork.');
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'PUT') return fail(405, 'This address accepts GET and PUT.');
  const board = (await deps.loadDb()).pcbas.find((b) => b.id === id);
  if (board === undefined) return fail(404, 'That board is not in the library.');
  if (deps.docs === undefined) return fail(501, 'This hub cannot store cover choices.');
  const path = coverPath(id);
  const choice = (await deps.docs.read(path) ?? null) as CoverChoice | null;
  const identity = { record: `pcbas/${id}`, revision: board.revision, ...(board.build === undefined ? {} : { build: board.build }) };
  const candidates: RepresentationCandidate[] = [];
  const raw = await deps.depictions?.readMeta(id);
  const parsed = raw === undefined ? undefined : parseDepictionMeta(raw, `cover/${id}`);
  const meta = parsed?.issues.some((issue) => issue.severity === 'error') === true ? undefined : parsed?.meta;
  if (meta !== undefined && meta.defId === id) {
    const order = ['board-top', 'board-bottom', 'illustration', 'schematic-symbol'];
    for (const view of order) {
      const asset = meta.views[view];
      if (asset === undefined) continue;
      const bytes = await deps.depictions?.readAsset(id, asset.file);
      const sha = bytes === undefined ? undefined : digest(bytes);
      const sources = meta.sources ?? [];
      // Same native input/version/build may regenerate its output without losing the choice.
      // An upload without native source hashes is its own lineage and changes when replaced.
      const lineage = digest(JSON.stringify({ identity, view, sourceKind: asset.sourceKind,
        sources: sources.length === 0 ? sha ?? null : [...sources].sort((a, b) => a.role.localeCompare(b.role) || a.path.localeCompare(b.path)) }));
      candidates.push({ view, label: view === 'board-top' ? 'Board top' : view === 'board-bottom' ? 'Board bottom'
        : asset.sourceKind === 'photo' ? 'Photo' : view === 'illustration' ? 'Artwork' : 'Schematic',
        identity, lineage, ...(sha === undefined ? {} : { asset: sha }), sourceKind: asset.sourceKind,
        fidelity: asset.sourceKind === 'kicad' ? 'Native outline and pads' : asset.sourceKind === 'gerber' ? 'Fabrication-layer artwork' : asset.sourceKind === 'photo' ? 'Stored photograph' : 'Stored artwork',
        limitations: asset.sourceKind === 'kicad' ? ['No component models or fabrication-layer rendering in this preview.'] : [],
        src: asset.src, sources,
        ...(asset.widthUnits === undefined || asset.heightUnits === undefined ? {} : {
          frame: { width: asset.widthUnits, height: asset.heightUnits, mmPerUnit: asset.mmPerUnit, origin: 'top-left', yAxis: 'down' },
        }), ...(asset.mirrorOf === undefined ? {} : { mirrorOf: asset.mirrorOf, mirrorAxis: asset.mirrorAxis ?? 'x' }) });
    }
  }
  const current: RepresentationView = { identity, choice, candidates };
  // Include the available sources in the ETag so an intervening import also refuses a stale choice.
  const etag = contentETag(current);
  const answer = (value: RepresentationView): ApiResponse => ({ status: 200, body: { ...value, resolution: resolveCover(value) }, headers: { ETag: contentETag(value) } });
  if (method === 'GET') return answer(current);
  const guard = checkIfMatch(request.headers?.['if-match'], etag, 'cover', identity.record);
  if (guard !== undefined) return guard;
  if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)
    || !('choice' in request.body)) return fail(400, 'Send a cover choice, or null for automatic.');
  const value = request.body.choice;
  if (value === null) {
    await deps.docs.remove(path);
    return answer({ ...current, choice: null });
  }
  if (typeof value !== 'object' || Array.isArray(value) || !('view' in value) || !('lineage' in value)) return fail(400, 'Choose one of the available previews.');
  const candidate = candidates.find((c) => c.view === value.view && c.lineage === value.lineage && c.asset !== undefined);
  if (candidate === undefined) return fail(409, 'That preview is unavailable or changed. Reload the previews and choose again.');
  const next: CoverChoice = { view: candidate.view, lineage: candidate.lineage };
  await deps.docs.write(path, next);
  return answer({ ...current, choice: next });
}
