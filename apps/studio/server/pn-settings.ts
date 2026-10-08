/**
 * The numbering scheme as a setting (declarative part-number schemes):
 *
 *   GET  /api/settings/part-numbers           the stored definition, the scheme in force, the packs' offers
 *   PUT  /api/settings/part-numbers           { scheme } | { scheme: null } | { adoptFrom: "<pack id>" }
 *   POST /api/settings/part-numbers/preview   { scheme, samples?, suggest? } — check a definition before saving it
 *
 * The scheme is `data/part-numbers.json`: the prefix scheme's configuration, or a
 * declarative definition (`@wirehub/model` `pn-declarative.ts`). An owner or an
 * editor edits it; adopting the one a pack offers (`wirehub-pack.json`
 * `partNumberScheme`) is an owner's confirmation, in a signed-in session. Saving a
 * scheme never rewrites a number: numbers that do not fit it are reported by the
 * part-number health page and kept as they are.
 */

import {
  DEFAULT_PREFIX_SCHEME_CONFIG,
  PN_KINDS,
  declarativeSchemeProblems,
  isDeclarativeSchemeConfig,
  knownPartNumbers,
  partNumberReport,
  schemeFromConfig,
  type CableDesign,
  type PartNumberScheme,
  type PnKind,
} from '@wirehub/model';

import type { ApiResponse, WorkbenchDeps } from './api.ts';
import { readAllDesigns } from './designs.ts';
import { checkIfMatch, contentETag } from './etag.ts';
import type { StudioUser } from './me.ts';
import { partNumberSchemeOf } from './part-number-scheme.ts';

export const PN_SETTINGS_PATH = 'data/part-numbers.json';

export const PN_SETTINGS_ROUTES = ['GET    /api/settings/part-numbers', 'PUT    /api/settings/part-numbers', 'POST   /api/settings/part-numbers/preview'] as const;

const fail = (status: number, error: string, hint?: string, extra?: object): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }), ...(extra ?? {}) } });

export const isPnSettingsPath = (parts: string[]): boolean => parts[0] === 'api' && parts[1] === 'settings' && parts[2] === 'part-numbers';

const isOwner = (user: StudioUser | undefined): boolean => user === undefined || user.role === undefined || user.role === 'owner';

function describe(scheme: PartNumberScheme, kind: 'prefix' | 'declarative' | 'module' | 'default'): Record<string, unknown> {
  return { kind, id: scheme.id, label: scheme.label, ...(scheme.shape === undefined ? {} : { shape: scheme.shape }), immutable: scheme.immutable === true };
}

/** Why a definition cannot be used, one sentence per problem; empty when it can. */
export function schemeConfigProblems(config: unknown): string[] {
  if (isDeclarativeSchemeConfig(config)) return declarativeSchemeProblems(config);
  try {
    schemeFromConfig(config);
    return [];
  } catch (error) {
    return [(error instanceof Error ? error.message : String(error)).replace(/^part-numbers\.json: /, '')];
  }
}

async function view(deps: WorkbenchDeps, stored: unknown): Promise<Record<string, unknown>> {
  const moduleScheme = deps.modules?.partNumberScheme();
  const inForce = await partNumberSchemeOf(deps);
  const offers = ((await deps.installedPacks?.())?.packs ?? []).flatMap((p) => (p.partNumberScheme === undefined ? [] : [{ pack: p.id, version: p.version, scheme: p.partNumberScheme, problems: schemeConfigProblems(p.partNumberScheme) }]));
  return {
    config: stored ?? null,
    effective: describe(inForce, moduleScheme !== undefined ? 'module' : stored === undefined ? 'default' : isDeclarativeSchemeConfig(stored) ? 'declarative' : 'prefix'),
    ...(moduleScheme === undefined ? {} : { overriddenByModule: true }),
    defaults: DEFAULT_PREFIX_SCHEME_CONFIG,
    kinds: PN_KINDS,
    offers,
  };
}

async function impact(deps: WorkbenchDeps, scheme: PartNumberScheme): Promise<Record<string, unknown>> {
  const db = await deps.loadDb();
  const designs: CableDesign[] = await readAllDesigns(deps.designs);
  const drawings: Record<string, { partNumber?: string }> = {};
  for (const d of designs) {
    try {
      const meta = (await deps.drawings?.read(d.id))?.meta;
      if (meta !== undefined) drawings[d.id] = meta;
    } catch {
      // an unreadable sidecar carries no number
    }
  }
  const report = partNumberReport(db, designs, drawings, scheme);
  return { numbered: report.numbered, notInScheme: report.format.length, duplicates: report.duplicates.length, unnumbered: report.unnumbered.length, examples: report.format.slice(0, 5).map((f) => ({ pn: f.holder.pn, where: f.holder.where, message: f.message })) };
}

