/**
 * A model file in, a stored GLB out — the one door
 * every model goes through, whether the import script or an upload in the
 * Library brought it.
 *
 * - **Sniffed, not trusted by name.** The bytes decide: `glTF` magic → GLB,
 *   `ISO-10303-21;` → STEP, a size that matches its own triangle count (or a
 *   `solid … facet` text) → STL. The file name only has to agree.
 * - **Capped.** 24 MB in (the upload limit), `MAX_MODEL_TRIANGLES` out —
 *   heavier meshes are simplified, and the stats say so.
 * - **STEP runs in a child process, one at a time.** OpenCascade's WASM heap
 *   grows and never shrinks; a child hands it back when it exits. The parent
 *   watches the child's resident memory and kills it past `STEP_RSS_LIMIT_MB`
 *   (a refusal with a sentence, never a studio that falls over), and a queue
 *   keeps a second conversion from starting until the first is done.
 */

import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { AssemblyPlan } from './assembly.ts';
import type { BoardTextureProfile } from './cache.ts';
import type { BoardArt } from './board-texture.ts';
import { finishParts, MAX_MODEL_TRIANGLES, type ConversionStats } from './finish.ts';
import { readGlbJson } from './glb.ts';
import { isAsciiStl, isBinaryStl, parseStl, type MeshPart } from './mesh.ts';

export type ConvertOptions = { maxTriangles?: number; extras?: Record<string, string | number | boolean>; boardArt?: BoardArt; boardTextureProfile?: BoardTextureProfile };

export type ModelFormat = 'glb' | 'stl' | 'step';

/** The largest model file the studio takes (the artwork upload limit). */
export const MAX_MODEL_BYTES = 24 * 1024 * 1024;
/**
 * Past this resident size the STEP child is stopped and the file refused.
 * `WIREHUB_STEP_RSS_LIMIT_MB` lowers it where the process shares a memory
 * cap with its parent (the compose worker: 1.5 GiB in all, S6).
 */
export const STEP_RSS_LIMIT_MB = Number(process.env.WIREHUB_STEP_RSS_LIMIT_MB ?? '') > 0 ? Number(process.env.WIREHUB_STEP_RSS_LIMIT_MB) : 1400;
/** A STEP that has not finished by now never will on this box. */
export const STEP_TIMEOUT_MS = 180_000;

export class ModelRefusal extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.hint = hint;
  }
}

/** What the bytes are, whatever the name says; `undefined` for anything else. */
export function sniffModel(bytes: Uint8Array): ModelFormat | undefined {
  if (bytes.byteLength >= 12) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === 0x46546c67) return 'glb';
  }
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 64))).trimStart();
  if (head.startsWith('ISO-10303-21')) return 'step';
  if (isBinaryStl(bytes) || isAsciiStl(bytes)) return 'stl';
  return undefined;
}

const EXTENSIONS: Record<ModelFormat, RegExp> = {
  glb: /\.glb$/i,
  stl: /\.stl$/i,
  step: /\.(step|stp)$/i,
};

/**
 * An uploaded GLB is kept as sent — but only a self-contained one: every
 * buffer and image inside the file, nothing fetched from anywhere else (the
 * viewer loads models from the asset API and nowhere else).
 */
export function checkGlb(bytes: Uint8Array): void {
  const json = readGlbJson(bytes);
  if (json === undefined) throw new ModelRefusal('That GLB file is damaged or not a binary glTF 2.0 file.', 'Export it again as .glb (binary glTF 2.0).');
  const buffers = (json['buffers'] as { uri?: unknown }[] | undefined) ?? [];
  const images = (json['images'] as { uri?: unknown }[] | undefined) ?? [];
  if ([...buffers, ...images].some((entry) => entry.uri !== undefined)) {
    throw new ModelRefusal('That GLB points at files outside itself.', 'Export it with everything embedded (a single self-contained .glb).');
  }
}

export interface ConvertedModel {
  glb: Uint8Array;
  format: ModelFormat;
  stats: ConversionStats;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs `job` after every earlier one has settled — one conversion at a time. */
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => undefined);
  return next;
}

