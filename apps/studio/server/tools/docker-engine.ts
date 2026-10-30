/**
 * The few Docker Engine API calls a tool-pack run needs (create, start, wait,
 * logs, kill, remove, list by label, image inspect), over `node:http`: no SDK, no docker CLI
 * in the image. `DOCKER_HOST` picks the endpoint — `unix:///var/run/docker.sock`
 * (default) or `tcp://host:port` (a socket proxy limited to these calls,
 * `docs/jobs-and-tool-packs.md`). Only the worker constructs one.
 */

import { request, type RequestOptions } from 'node:http';

export interface DockerMount {
  /** `bind`: a path the daemon sees; `volume`: a named volume, optionally a sub-path of it */
  type: 'bind' | 'volume';
  source: string;
  target: string;
  readOnly: boolean;
  subpath?: string;
}

export interface CreateSpec {
  image: string;
  cmd: string[];
  mounts: DockerMount[];
  labels: Record<string, string>;
  /** `uid:gid` the pack runs as (the owner of the work folders) */
  user?: string;
  memoryBytes?: number;
  nanoCpus?: number;
  pidsLimit?: number;
  tmpfsSize?: string;
  /** the default bridge network instead of none: only for an op its pack declares `network: 'opt-in'` (`packs.ts`) */
  network?: boolean;
}

export interface DockerEngine {
  readonly describe: string;
  /** the image's id, or undefined when it is not present */
  imageId(ref: string): Promise<string | undefined>;
  create(spec: CreateSpec): Promise<string>;
  start(id: string): Promise<void>;
  /** resolves with the exit code once the container stops */
  wait(id: string): Promise<number>;
  logs(id: string): Promise<string>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /**
   * Pulls `ref` (`repo:tag` or `repo@sha256:…`) onto the daemon; `auth` is the registry login.
   * Optional so a test engine may leave it out. Rejects with the daemon's message on failure.
   */
  pull?(ref: string, auth?: RegistryAuth, signal?: AbortSignal): Promise<void>;
  /** every container (running or not) carrying all of these labels; optional so a test engine may leave it out */
  list?(labels: Record<string, string>): Promise<DockerContainerSummary[]>;
}

export interface RegistryAuth {
  username: string;
  password: string;
  serveraddress: string;
}

/** `repo:tag` → fromImage + tag for POST /images/create; a digest reference stays whole. */
export function splitImageRef(ref: string): { fromImage: string; tag?: string } {
  if (ref.includes('@')) return { fromImage: ref };
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  return colon > slash ? { fromImage: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { fromImage: ref, tag: 'latest' };
}

export interface DockerContainerSummary {
  id: string;
  /** `created`, `running`, `exited`, `dead`, … */
  state: string;
  labels: Record<string, string>;
}

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DockerError';
    this.status = status;
  }
}

function endpoint(host: string): Pick<RequestOptions, 'socketPath' | 'host' | 'port'> {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  const match = /^tcp:\/\/([^:/]+):(\d+)\/?$/.exec(host);
  if (match === null) throw new Error(`DOCKER_HOST ${JSON.stringify(host)} is not unix:///path or tcp://host:port`);
  return { host: match[1]!, port: Number(match[2]) };
}

