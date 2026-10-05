/**
 * `render`'s logic, apart from the process: arguments in, files out.
 *
 * A source answers `GET /api/…` — the studio itself over HTTP (a token), or the
 * same router run in this process over the local catalog (`workbenchDepsFromEnv`:
 * the file catalog by default, the database when `WIREHUB_BACKEND=pg`). Either
 * way the bytes are the ones the browser's Documents toolbar would save.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_FORMAT, DOCUMENT_FORMATS, DOCUMENT_KINDS, isDocumentKind } from '../server/render/index.ts';

export class RenderCliError extends Error {}

export const RENDER_USAGE = [
  'usage: pnpm --filter studio render <design> <what> [--format svg|pdf|csv|html] [--rev <n>|latest] [--out <dir>|-]',
  '                                    [--paper A4|letter] [--variation <suffix>] [--page <n>] [--copies <n>]',
  '  <what>  schematic | build-sheet | bom | test-spec | drawing | labels   (a document, in --format; default per document)',
  '          bom.csv | wire-list.csv | cut-list.csv | crimp-list.csv | production.xlsx | continuity.csv | continuity.json | labels.csv | labels.svg   (an export)',
  '          all   every document in its default format, plus pdf of each',
  '  Local by default (the catalog this checkout or WIREHUB_BACKEND points at); with WIREHUB_API_URL and WIREHUB_API_TOKEN set, the studio over HTTP.',
].join('\n');

export interface RenderArgs {
  design: string;
  what: string;
  format?: string;
  rev?: string;
  out: string;
  query: Record<string, string>;
}

export function parseRenderArgs(argv: readonly string[]): RenderArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const value = eq < 0 ? argv[(i += 1)] : arg.slice(eq + 1);
      if (!['format', 'rev', 'out', 'paper', 'variation', 'page', 'copies'].includes(name)) throw new RenderCliError(`--${name} is not an option.\n${RENDER_USAGE}`);
      if (value === undefined) throw new RenderCliError(`--${name} needs a value.`);
      flags.set(name, value);
    } else positionals.push(arg);
  }
  const [design, what, ...extra] = positionals;
  if (design === undefined || what === undefined || extra.length > 0) throw new RenderCliError(RENDER_USAGE);
  const format = flags.get('format');
  if (format !== undefined && !(DOCUMENT_FORMATS as readonly string[]).includes(format)) throw new RenderCliError(`--format must be one of ${DOCUMENT_FORMATS.join(', ')}.`);
  const query: Record<string, string> = {};
  for (const name of ['paper', 'variation', 'page', 'copies'] as const) {
    const value = flags.get(name);
    if (value !== undefined) query[name] = value;
  }
  return { design, what, ...(format === undefined ? {} : { format }), ...(flags.has('rev') ? { rev: flags.get('rev') as string } : {}), out: flags.get('out') ?? '.', query };
}

export interface Fetched {
  status: number;
  bytes: Uint8Array;
  /** the file name the answer proposes */
  fileName?: string;
  /** the error sentence, for a refusal */
  error?: string;
}

export interface RenderSource {
  get(path: string): Promise<Fetched>;
}

function qs(entries: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) if (v !== undefined) params.set(k, v);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** The request paths for one `<what>` (`all` is several). */
export function requestPaths(args: RenderArgs): string[] {
  const id = encodeURIComponent(args.design);
  const common = { ...(args.rev === undefined ? {} : { rev: args.rev }), ...args.query };
  if (args.what === 'all') {
    return DOCUMENT_KINDS.flatMap((kind) => {
      const formats = [...new Set([DEFAULT_FORMAT[kind], 'pdf'])];
      return formats.map((format) => `/api/designs/${id}/documents/${kind}${qs({ ...common, format })}`);
    });
  }
  if (isDocumentKind(args.what)) {
    return [`/api/designs/${id}/documents/${args.what}${qs({ ...common, ...(args.format === undefined ? {} : { format: args.format }) })}`];
  }
  if (args.format !== undefined) throw new RenderCliError(`--format does not apply to the export ${args.what}; the export's own name says the format.`);
  return [`/api/designs/${id}/exports/${encodeURIComponent(args.what)}${qs(common)}`];
}

/** Fetch every path and write the files; returns what was written (or `-` for stdout via `stdout`). */
export async function renderToFiles(
  source: RenderSource,
  args: RenderArgs,
  io: { stdout: (bytes: Uint8Array) => void; log: (line: string) => void },
): Promise<string[]> {
  const written: string[] = [];
  const paths = requestPaths(args);
  for (const path of paths) {
    const answer = await source.get(path);
    if (answer.status !== 200) throw new RenderCliError(`${answer.error ?? `The studio answered ${answer.status}.`} (${path})`);
    if (args.out === '-') {
      if (paths.length > 1) throw new RenderCliError('--out - writes one file to stdout; name a directory for all.');
      io.stdout(answer.bytes);
      continue;
    }
    mkdirSync(args.out, { recursive: true });
    const file = join(args.out, (answer.fileName ?? 'document').replace(/[^A-Za-z0-9._-]/g, '_'));
    writeFileSync(file, answer.bytes);
    written.push(file);
    io.log(`${file} (${answer.bytes.length} bytes)`);
  }
  return written;
}

/* ------------------------------------------------------------------ *
 * Sources
 * ------------------------------------------------------------------ */

function fileNameOf(disposition: string | null | undefined): string | undefined {
  return disposition === null || disposition === undefined ? undefined : /filename="([^"]+)"/.exec(disposition)?.[1];
}

/** The studio over HTTP, with a personal API token (`WIREHUB_API_URL`, `WIREHUB_API_TOKEN`). */
export function httpSource(url: string, token: string, fetchImpl: typeof fetch = fetch): RenderSource {
  return {
    async get(path) {
      const res = await fetchImpl(`${url.replace(/\/+$/, '')}${path}`, { headers: { authorization: `Bearer ${token}` } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status === 200) return { status: 200, bytes, ...(fileNameOf(res.headers.get('content-disposition')) === undefined ? {} : { fileName: fileNameOf(res.headers.get('content-disposition')) as string }) };
      let error: string | undefined;
      try {
        const body = JSON.parse(new TextDecoder().decode(bytes)) as { error?: string; hint?: string };
        error = [body.error, body.hint].filter(Boolean).join(' ');
      } catch {
        // not JSON
      }
      return { status: res.status, bytes, ...(error === undefined ? {} : { error }) };
    },
  };
}

/** The router in this process, over whatever catalog the environment names. */
export function localSource(route: (request: { method: string; path: string }) => Promise<{ status: number; body: unknown; bytes?: Uint8Array; headers?: Record<string, string> }>): RenderSource {
  return {
    async get(path) {
      const out = await route({ method: 'GET', path });
      const fileName = fileNameOf(out.headers?.['Content-Disposition']);
      if (out.status === 200 && out.bytes !== undefined) return { status: 200, bytes: out.bytes, ...(fileName === undefined ? {} : { fileName }) };
      const body = out.body as { error?: string; hint?: string } | null;
      const error = [body?.error, body?.hint].filter(Boolean).join(' ');
      return { status: out.status, bytes: new Uint8Array(), ...(error === '' ? {} : { error }) };
    },
  };
}
