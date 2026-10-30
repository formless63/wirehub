/**
 * Portable packages: a zip a person can take away and check without the hub. Inside one top
 * folder:
 *
 *   manifest.json   what it is, every file with its sha256 and size, the tool runs (pack,
 *                   version, image id, tool) and the exact inputs they read
 *   SHA256SUMS      the same hashes for `sha256sum -c`
 *   verify.py       an offline checker (Python 3 standard library): MISSING / FAILED / EXTRA
 *   README.txt      three lines
 *   record/ inputs/ outputs/ documents/   the files
 *
 * Built from what the hub already stores (tool-run outputs by content address, stored sources,
 * saved design versions); a file that is not stored any more is named under `missing`, never
 * silently dropped.
 */

import { createHash } from 'node:crypto';

import { zipStored } from '@wirehub/docs';

import type { WorkbenchDeps } from '../api.ts';
import type { ToolRunRecord } from '../tools/outputs.ts';
import { VERIFY_PY } from './verify-py.ts';

export const PACKAGE_FORMAT = 'wirehub-package/1';
/** all files of one package together */
export const PACKAGE_MAX_BYTES = 512 * 1024 * 1024;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const enc = new TextEncoder();

export interface PackageFile {
  path: string;
  bytes: Uint8Array;
  kind: 'record' | 'input' | 'output' | 'document';
  role?: string;
  mediaType?: string;
}

export interface PackageRun {
  id: string;
  record: string;
  identity: ToolRunRecord['identity'];
  op: string;
  pack: string;
  packVersion: string;
  image: string;
  imageId: string;
  tool: ToolRunRecord['tool'];
  status: ToolRunRecord['status'];
  createdAt: string;
  params: Record<string, unknown>;
  /** the exact inputs the run read, and where each is in this package (absent: not stored any more) */
  sources: { role: string; path: string; sha256: string; file?: string }[];
  outputs: { path: string; role: string; mediaType: string; sha256: string; size: number; file?: string }[];
}

export interface PackageMissing {
  what: string;
  sha256?: string;
  why: string;
}

/** A package being filled: files by path (the same bytes may sit at two paths), within the size limit. */
export class PackageBuilder {
  readonly files = new Map<string, PackageFile>();
  readonly runs: PackageRun[] = [];
  readonly missing: PackageMissing[] = [];
  private total = 0;
  private readonly bySha = new Map<string, string>();

  add(file: PackageFile): boolean {
    if (this.files.has(file.path)) return this.files.get(file.path)!.bytes.byteLength === file.bytes.byteLength && sha256(this.files.get(file.path)!.bytes) === sha256(file.bytes);
    if (this.total + file.bytes.byteLength > PACKAGE_MAX_BYTES) {
      this.missing.push({ what: file.path, sha256: sha256(file.bytes), why: `left out: the package would pass ${PACKAGE_MAX_BYTES / 1048576} MB` });
      return false;
    }
    this.total += file.bytes.byteLength;
    this.files.set(file.path, file);
    return true;
  }

  json(path: string, value: unknown, kind: PackageFile['kind'] = 'record'): void {
    this.add({ path, bytes: enc.encode(`${JSON.stringify(value, null, 2)}\n`), kind, mediaType: 'application/json' });
  }

  /**
   * A tool run with its output bytes and the inputs it read, under `<folder>/`. `request` is the
   * job's request when it is still kept (the full parameters, inputs pinned by sha256).
   */
  async addRun(deps: WorkbenchDeps, run: ToolRunRecord, folder: string, request?: Record<string, unknown>): Promise<void> {
    const store = deps.toolOutputs;
    const outputs: PackageRun['outputs'] = [];
    for (const o of run.outputs) {
      const found = await store?.file(o.sha256);
      const path = `outputs/${folder}/${o.path}`;
      if (found === undefined || sha256(found.bytes) !== o.sha256) {
        this.missing.push({ what: `${run.record} ${run.op} output ${o.path}`, sha256: o.sha256, why: found === undefined ? 'not stored any more' : 'the stored bytes do not match their hash' });
        outputs.push({ path: o.path, role: o.role, mediaType: o.mediaType, sha256: o.sha256, size: o.size });
        continue;
      }
      const kept = this.add({ path, bytes: found.bytes, kind: 'output', role: o.role, mediaType: o.mediaType });
      outputs.push({ path: o.path, role: o.role, mediaType: o.mediaType, sha256: o.sha256, size: o.size, ...(kept ? { file: path } : {}) });
    }
    const sources: PackageRun['sources'] = [];
    for (const [i, s] of run.sources.entries()) {
      // one copy of each input, however many runs read it
      const already = this.bySha.get(s.sha256);
      if (already !== undefined) {
        sources.push({ ...s, file: already });
        continue;
      }
      const bytes = await sourceBytes(deps, s, request);
      const path = `inputs/${inputName(s, i)}`;
      if (bytes === undefined) {
        this.missing.push({ what: `${run.record} ${run.op} input ${s.path}`, sha256: s.sha256, why: 'not stored any more' });
        sources.push({ ...s });
        continue;
      }
      const kept = this.add({ path, bytes, kind: 'input', role: s.role });
      if (kept) this.bySha.set(s.sha256, path);
      sources.push({ ...s, ...(kept ? { file: path } : {}) });
    }
    if (request !== undefined) this.json(`inputs/${folder}/request.json`, withoutStaging(request), 'input');
    this.runs.push({
      id: run.id, record: run.record, identity: run.identity, op: run.op, pack: run.pack, packVersion: run.packVersion, image: run.image, imageId: run.imageId,
      tool: run.tool, status: run.status, createdAt: run.createdAt, params: run.params, sources, outputs,
    });
  }

