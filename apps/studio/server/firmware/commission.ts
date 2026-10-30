/**
 * Commissioning a unit (`docs/firmware.md` § Commissioning): the record that an operator put one
 * compiled artifact on one unit, and what they saw. WireHub never reaches a device — the server
 * has no device access and the tool runner has no network — so this is a recorded operator step,
 * with a downloadable flash bundle (the artifact, its hashes and instructions) to take to the bench.
 *
 * Authority is separate from compiling: owners may record commissioning, and editors only when an
 * owner names them (`data/settings/commissioning.json`, owner-only like the other owner settings).
 * Records are append-only (`data/firmware/commissions/<project>.json`); a correction is a new
 * record that supersedes an earlier one.
 *
 *   GET  /api/firmware/:id/commissions                 → { commissions, authority: { allowed, reason? } }
 *   POST /api/firmware/:id/commissions                 → 201 { commission }
 *   GET  /api/firmware/:id/builds/:build/bundle        → zip: firmware files, SHA256SUMS, manifest.json, README.txt
 *   GET  /api/firmware/commissions?unit=<ref>          → every project's records for one unit
 *   GET  /api/firmware/commissioning-authority         → owners only
 *   PUT  /api/firmware/commissioning-authority         → owners only, in a signed-in session
 */

import { createHash, randomBytes } from 'node:crypto';

import { zipStored } from '@wirehub/docs';
import {
  commissionInputProblems,
  METHOD_LABEL,
  RESULT_LABEL,
  UNIT_REF,
  type CommissionInput,
  type CommissioningAuthority,
  type FirmwareCommission,
} from '../../src/firmware-commission.ts';
import type { FirmwareBuild, FirmwareProject } from '../../src/firmware.ts';
import type { ApiRequest, ApiResponse, WorkbenchDeps } from '../api.ts';
import { checkIfMatch, contentETag } from '../etag.ts';
import { actorName, type StudioUser } from '../me.ts';
import { firmwareBytes } from './store.ts';
import { firmwareTargets } from './targets.ts';
import { resolveUnitRef } from '../units/resolve.ts';

export const COMMISSION_ROUTES = [
  'GET    /api/firmware/:id/commissions',
  'POST   /api/firmware/:id/commissions',
  'GET    /api/firmware/:id/builds/:build/bundle',
  'GET    /api/firmware/commissions?unit=',
  'GET    /api/firmware/commissioning-authority',
  'PUT    /api/firmware/commissioning-authority',
] as const;

/** Project ids these routes take; a project cannot be named so. */
export const RESERVED_FIRMWARE_IDS = ['commissions', 'commissioning-authority'] as const;

export const AUTHORITY_DOC = 'data/settings/commissioning.json';
export const commissionsDoc = (project: string): string => `data/firmware/commissions/${project}.json`;
export { isCommissionDocPath } from './paths.ts';

const fail = (status: number, error: string, hint?: string): ApiResponse => ({ status, body: { error, ...(hint === undefined ? {} : { hint }) } });
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

export async function readAuthority(deps: WorkbenchDeps): Promise<CommissioningAuthority> {
  const value = (await deps.docs?.read(AUTHORITY_DOC)) as Partial<CommissioningAuthority> | undefined;
  return { operators: Array.isArray(value?.operators) ? value.operators.filter((e): e is string => typeof e === 'string') : [] };
}

export async function readCommissions(deps: WorkbenchDeps, project: string): Promise<FirmwareCommission[]> {
  const value = await deps.docs?.read(commissionsDoc(project));
  return Array.isArray(value) ? (value as FirmwareCommission[]) : [];
}

const isOwner = (user: StudioUser | undefined): boolean => user === undefined || user.role === undefined || user.role === 'owner';

/** Whether this person may record commissioning; compiling rights do not carry over. */
export function commissionAuthority(user: StudioUser | undefined, authority: CommissioningAuthority): { allowed: boolean; reason?: string } {
  if (user?.apiTokenId !== undefined) return { allowed: false, reason: 'Commissioning is recorded in a signed-in session, not with an API token.' };
  if (isOwner(user)) return { allowed: true };
  if (user?.role === 'viewer') return { allowed: false, reason: 'Viewers cannot record commissioning.' };
  const email = user?.email?.toLowerCase();
  if (email !== undefined && authority.operators.some((o) => o.toLowerCase() === email)) return { allowed: true };
  return { allowed: false, reason: 'Recording commissioning is authorised separately from compiling. Ask an owner to add you as a commissioning operator.' };
}