/** Several files of one part (a housing's top and bottom) → one GLB, side by side if they overlap. */
export async function convertModelFiles(
  files: readonly { bytes: Uint8Array; name: string; partName?: string }[],
  options: ConvertOptions = {},
): Promise<ConvertedModel> {
  const maxTriangles = options.maxTriangles ?? MAX_MODEL_TRIANGLES;
  if (files.length === 1) return convertModel(files[0]!.bytes, files[0]!.name, options);
  if ((options.boardTextureProfile === 'occurrence' || options.boardTextureProfile === 'appearance') && files.reduce((n, f) => n + f.bytes.byteLength, 0) > MAX_MODEL_BYTES * 2) throw new ModelRefusal('Combined models exceed the conversion size limit.', 'Leave the heaviest model files out.');
  const parts: MeshPart[] = [];
  for (const file of files) {
    if (sniffModel(file.bytes) !== 'stl') throw new ModelRefusal(`${file.name} is not an STL.`, 'Only STL files are combined into one model.');
    parts.push(parseStl(file.bytes, file.partName ?? file.name));
  }
  if ((options.boardTextureProfile === 'occurrence' || options.boardTextureProfile === 'appearance')) {
    // Even source-only STL profiles verify the pinned artifact inside the capped
    // child. The Studio process never acquires the optional WASM heap.
    return serial(() => convertStepInChild(new Uint8Array(), 'combined.stl', maxTriangles, undefined, options.boardArt, options.boardTextureProfile, files));
  }
  const started = performance.now();
  const finished = finishParts(parts, maxTriangles, { source: 'stl', ...(options.extras ?? {}) }, true);
  return { glb: finished.glb, format: 'stl', stats: { ...finished.stats, ms: Math.round(performance.now() - started) } };
}

/** One model file → the GLB the store keeps. Throws `ModelRefusal` with a sentence. */
export async function convertModel(
  bytes: Uint8Array,
  name: string,
  options: ConvertOptions = {},
): Promise<ConvertedModel> {
  const maxTriangles = options.maxTriangles ?? MAX_MODEL_TRIANGLES;
  if (bytes.byteLength === 0) throw new ModelRefusal('That file is empty.', 'Pick the model file again.');
  if (bytes.byteLength > MAX_MODEL_BYTES) {
    throw new ModelRefusal(
      `That model is ${(bytes.byteLength / 1048576).toFixed(1)} MB; WireHub takes up to ${MAX_MODEL_BYTES / 1048576} MB.`,
      'Export a lighter version (fewer bodies, or STL at a coarser resolution).',
    );
  }
  const format = sniffModel(bytes);
  if (format === undefined) throw new ModelRefusal('That is not an STL, STEP or GLB file.', 'WireHub reads .stl, .step/.stp and .glb models.');
  if (!EXTENSIONS[format].test(name)) {
    throw new ModelRefusal(`${name} holds ${format.toUpperCase()} data, but its name says otherwise.`, `Rename it to end in .${format === 'step' ? 'step' : format} and try again.`);
  }
  const started = performance.now();
  if (format === 'glb') {
    checkGlb(bytes);
    return { glb: bytes, format, stats: { triangles: 0, sourceTriangles: 0, simplified: false, parts: 0, glbBytes: bytes.byteLength, ms: 0 } };
  }
  if (format === 'stl') {
    let part: MeshPart;
    try {
      part = parseStl(bytes, name.replace(/\.stl$/i, ''));
    } catch (error) {
      throw new ModelRefusal((error as Error).message, 'Export it again as STL.');
    }
    const finished = finishParts([part], maxTriangles, { source: 'stl', ...(options.extras ?? {}) });
    return { glb: finished.glb, format, stats: { ...finished.stats, ms: Math.round(performance.now() - started) } };
  }
  return serial(() => convertStepInChild(bytes, name, maxTriangles, undefined, options.boardArt, options.boardTextureProfile));
}

/**
 * A board built from its KiCad file, or one library part placed with an
 * offset: every model file read and placed in the
 * same memory-capped child, in the same one-at-a-time queue.
 */