  /** The zip: the files, then manifest.json, SHA256SUMS, verify.py and README.txt, under `top/`. */
  zip(top: string, subject: Record<string, unknown>, title: string, now: string): Uint8Array {
    const files = [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const manifest = {
      format: PACKAGE_FORMAT,
      subject,
      createdAt: now,
      files: files.map((f) => ({ path: f.path, sha256: sha256(f.bytes), size: f.bytes.byteLength, kind: f.kind, ...(f.role === undefined ? {} : { role: f.role }), ...(f.mediaType === undefined ? {} : { mediaType: f.mediaType }) })),
      runs: this.runs,
      ...(this.missing.length === 0 ? {} : { missing: this.missing }),
    };
    const sums = manifest.files.map((f) => `${f.sha256}  ${f.path}`).join('\n') + '\n';
    const readme = [
      title,
      '',
      'Check it offline:  python3 verify.py   (or: sha256sum -c SHA256SUMS)',
      'manifest.json lists every file with its sha256, and each tool run with its pack, image id and exact inputs.',
      ...(this.missing.length === 0 ? [] : ['', `${this.missing.length} item(s) are not in this package; manifest.json names each, and why, under "missing".`]),
      '',
    ].join('\n');
    const entries = [
      ...files.map((f) => ({ name: `${top}/${f.path}`, data: f.bytes })),
      { name: `${top}/manifest.json`, data: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      { name: `${top}/SHA256SUMS`, data: enc.encode(sums) },
      { name: `${top}/verify.py`, data: enc.encode(VERIFY_PY) },
      { name: `${top}/README.txt`, data: enc.encode(readme) },
    ];
    return zipStored(entries);
  }
}

/** a readable file name for an input: stored sources are named by their hash (`<sha>.kicad_pcb.txt`, `<sha>-main.kicad_sch.txt`) */
function inputName(source: { role: string; path: string; sha256: string }, i: number): string {
  const base = (source.path.split(/[/:]/).at(-1) ?? `input-${i}`).replace(/\.txt$/, '');
  const named = /^[0-9a-f]{64}-(.+)$/.exec(base);
  if (named !== null) return `${source.sha256.slice(0, 12)}-${named[1]}`;
  const ext = /^[0-9a-f]{64}(\..+)$/.exec(base);
  if (ext !== null) return `${source.role}-${source.sha256.slice(0, 12)}${ext[1]}`;
  return base;
}

/** the bytes of a source a run read: its stored document, a tool output, or an asset its job pinned */
async function sourceBytes(deps: WorkbenchDeps, source: { path: string; sha256: string }, request: Record<string, unknown> | undefined): Promise<Uint8Array | undefined> {
  const check = (bytes: Uint8Array | undefined): Uint8Array | undefined => (bytes !== undefined && sha256(bytes) === source.sha256 ? bytes : undefined);
  let doc: unknown;
  try {
    doc = await deps.docs?.read(source.path);
  } catch {
    doc = undefined;
  }
  if (typeof doc === 'string') {
    const hit = check(enc.encode(doc));
    if (hit !== undefined) return hit;
  }
  const output = check((await deps.toolOutputs?.file(source.sha256))?.bytes);
  if (output !== undefined) return output;
  const inputs = Array.isArray(request?.['inputs']) ? (request['inputs'] as { sha256?: unknown; from?: { kind?: unknown; id?: unknown } }[]) : [];
  for (const input of inputs) {
    if (input.sha256 !== source.sha256 || input.from?.kind !== 'asset' || typeof input.from.id !== 'string') continue;
    const asset = await deps.assets?.get(input.from.id);
    const hit = check(asset === undefined ? undefined : new Uint8Array(asset.bytes));
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** a job's request as it is worth keeping: staged upload bytes and re-run bookkeeping left out */
export function withoutStaging(request: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(request, (key, value: unknown) => (key === 'input' || key === 'base64' ? undefined : value))) as Record<string, unknown>;
}

export function zipResponse(bytes: Uint8Array, filename: string): { status: number; body: null; bytes: Buffer; contentType: string; headers: Record<string, string> } {
  return {
    status: 200, body: null, bytes: Buffer.from(bytes), contentType: 'application/zip',
    headers: { 'content-disposition': `attachment; filename="${filename}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' },
  };
}
