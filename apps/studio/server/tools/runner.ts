/**
 * The tool-pack runner (contract v0, `tools/README.md`): run one op of one pack
 * in a throwaway container, the equivalent of
 *
 *   docker run --rm --network none --read-only --tmpfs /tmp \
 *     -v <in>:/work/in:ro -v <out>:/work/out <image> <op> /work/in/request.json
 *
 * with a timeout, real cancellation (the container is killed), the log kept,
 * and every output re-hashed against the pack's manifest before anything is
 * registered. Only the worker builds a runner (`WIREHUB_TOOL_RUNNER=docker`);
 * the web app never reaches Docker.
 *
 * Work folders: `WIREHUB_TOOL_WORK_DIR` (default `<tmp>/wirehub-tools`). The
 * daemon must see the same files: on a host worker it bind-mounts those paths;
 * in the compose stack the folder is a named volume (`WIREHUB_TOOL_WORK_VOLUME`)
 * mounted into the worker, and each run mounts its own sub-path of it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize, relative, sep } from 'node:path';

import { dockerEngine, type DockerEngine, type DockerMount, type RegistryAuth } from './docker-engine.ts';
import { TOOL_PACKS, toolImage, toolRegistry } from './packs.ts';

export interface ToolInput {
  /** relative path under /work/in */
  path: string;
  bytes: Uint8Array;
}

export interface ToolManifestOutput {
  path: string;
  sha256: string;
  role: string;
  mediaType: string;
  size?: number;
}