export async function convertAssembly(plan: AssemblyPlan, name: string, options: { maxTriangles?: number; boardArt?: BoardArt; boardTextureProfile?: BoardTextureProfile } = {}): Promise<ConvertedModel> {
  const bytes = plan.models.reduce((n, m) => n + m.bytes.byteLength, 0);
  if (bytes > MAX_MODEL_BYTES * 2) {
    throw new ModelRefusal(`${name}'s models add up to ${(bytes / 1048576).toFixed(1)} MB, more than WireHub converts at once.`, 'Leave the heaviest part models out.');
  }
  return serial(() => convertStepInChild(new Uint8Array(0), name, options.maxTriangles ?? MAX_MODEL_TRIANGLES, plan, options.boardArt, options.boardTextureProfile));
}

interface ChildAnswer {
  ok: boolean;
  glb?: Uint8Array;
  stats?: ConversionStats;
  error?: string;
}

/** VmRSS of a live process, MiB (Linux); `undefined` elsewhere. */
function residentMb(pid: number): number | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const kb = /VmRSS:\s+(\d+)\s*kB/.exec(status)?.[1];
    return kb === undefined ? undefined : Number(kb) / 1024;
  } catch {
    return undefined;
  }
}

function convertStepInChild(bytes: Uint8Array, name: string, maxTriangles: number, assembly?: AssemblyPlan, boardArt?: BoardArt, boardTextureProfile?: BoardTextureProfile, stlFiles?: readonly { bytes: Uint8Array; name: string; partName?: string }[]): Promise<ConvertedModel> {
  return new Promise((resolve, reject) => {
    const worker = fileURLToPath(new URL('./convert-worker.ts', import.meta.url));
    const child = fork(worker, [], {
      execArgv: ['--experimental-strip-types', '--no-warnings', '--max-old-space-size=768'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let settled = false;
    let peak = 0;
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
    });
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(watch);
      clearTimeout(timer);
      outcome();
    };
    const refuse = (message: string, hint: string): void => {
      child.kill('SIGKILL');
      finish(() => reject(new ModelRefusal(message, hint)));
    };
    const watch = setInterval(() => {
      const mb = child.pid === undefined ? undefined : residentMb(child.pid);
      if (mb === undefined) return;
      peak = Math.max(peak, mb);
      if (mb > STEP_RSS_LIMIT_MB) {
        refuse(
          `${name} needed more than ${STEP_RSS_LIMIT_MB} MB to convert, so WireHub stopped.`,
          'Export a lighter STEP (fewer bodies, or without the component models), or export STL/GLB from the CAD tool instead.',
        );
      }
    }, 100);
    const timer = setTimeout(
      () => refuse(`${name} took longer than ${STEP_TIMEOUT_MS / 1000} s to convert, so WireHub stopped.`, 'Export a lighter STEP, or STL/GLB from the CAD tool instead.'),
      STEP_TIMEOUT_MS,
    );
    child.on('message', (answer: ChildAnswer) => {
      if (answer.ok && answer.glb !== undefined && answer.stats !== undefined) {
        const stats = { ...answer.stats, peakRssMb: Math.max(answer.stats.peakRssMb ?? 0, Math.round(peak)) };
        finish(() => resolve({ glb: new Uint8Array(answer.glb!), format: stlFiles === undefined ? 'step' : 'stl', stats }));
      } else {
        finish(() => reject(new ModelRefusal(`${name} could not be converted: ${answer.error ?? 'unknown error'}.`, 'Check the file opens in a CAD tool, or export STL/GLB instead.')));
      }
    });
    child.on('exit', (code, signal) => {
      finish(() =>
        reject(
          new ModelRefusal(
            `The STEP converter stopped (${signal ?? `exit ${code}`}) before finishing ${name}.`,
            `Export a lighter STEP, or STL/GLB instead.${stderr.trim() === '' ? '' : ` (${stderr.trim().split('\n').slice(-1)[0]})`}`,
          ),
        ),
      );
    });
    child.send({ bytes, name, maxTriangles, ...(assembly === undefined ? {} : { assembly }), ...(boardArt === undefined ? {} : { boardArt }), ...(boardTextureProfile === undefined ? {} : { boardTextureProfile }), ...(stlFiles === undefined ? {} : { stlFiles }) });
  });
}