async function preview(body: unknown, deps: WorkbenchDeps): Promise<ApiResponse> {
  const input = (typeof body === 'object' && body !== null ? body : {}) as { scheme?: unknown; samples?: unknown; suggest?: unknown };
  const problems = schemeConfigProblems(input.scheme);
  if (problems.length > 0) return { status: 200, body: { ok: false, problems } };
  const scheme = schemeFromConfig(input.scheme);
  const samples = (Array.isArray(input.samples) ? input.samples : []).slice(0, 50).flatMap((s) => {
    const o = (typeof s === 'string' ? { pn: s } : s) as { pn?: unknown; kind?: unknown };
    if (typeof o?.pn !== 'string') return [];
    const kind = (PN_KINDS as readonly unknown[]).includes(o.kind) ? (o.kind as PnKind) : undefined;
    return [{ pn: o.pn, canonical: scheme.parse(o.pn) ?? null, issues: scheme.check(o.pn, kind) }];
  });
  const db = await deps.loadDb();
  const designs = await readAllDesigns(deps.designs);
  const known = knownPartNumbers(db, designs.map((d) => ({ id: d.id, label: d.label, ...(d.productRef === undefined ? {} : { productRef: d.productRef }) })));
  const suggestions = (Array.isArray(input.suggest) ? input.suggest : []).slice(0, 20).flatMap((s) => {
    const o = s as { kind?: unknown; variantOf?: unknown };
    if (!(PN_KINDS as readonly unknown[]).includes(o?.kind)) return [];
    const kind = o.kind as PnKind;
    const got = scheme.suggest({ kind, label: 'new part', ...(typeof o.variantOf === 'string' ? { variantOf: o.variantOf } : {}) }, known);
    return [{ kind, suggestion: got ?? null }];
  });
  return { status: 200, body: { ok: true, shape: scheme.shape ?? null, immutable: scheme.immutable === true, samples, suggestions, impact: await impact(deps, scheme) } };
}

export async function handlePartNumberSettings(method: string, parts: string[], body: unknown, deps: WorkbenchDeps, ifMatch: string | undefined, user: StudioUser | undefined): Promise<ApiResponse> {
  if (deps.docs === undefined) return fail(501, 'This hub does not keep catalog documents by path.', 'The numbering scheme is stored with the catalog.');
  if (parts.length === 4 && parts[3] === 'preview') {
    if (method !== 'POST') return fail(405, `${method} is not something this address accepts.`, 'It answers POST.');
    return preview(body, deps);
  }
  if (parts.length !== 3) return fail(404, `${parts.join('/')} is not part of the server API.`);
  const stored = await deps.docs.read(PN_SETTINGS_PATH);
  const etag = contentETag(stored ?? null);
  if (method === 'GET') return { status: 200, body: await view(deps, stored), headers: { ETag: etag } };
  if (method !== 'PUT') return fail(405, `${method} is not something this address accepts.`, 'It answers GET and PUT.');
  if (user?.role === 'viewer') return fail(403, 'Your role can view these settings but not change them.', 'Ask an owner for the editor role.');
  const guard = checkIfMatch(ifMatch, etag, 'settings', 'part-numbers');
  if (guard !== undefined) return guard;
  const input = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : undefined) as { scheme?: unknown; adoptFrom?: unknown } | undefined;
  if (input === undefined) return fail(400, 'Send { "scheme": { … } }, { "scheme": null } to go back to the default, or { "adoptFrom": "<pack id>" }.');
  let next: unknown;
  if (input.adoptFrom !== undefined) {
    // taking a pack's scheme replaces the hub's numbering: an owner confirms it, in a session
    if (!isOwner(user)) return fail(403, 'Switching to a pack\'s numbering scheme is confirmed by an owner.', 'Ask an owner of this hub.');
    if (user?.apiTokenId !== undefined) return fail(403, 'Switching the numbering scheme is done in a signed-in session, not with an API token.');
    const offer = ((await deps.installedPacks?.())?.packs ?? []).find((p) => p.id === input.adoptFrom);
    if (offer?.partNumberScheme === undefined) return fail(404, `Pack '${String(input.adoptFrom)}' is not installed or offers no numbering scheme.`, 'GET /api/settings/part-numbers lists the offers.');
    next = offer.partNumberScheme;
  } else if (input.scheme === null) {
    next = undefined;
  } else if (input.scheme !== undefined) {
    next = input.scheme;
  } else {
    return fail(400, 'Send { "scheme": { … } }, { "scheme": null } to go back to the default, or { "adoptFrom": "<pack id>" }.');
  }
  if (next !== undefined) {
    const problems = schemeConfigProblems(next);
    if (problems.length > 0) return fail(422, `That numbering scheme cannot be used: ${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}.`, 'Nothing was saved.', { problems });
  }
  if (next === undefined) await deps.docs.remove(PN_SETTINGS_PATH);
  else await deps.docs.write(PN_SETTINGS_PATH, next);
  const after = next === undefined ? undefined : (await deps.docs.read(PN_SETTINGS_PATH)) ?? next;
  // the answer describes the scheme just saved, not the one a module may set over it
  const answer = await view({ ...deps, loadPartNumberFiles: () => ({ scheme: after }) }, after);
  return { status: 200, body: answer, headers: { ETag: contentETag(after ?? null) } };
}