/** Docker's multiplexed log stream (no TTY): 8-byte frame headers. */
export function demuxLogs(buffer: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const kind = buffer[offset];
    const size = buffer.readUInt32BE(offset + 4);
    if (kind === undefined || kind > 2 || offset + 8 + size > buffer.length) return buffer.toString('utf8');
    parts.push(buffer.subarray(offset + 8, offset + 8 + size));
    offset += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

export function dockerEngine(host = process.env.DOCKER_HOST?.trim() || 'unix:///var/run/docker.sock'): DockerEngine {
  const target = endpoint(host);
  const call = (method: string, path: string, body?: unknown, timeoutMs = 30_000, extraHeaders: Record<string, string> = {}, signal?: AbortSignal): Promise<{ status: number; bytes: Buffer }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = request(
        { ...target, method, path, ...(signal === undefined ? {} : { signal }), headers: { ...extraHeaders, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.length }) } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, bytes: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error(`docker ${method} ${path.split('?')[0]} timed out`)));
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  const expect = async (method: string, path: string, ok: number[], body?: unknown, timeoutMs?: number): Promise<Buffer> => {
    const res = await call(method, path, body, timeoutMs);
    if (!ok.includes(res.status)) {
      let message = res.bytes.toString('utf8');
      try {
        message = (JSON.parse(message) as { message?: string }).message ?? message;
      } catch {
        // plain text
      }
      throw new DockerError(res.status, `docker ${method} ${path.split('?')[0]}: ${res.status} ${message.trim()}`);
    }
    return res.bytes;
  };
  return {
    describe: host,
    async imageId(ref) {
      const res = await call('GET', `/images/${encodeURIComponent(ref)}/json`);
      if (res.status === 404) return undefined;
      if (res.status !== 200) throw new DockerError(res.status, `docker image inspect ${ref}: ${res.status}`);
      return (JSON.parse(res.bytes.toString('utf8')) as { Id: string }).Id;
    },
    async create(spec) {
      const body = {
        Image: spec.image,
        Cmd: spec.cmd,
        Labels: spec.labels,
        ...(spec.user === undefined ? {} : { User: spec.user }),
        Env: ['HOME=/tmp'],
        ...(spec.network === true ? {} : { NetworkDisabled: true }),
        HostConfig: {
          NetworkMode: spec.network === true ? 'bridge' : 'none',
          ReadonlyRootfs: true,
          Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${spec.tmpfsSize ?? '1g'}` },
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          ...(spec.memoryBytes === undefined ? {} : { Memory: spec.memoryBytes, MemorySwap: spec.memoryBytes }),
          ...(spec.nanoCpus === undefined ? {} : { NanoCpus: spec.nanoCpus }),
          PidsLimit: spec.pidsLimit ?? 512,
          Mounts: spec.mounts.map((m) => ({
            Type: m.type,
            Source: m.source,
            Target: m.target,
            ReadOnly: m.readOnly,
            ...(m.type === 'volume' && m.subpath !== undefined ? { VolumeOptions: { Subpath: m.subpath } } : {}),
          })),
        },
      };
      const out = await expect('POST', '/containers/create', [201], body);
      return (JSON.parse(out.toString('utf8')) as { Id: string }).Id;
    },
    async start(id) {
      await expect('POST', `/containers/${id}/start`, [204, 304]);
    },
    async wait(id) {
      const out = await expect('POST', `/containers/${id}/wait?condition=next-exit`, [200], undefined, 0);
      return (JSON.parse(out.toString('utf8')) as { StatusCode: number }).StatusCode;
    },
    async logs(id) {
      return demuxLogs(await expect('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=2000`, [200]));
    },
    async kill(id) {
      // 409: it already stopped
      await expect('POST', `/containers/${id}/kill`, [204, 404, 409]);
    },
    async remove(id) {
      await expect('DELETE', `/containers/${id}?force=1&v=0`, [204, 404, 409]);
    },
    async pull(ref, auth, signal) {
      const { fromImage, tag } = splitImageRef(ref);
      const query = `fromImage=${encodeURIComponent(fromImage)}${tag === undefined ? '' : `&tag=${encodeURIComponent(tag)}`}`;
      const headers: Record<string, string> = auth === undefined ? {} : { 'X-Registry-Auth': Buffer.from(JSON.stringify(auth)).toString('base64url') };
      // A first download may be large, but cancellation and a hard deadline must still stop waiting.
      const deadline = AbortSignal.timeout(20 * 60_000);
      const res = await call('POST', `/images/create?${query}`, undefined, 60_000, headers, signal === undefined ? deadline : AbortSignal.any([signal, deadline]));
      // the daemon answers 200 and streams progress; a failed pull ends with an {"error": …} line
      const lines = res.bytes.toString('utf8').split('\n').filter((line) => line.trim() !== '');
      let failure: string | undefined = res.status === 200 ? undefined : `${res.status}`;
      for (const line of lines) {
        try {
          const row = JSON.parse(line) as { error?: string; message?: string };
          if (row.error !== undefined) failure = row.error;
          else if (res.status !== 200 && row.message !== undefined) failure = `${res.status} ${row.message}`;
        } catch {
          if (res.status !== 200) failure = `${res.status} ${line.trim()}`;
        }
      }
      if (failure !== undefined) throw new DockerError(res.status === 200 ? 500 : res.status, `docker pull ${ref}: ${failure}`);
    },
    async list(labels) {
      const filters = encodeURIComponent(JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) }));
      const out = await expect('GET', `/containers/json?all=1&filters=${filters}`, [200]);
      const rows = JSON.parse(out.toString('utf8')) as { Id: string; State?: string; Labels?: Record<string, string> | null }[];
      // the daemon filters already; checked again so a proxy or daemon that ignores the filter cannot widen the set
      return rows
        .map((row) => ({ id: row.Id, state: row.State ?? '', labels: row.Labels ?? {} }))
        .filter((row) => Object.entries(labels).every(([k, v]) => row.labels[k] === v));
    },
  };
}