export interface ToolFinding {
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface ToolManifest {
  pack: string;
  packVersion: string;
  tool: { name: string; version: string };
  op: string;
  inputs: { path: string; sha256: string }[];
  outputs: ToolManifestOutput[];
  log: string;
  status: 'ok' | 'failed';
  findings: ToolFinding[];
  /** pack-specific extras, passed through untouched (the firmware pack's `toolchain`) */
  [extra: string]: unknown;
}

export interface ToolRunRequest {
  pack: string;
  op: string;
  params?: Record<string, unknown>;
  inputs: ToolInput[];
  /** default: the pack's op timeout */
  timeoutMs?: number;
  /** aborting kills the container */
  signal?: AbortSignal;
  /** labels the container (`org.wirehub.job`) so an operator can find it */
  jobId?: string;
  /** ask for a network; refused unless the pack declares the op `network: 'opt-in'` (`packs.ts`) */
  network?: boolean;
  /** run this exact image id (`sha256:…`, a re-run of a recorded run) instead of the pack's current tag */
  imageId?: string;
}

export interface ToolRunResult {
  manifest: ToolManifest;
  /** the verified output bytes, by manifest path */
  files: Map<string, Uint8Array>;
  /** the pack's log.txt, else the container's stdout/stderr */
  log: string;
  image: { ref: string; id: string };
  exitCode: number;
  durationMs: number;
  /** sha256 of the exact request.json the pack read */
  requestSha256: string;
  /** whether the container had a network */
  network: boolean;
  /** an output's verified bytes by manifest path (throws for a path the manifest does not name) */
  read(path: string): Uint8Array;
}

export type ToolRunErrorCode = 'unknown-pack' | 'image-missing' | 'timeout' | 'cancelled' | 'crashed' | 'manifest' | 'hash-mismatch' | 'docker';

export class ToolRunError extends Error {
  readonly code: ToolRunErrorCode;
  readonly log: string | undefined;
  constructor(code: ToolRunErrorCode, message: string, log?: string) {
    super(message);
    this.name = 'ToolRunError';
    this.code = code;
    this.log = log;
  }
}

export interface ToolRunner {
  readonly describe: string;
  /** whether the pack's image is present on the runner's Docker */
  available(pack: string): Promise<{ ok: boolean; image: string; reason?: string }>;
  run(request: ToolRunRequest): Promise<ToolRunResult>;
}

/** The smaller interface other stages code against: run an op, get its verified manifest. */
export type RunToolPack = (pack: string, op: string, params: Record<string, unknown>, inputs: ToolInput[], options?: { signal?: AbortSignal; timeoutMs?: number; jobId?: string; network?: boolean }) => Promise<ToolRunResult>;

export function runToolPackWith(runner: ToolRunner): RunToolPack {
  return (pack, op, params, inputs, options = {}) => runner.run({ pack, op, params, inputs, ...options });
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A relative path that stays inside its folder. */
export function safeRelative(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const norm = normalize(path);
  return norm === path && !norm.startsWith('..') && !norm.split('/').includes('..');
}

export interface DockerToolRunnerOptions {
  engine?: DockerEngine;
  /** where run folders are made (the worker's view) */
  workDir?: string;
  /** a named volume the daemon mounts instead of bind paths; `workDir` is where the worker sees it */
  volume?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** largest single output kept (default 200 MB) and all outputs of a run (default 500 MB) */
  maxOutputBytes?: number;
  maxTotalBytes?: number;
  memoryBytes?: number;
  cpus?: number;
}

/** The label naming the runner that made a container: only that runner's sweep ever removes it (`sweep.ts`). */
export const TOOL_OWNER_LABEL = 'org.wirehub.tool-owner';

/**
 * Who this runner is on a shared Docker daemon: `WIREHUB_TOOL_OWNER`, else the work volume (each stack
 * must use its own), else the work folder. Two stacks on one host never share it.
 */
export function toolOwner(env: Readonly<Record<string, string | undefined>>, options: { volume?: string; workDir?: string } = {}): string {
  const explicit = env.WIREHUB_TOOL_OWNER?.trim();
  if (explicit) return explicit;
  const volume = options.volume ?? (env.WIREHUB_TOOL_WORK_VOLUME?.trim() || undefined);
  if (volume !== undefined) return `volume:${volume}`;
  return `dir:${options.workDir ?? (env.WIREHUB_TOOL_WORK_DIR?.trim() || join(tmpdir(), 'wirehub-tools'))}`;
}

/**
 * The login for WIREHUB_TOOL_REGISTRY pulls: WIREHUB_TOOL_REGISTRY_USER plus
 * WIREHUB_TOOL_REGISTRY_TOKEN (a read-only package token). Undefined for an anonymous registry.
 */
export function toolRegistryAuth(env: Readonly<Record<string, string | undefined>>, image?: string): RegistryAuth | undefined {
  const registry = toolRegistry(env);
  const username = env.WIREHUB_TOOL_REGISTRY_USER?.trim();
  const password = env.WIREHUB_TOOL_REGISTRY_TOKEN?.trim();
  if (registry === undefined || !username || !password) return undefined;
  // Never send a configured registry's credentials to an overridden image on another host.
  if (image !== undefined && image.split('/')[0] !== registry.split('/')[0]) return undefined;
  return { username, password, serveraddress: registry.split('/')[0] ?? registry };
}

export function dockerToolRunner(options: DockerToolRunnerOptions = {}): ToolRunner {
  const env = options.env ?? process.env;
  const engine = options.engine ?? dockerEngine(env.DOCKER_HOST?.trim() || undefined);
  const workDir = options.workDir ?? (env.WIREHUB_TOOL_WORK_DIR?.trim() || join(tmpdir(), 'wirehub-tools'));
  const volume = options.volume ?? (env.WIREHUB_TOOL_WORK_VOLUME?.trim() || undefined);
  const maxOutput = options.maxOutputBytes ?? 200 * 1024 * 1024;
  const maxTotal = options.maxTotalBytes ?? 500 * 1024 * 1024;
  const memoryBytes = options.memoryBytes ?? Number(env.WIREHUB_TOOL_MEMORY_MB ?? 3072) * 1024 * 1024;
  const cpus = options.cpus ?? Number(env.WIREHUB_TOOL_CPUS ?? 2);
  const owner = toolOwner(env, { workDir, ...(volume === undefined ? {} : { volume }) });
  // with a registry the worker pulls a missing pack image on first use (needs images/create on the proxy)
  const enginePull = toolRegistry(env) === undefined ? undefined : engine.pull?.bind(engine);
  const user = typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : undefined;
  const mount = (dir: string, target: string, readOnly: boolean): DockerMount =>
    volume === undefined
      ? { type: 'bind', source: dir, target, readOnly }
      : { type: 'volume', source: volume, target, readOnly, subpath: relative(workDir, dir).split(sep).join('/') };

  return {
    describe: `docker ${engine.describe}${volume === undefined ? '' : ` (volume ${volume})`}`,
    async available(pack) {
      if (TOOL_PACKS[pack] === undefined) return { ok: false, image: '', reason: `there is no tool pack '${pack}'` };
      const image = toolImage(pack, env);
      try {
        const id = await engine.imageId(image);
        if (id === undefined && enginePull !== undefined) return { ok: true, image };
        return id === undefined ? { ok: false, image, reason: `the image ${image} is not on the worker's Docker; build it (tools/${pack}/README.md)` } : { ok: true, image };
      } catch (error) {
        return { ok: false, image, reason: `Docker is not reachable (${error instanceof Error ? error.message : String(error)})` };
      }
    },
    async run(request) {
      const info = TOOL_PACKS[request.pack];
      if (info === undefined) throw new ToolRunError('unknown-pack', `there is no tool pack '${request.pack}'`);
      const opInfo = info.ops[request.op];
      if (opInfo === undefined) throw new ToolRunError('unknown-pack', `the ${request.pack} pack has no op '${request.op}'`);
      if (request.signal?.aborted === true) throw new ToolRunError('cancelled', 'cancelled before the tool started');
      if (request.network === true && opInfo.network !== 'opt-in') throw new ToolRunError('unknown-pack', `the ${request.pack} pack's ${request.op} op runs without a network`);
      const network = request.network === true;
      const ref = toolImage(request.pack, env);
      const pinned = request.imageId;
      if (pinned !== undefined && !/^sha256:[0-9a-f]{64}$/.test(pinned)) throw new ToolRunError('unknown-pack', `${JSON.stringify(pinned)} is not an image id`);
      let imageId: string | undefined;
      try {
        imageId = await engine.imageId(pinned ?? ref);
      } catch (error) {
        throw new ToolRunError('docker', `Docker is not reachable (${error instanceof Error ? error.message : String(error)})`);
      }
      if (imageId === undefined && enginePull !== undefined) {
        // pulled by its pinned tag; a recorded run still needs that exact image id afterwards
        try {
          await enginePull(ref, toolRegistryAuth(env, ref), request.signal);
          imageId = await engine.imageId(pinned ?? ref);
        } catch (error) {
          if (isAborted(request.signal)) throw new ToolRunError('cancelled', 'Tool download cancelled.');
          if (error instanceof Error && (error.name === 'TimeoutError' || error.cause instanceof Error && error.cause.name === 'TimeoutError')) throw new ToolRunError('timeout', 'Tool download timed out. Try again when the registry is available.');
          throw new ToolRunError('image-missing', `Could not download the ${info.tool} tool. Check the registry address and access in the installation settings. ${ref} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (imageId === undefined) {
        throw new ToolRunError('image-missing', pinned === undefined
          ? `the image ${ref} is not on the worker's Docker; build it (tools/${request.pack}/README.md)`
          : `the exact image ${pinned.slice(0, 19)}… of the recorded run is no longer on the worker's Docker (${ref} is another build now)`);
      }

      if (isAborted(request.signal)) throw new ToolRunError('cancelled', 'Cancelled before the tool started.');
      const runDir = join(workDir, `${request.jobId ?? 'run'}-${request.op}-${randomUUID().slice(0, 8)}`);
      const inDir = join(runDir, 'in');
      const outDir = join(runDir, 'out');
      mkdirSync(inDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      const started = Date.now();
      let containerId: string | undefined;
      try {
        const inputs = request.inputs.map((input) => {
          if (!safeRelative(input.path) || input.path === 'request.json') throw new ToolRunError('manifest', `input path ${JSON.stringify(input.path)} is not a plain relative path`);
          const target = join(inDir, input.path);
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, input.bytes);
          return { path: input.path, sha256: sha256(input.bytes) };
        });
        const requestText = JSON.stringify({ op: request.op, params: request.params ?? {}, inputs }, null, 2);
        writeFileSync(join(inDir, 'request.json'), requestText);
        // the pack may run as another uid when the worker cannot say who it is
        if (user === undefined) chmodSync(outDir, 0o777);

        containerId = await engine.create({
          image: imageId,
          cmd: [request.op, '/work/in/request.json'],
          mounts: [mount(inDir, '/work/in', true), mount(outDir, '/work/out', false)],
          labels: { [TOOL_OWNER_LABEL]: owner, 'org.wirehub.tool-pack': request.pack, 'org.wirehub.tool-op': request.op, ...(request.jobId === undefined ? {} : { 'org.wirehub.job': request.jobId }) },
          ...(user === undefined ? {} : { user }),
          memoryBytes,
          nanoCpus: Math.round(cpus * 1e9),
          ...(network ? { network: true } : {}),
        });
        const id = containerId;
        let stopped: 'timeout' | 'cancelled' | undefined;
        const kill = (why: 'timeout' | 'cancelled'): void => {
          if (stopped !== undefined) return;
          stopped = why;
          void engine.kill(id).catch(() => undefined);
        };
        const timeoutMs = request.timeoutMs ?? opInfo.timeoutMs;
        const timer = setTimeout(() => kill('timeout'), timeoutMs);
        const onAbort = (): void => kill('cancelled');
        request.signal?.addEventListener('abort', onAbort, { once: true });
        let exitCode: number;
        try {
          const waiting = engine.wait(id);
          await engine.start(id);
          if (isAborted(request.signal)) kill('cancelled');
          exitCode = await waiting;
        } finally {
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
        }
        const stdout = await engine.logs(id).catch(() => '');
        const packLog = (() => {
          try {
            return readFileSync(join(outDir, 'log.txt'), 'utf8');
          } catch {
            return undefined;
          }
        })();
        const log = [packLog ?? '', stdout.trim() === '' ? '' : `--- container output ---\n${stdout}`].filter((s) => s !== '').join('\n');
        if (stopped === 'timeout') throw new ToolRunError('timeout', `${request.pack} ${request.op} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped`, log);
        if (stopped === 'cancelled') throw new ToolRunError('cancelled', `${request.pack} ${request.op} was cancelled; the container was stopped`, log);
        if (exitCode !== 0) throw new ToolRunError('crashed', `${request.pack} ${request.op} crashed (exit ${exitCode})`, log);

        let manifest: ToolManifest;
        try {
          manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as ToolManifest;
        } catch (error) {
          throw new ToolRunError('manifest', `${request.pack} ${request.op} wrote no readable manifest.json (${error instanceof Error ? error.message : String(error)})`, log);
        }
        const files = verifyOutputs(manifest, outDir, request, inputs, { maxOutput, maxTotal }, log);
        const read = (path: string): Uint8Array => {
          const bytes = files.get(path);
          if (bytes === undefined) throw new ToolRunError('manifest', `${request.pack} ${request.op} declared no output ${path}`);
          return bytes;
        };
        return { manifest, files, log, image: { ref, id: imageId }, exitCode, durationMs: Date.now() - started, requestSha256: sha256(new TextEncoder().encode(requestText)), network, read };
      } finally {
        if (containerId !== undefined) await engine.remove(containerId).catch(() => undefined);
        try {
          rmSync(runDir, { recursive: true, force: true });
        } catch {
          // a pack running as another uid may leave files the worker cannot remove; the folder is in tmp
        }
      }
    },
  };
}

/** Check the manifest against the request and re-hash every output the pack names. */
function verifyOutputs(
  manifest: ToolManifest,
  outDir: string,
  request: ToolRunRequest,
  inputs: { path: string; sha256: string }[],
  limits: { maxOutput: number; maxTotal: number },
  log: string,
): Map<string, Uint8Array> {
  const bad = (message: string): never => {
    throw new ToolRunError('manifest', `${request.pack} ${request.op}: ${message}`, log);
  };
  if (typeof manifest !== 'object' || manifest === null) bad('the manifest is not an object');
  if (manifest.pack !== request.pack || manifest.op !== request.op) bad(`the manifest names ${manifest.pack} ${manifest.op}`);
  if (manifest.status !== 'ok' && manifest.status !== 'failed') bad(`status ${JSON.stringify(manifest.status)}`);
  if (typeof manifest.tool?.name !== 'string' || typeof manifest.tool?.version !== 'string' || typeof manifest.packVersion !== 'string') bad('the manifest has no tool identity');
  if (!Array.isArray(manifest.outputs) || !Array.isArray(manifest.findings)) bad('the manifest has no outputs or findings list');
  const claimed = new Map((manifest.inputs ?? []).map((i) => [i.path, i.sha256]));
  for (const input of inputs) if (claimed.get(input.path) !== input.sha256) bad(`the manifest does not confirm input ${input.path}`);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const output of manifest.outputs) {
    if (typeof output.path !== 'string' || !safeRelative(output.path) || output.path === 'manifest.json') bad(`output path ${JSON.stringify(output.path)} is not a plain relative path`);
    if (files.has(output.path)) bad(`output ${output.path} is listed twice`);
    if (typeof output.role !== 'string' || typeof output.mediaType !== 'string') bad(`output ${output.path} has no role or media type`);
    const path = join(outDir, output.path);
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) bad(`output ${output.path} is not a file`);
      size = stat.size;
    } catch (error) {
      if (error instanceof ToolRunError) throw error;
      return bad(`output ${output.path} is missing`);
    }
    if (size > limits.maxOutput) bad(`output ${output.path} is ${Math.round(size / 1048576)} MB, over the limit`);
    total += size;
    if (total > limits.maxTotal) bad('the outputs together are over the limit');
    const bytes = new Uint8Array(readFileSync(path));
    const actual = sha256(bytes);
    if (actual !== output.sha256) throw new ToolRunError('hash-mismatch', `${request.pack} ${request.op}: output ${output.path} does not match its sha256 in the manifest`, log);
    files.set(output.path, bytes);
  }
  // anything the pack wrote but did not declare is ignored, never registered
  const declared = new Set([...files.keys(), 'manifest.json', manifest.log ?? 'log.txt']);
  const extra = listFiles(outDir).filter((p) => !declared.has(p));
  if (extra.length > 0) manifest.findings.push({ level: 'info', message: `${extra.length} undeclared file(s) in the output folder were ignored` });
  return files;
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** The worker's runner, when the deployment enables one (`WIREHUB_TOOL_RUNNER=docker`). */
export function toolRunnerFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): ToolRunner | undefined {
  const kind = (env.WIREHUB_TOOL_RUNNER ?? '').trim();
  if (kind === '' || kind === 'off') return undefined;
  if (kind !== 'docker') throw new Error(`WIREHUB_TOOL_RUNNER=${kind}: the runner is 'docker' or 'off'`);
  return dockerToolRunner({ env });
}

/** read through a function: the signal can flip while the container starts */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}