/** The inventory's built unit a reference names (a unit id, or a serial one built unit carries), when there is one. */
async function inventoryUnitOf(deps: WorkbenchDeps, ref: string, serial?: string): Promise<string | undefined> {
  try {
    return await resolveUnitRef(deps, ref, serial);
  } catch {
    // the link is a convenience: an inventory that cannot be read keeps the loose reference
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Routes under /api/firmware that are not one project
 * ------------------------------------------------------------------ */

/** `GET /api/firmware/commissions?unit=` and the authority document; undefined when not one of these. */
export async function handleCommissioningIndex(request: ApiRequest, id: string, deps: WorkbenchDeps, projects: () => Promise<FirmwareProject[]>): Promise<ApiResponse | undefined> {
  const method = request.method.toUpperCase();
  if (id === 'commissions') {
    if (method !== 'GET') return fail(405, 'GET only; record a commission on its project.');
    const unit = new URLSearchParams(request.path.split('?')[1]).get('unit')?.trim() ?? '';
    if (!UNIT_REF.test(unit)) return fail(400, 'Name the unit: ?unit=<serial, asset tag or built-unit id>.');
    const all = [];
    for (const p of await projects()) {
      for (const c of await readCommissions(deps, p.id)) {
        if (c.unit.ref === unit || c.unit.serial === unit || c.unit.inventoryUnit === unit) all.push({ ...c, projectLabel: p.label });
      }
    }
    all.sort((a, b) => b.performedAt.localeCompare(a.performedAt));
    return { status: 200, body: { unit, commissions: all } };
  }
  if (id === 'commissioning-authority') {
    const user = request.user ?? deps.localUser;
    if (!isOwner(user)) return fail(403, 'Who may record commissioning is shown to owners.');
    const current = await readAuthority(deps);
    const etag = contentETag(current);
    if (method === 'GET') return { status: 200, body: { ...current, etag }, headers: { ETag: etag } };
    if (method !== 'PUT') return fail(405, 'This address accepts GET and PUT.');
    if (user?.apiTokenId !== undefined) return fail(403, 'Commissioning operators are changed in a signed-in session, not with an API token.');
    const guard = checkIfMatch(request.headers?.['if-match'], etag, 'commissioning operators', 'commissioning');
    if (guard !== undefined) return guard;
    const operators = (request.body as { operators?: unknown } | undefined)?.operators;
    if (!Array.isArray(operators) || operators.length > 200 || operators.some((o) => typeof o !== 'string' || !EMAIL.test(o.trim()))) {
      return fail(400, 'Send { operators: [email, …] } — the sign-in emails of the people who may record commissioning.');
    }
    const next: CommissioningAuthority = { operators: [...new Set(operators.map((o: string) => o.trim().toLowerCase()))].sort() };
    await deps.docs!.write(AUTHORITY_DOC, next);
    const tag = contentETag(next);
    return { status: 200, body: { ...next, etag: tag }, headers: { ETag: tag } };
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * One project's commissions and flash bundles
 * ------------------------------------------------------------------ */

const isFirmwareOutput = (o: { role: string }): boolean => o.role === 'firmware';

/** `builds` reads the project's build history (`job.ts`; passed in so this module stays out of the router's import cycle). */
export async function handleProjectCommissioning(request: ApiRequest, project: FirmwareProject, action: string, rest: string[], deps: WorkbenchDeps, builds: () => Promise<FirmwareBuild[]>): Promise<ApiResponse | undefined> {
  const method = request.method.toUpperCase();
  if (action === 'commissions' && rest.length === 0) {
    const user = request.user ?? deps.localUser;
    const authority = commissionAuthority(user, await readAuthority(deps));
    if (method === 'GET') return { status: 200, body: { commissions: await readCommissions(deps, project.id), authority } };
    if (method !== 'POST') return fail(405, 'This address accepts GET and POST.');
    if (!authority.allowed) return fail(403, 'You may not record commissioning on this hub.', authority.reason);
    return await recordCommission(request, user, project, deps, builds);
  }
  if (action === 'builds' && rest.length === 2 && rest[1] === 'bundle') {
    if (method !== 'GET') return fail(405, 'GET only.');
    return await flashBundle(project, rest[0] ?? '', builds);
  }
  return undefined;
}

async function recordCommission(request: ApiRequest, user: StudioUser | undefined, project: FirmwareProject, deps: WorkbenchDeps, builds: () => Promise<FirmwareBuild[]>): Promise<ApiResponse> {
  const now = new Date();
  const problems = commissionInputProblems(request.body, now.getTime());
  if (problems.length > 0) return { status: 400, body: { error: 'The commissioning record cannot be saved.', problems } };
  const input = request.body as CommissionInput;
  const build = (await builds()).find((b) => b.id === input.build);
  if (build === undefined) return fail(404, 'This project has no such build.', 'Commission from a build that is still listed on the project.');
  if (build.status !== 'ok') return fail(409, 'Only a build that compiled can be commissioned.');
  const artifact = build.outputs.find((o) => o.sha256 === input.artifact);
  if (artifact === undefined || !isFirmwareOutput(artifact)) return fail(400, 'That artifact is not a firmware output of this build.');
  const existing = await readCommissions(deps, project.id);
  if (input.supersedes !== undefined && !existing.some((c) => c.id === input.supersedes)) return fail(400, 'The record it supersedes is not one of this project’s.');
  const recordedBy = actorName(user) ?? 'unknown';
  const ref = input.unit.ref.trim();
  const serial = input.unit.serial?.trim() || undefined;
  const inventoryUnit = await inventoryUnitOf(deps, ref, serial);
  const commission: FirmwareCommission = {
    id: `cm-${randomBytes(6).toString('hex')}`,
    project: project.id,
    performedAt: input.performedAt === undefined ? now.toISOString() : new Date(input.performedAt).toISOString(),
    operator: input.operator?.trim() || recordedBy,
    recordedAt: now.toISOString(),
    recordedBy,
    unit: { ref, ...(serial === undefined ? {} : { serial }), ...(inventoryUnit === undefined ? {} : { inventoryUnit }) },
    build: build.id,
    ...(build.occurrence === undefined ? {} : { occurrence: build.occurrence }),
    artifact: { path: artifact.path, sha256: artifact.sha256, role: artifact.role, bytes: artifact.bytes },
    toolchain: {
      target: build.effective.target,
      ...(build.pack === undefined ? {} : { pack: build.pack }),
      ...(build.packVersion === undefined ? {} : { packVersion: build.packVersion }),
      ...(build.imageId === undefined ? {} : { imageId: build.imageId }),
    },
    method: input.method,
    result: input.result,
    observed: (input.observed ?? '').trim(),
    ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
    ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
  };
  await deps.docs!.write(commissionsDoc(project.id), [commission, ...existing]);
  return { status: 201, body: { commission } };
}

/** The shas a project's commissions name: still downloadable after their build drops off the list. */
export async function commissionedShas(deps: WorkbenchDeps, project: string): Promise<{ path: string; sha256: string }[]> {
  return (await readCommissions(deps, project)).map((c) => c.artifact);
}

/* ------------------------------------------------------------------ *
 * The flash bundle
 * ------------------------------------------------------------------ */

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** How to put one artifact on a unit of this target: guidance for the operator, not a script WireHub runs. */
function flashSteps(build: FirmwareBuild, files: string[], platform: string): string[] {
  const has = (ext: string): string | undefined => files.find((f) => f.endsWith(ext));
  const bin = has('.bin');
  if (build.effective.target === 'esphome') {
    return [
      `First flash over USB: write ${has('.factory.bin') ?? 'firmware.factory.bin'} at offset 0x0, for example with ESPHome Web (web.esphome.io) or`,
      `  esptool.py --port <PORT> write_flash 0x0 ${has('.factory.bin') ?? 'firmware.factory.bin'}`,
      `Later updates over the air: upload ${has('.ota.bin') ?? 'firmware.ota.bin'} through the device's OTA (esphome upload, or its web server).`,
    ];
  }
  if (platform.includes('espressif8266')) {
    return [`esptool.py --chip esp8266 --port <PORT> --baud 460800 write_flash 0x0 ${bin ?? 'firmware.bin'}`];
  }
  if (platform.includes('espressif32')) {
    return [
      `esptool.py --chip esp32 --port <PORT> --baud 460800 write_flash 0x10000 ${bin ?? 'firmware.bin'}`,
      'This writes the application only, at 0x10000: it expects the bootloader and partition table the Arduino core installs to be on the chip already.',
      'A blank chip needs those first (pio run -t upload from the same source, or the core’s bootloader.bin at 0x1000 and partitions.bin at 0x8000).',
    ];
  }
  if (platform.includes('atmelavr')) {
    return [`avrdude -p atmega328p -c arduino -P <PORT> -b 115200 -U flash:w:${has('.hex') ?? 'firmware.hex'}:i`];
  }
  if (platform.includes('raspberrypi') || has('.uf2') !== undefined) {
    return [`Hold BOOTSEL while plugging the board in; it shows up as a drive (RPI-RP2). Copy ${has('.uf2') ?? 'firmware.uf2'} onto it; the board restarts with the new firmware.`];
  }
  return [`Flash ${files.join(', ')} with the vendor tool for ${build.effective.target}.`];
}

async function flashBundle(project: FirmwareProject, buildId: string, builds: () => Promise<FirmwareBuild[]>): Promise<ApiResponse> {
  const build = (await builds()).find((b) => b.id === buildId);
  if (build === undefined) return fail(404, 'This project has no such build.');
  if (build.status !== 'ok') return fail(409, 'Only a build that compiled has a flash bundle.');
  const outputs = build.outputs.filter(isFirmwareOutput);
  if (outputs.length === 0) return fail(409, 'This build has no firmware file.');
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const o of outputs) {
    const bytes = await firmwareBytes().get(o.sha256);
    if (bytes === undefined) return fail(404, `The bytes of ${o.path} are no longer stored.`);
    if (sha256(bytes) !== o.sha256) return fail(500, `${o.path} does not match its recorded hash.`);
    entries.push({ name: `firmware/${o.path}`, data: bytes });
  }
  const platform = firmwareTargets().find((t) => t.id === build.effective.target)?.platform ?? '';
  const files = outputs.map((o) => `firmware/${o.path}`);
  const enc = new TextEncoder();
  const sums = outputs.map((o) => `${o.sha256}  firmware/${o.path}`).join('\n') + '\n';
  const manifest = {
    project: { id: project.id, label: project.label, ...(project.board === undefined ? {} : { board: project.board }) },
    build: { id: build.id, startedAt: build.startedAt, ...(build.occurrence === undefined ? {} : { occurrence: build.occurrence }) },
    target: build.effective.target,
    defines: build.effective.defines,
    source: build.effective.source,
    toolchain: { pack: build.pack, packVersion: build.packVersion, image: build.image, imageId: build.imageId, tool: build.tool, ...build.toolchain },
    firmware: outputs.map((o) => ({ path: `firmware/${o.path}`, sha256: o.sha256, bytes: o.bytes, mediaType: o.mediaType })),
  };
  const readme = [
    `${project.label} — flash bundle`,
    '',
    `Build ${build.id} (${build.effective.target}${build.occurrence === undefined ? ', project defaults' : `, for ${build.occurrence.design} / ${build.occurrence.instance}`}).`,
    'WireHub made these files; it does not flash devices. Flashing is done at the bench by an operator.',
    '',
    '1. Check the files: sha256sum -c SHA256SUMS',
    '2. Flash:',
    ...flashSteps(build, files, platform).map((s) => `   ${s}`),
    '3. Power-cycle the unit and observe it (boot messages, indicators, a self-test).',
    `4. Record it in WireHub: the project's Commissioning section → Record commissioning, naming build ${build.id},`,
    '   the unit (serial or built-unit id), the method and what you observed. A failed attempt is worth recording too.',
    '',
    `Methods: ${Object.values(METHOD_LABEL).join(' · ')}.`,
    `Results: ${Object.values(RESULT_LABEL).join(' · ')}.`,
    '',
  ].join('\n');
  entries.push({ name: 'SHA256SUMS', data: enc.encode(sums) });
  entries.push({ name: 'manifest.json', data: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`) });
  entries.push({ name: 'README.txt', data: enc.encode(readme) });
  const zip = zipStored(entries);
  const name = `${project.id}-${build.id}-flash.zip`;
  return {
    status: 200, body: null, bytes: Buffer.from(zip), contentType: 'application/zip',
    headers: { 'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' },
  };
}
