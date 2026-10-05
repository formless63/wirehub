#!/usr/bin/env -S node --experimental-strip-types
/**
 * `wirehub-module build`: a module package as a runtime code-module bundle
 * (`specs/runtime-modules.md` §1, §6) — a pack directory with the module's
 * entries under `code/<id>/`, its data beside them, and the manifest's `module`
 * block; signed when a publisher key is given.
 *
 *   pnpm --filter studio wirehub-module build ../../modules/example --out /tmp/out --key ~/keys/wirehub-publisher.key
 *
 * Options:
 *   --export <name>        the module's export (default: the one export that is a module)
 *   --pack <dir>           the data to ship with it (default: the package's pack/ when it has one)
 *   --out <dir>            where `<id>-<version>/` is written (default: ./dist-module)
 *   --key <file>           a publisher private key (PEM): pins the files and writes wirehub-pack.sig
 *                          (or WIREHUB_PACK_SIGNING_KEY); repeat for a rotation
 *   --publisher-id <id>    the manifest's publisher (when --pack has none); required to sign
 *   --publisher-name <n>
 *   --no-browser           leave the browser entry out (a server-only module)
 *   --zip                  also write <out>/<id>-<version>.zip (`store-index.mjs bundle`)
 *
 * The entries are built with Vite's library mode — the app's own toolchain, no
 * new dependency — as single ESM files: `@wirehub/*` and the module's own
 * dependencies bundled in, React reached through the host's shared copy
 * (`globalThis.__wirehub.shared`), never a second one.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { packDigests, signPackManifest, PACK_SIGNATURE, type PackManifest } from '@wirehub/catalog';
import * as React from 'react';
import * as JsxRuntime from 'react/jsx-runtime';

import { isPackFilePath } from '../server/pack-archive.ts';
import { MODULE_API_VERSION, codeFilePath, extensionPointsOf, permissionsOf, RUNTIME_IGNORED_POINTS, RUNTIME_REFUSED_POINTS, type CodeModuleManifest, type WireHubModule } from '@wirehub/modules';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const nodeShim = resolve(here, '../src/node-shim.ts');

/** The packages the host shares with modules, by import name. */
export const SHARED = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] as const;

export class ModuleBuildError extends Error {}

export interface BuildOptions {
  moduleDir: string;
  out: string;
  exportName?: string;
  packDir?: string;
  keys?: string[];
  publisher?: { id: string; name: string };
  browser?: boolean;
  zip?: boolean;
  log?: (line: string) => void;
}

export interface BuildResult {
  dir: string;
  manifest: PackManifest;
  module: CodeModuleManifest;
  zip?: string;
}

const isModule = (v: unknown): v is WireHubModule => typeof v === 'object' && v !== null && typeof (v as WireHubModule).id === 'string' && typeof (v as WireHubModule).version === 'string' && typeof (v as WireHubModule).label === 'string';

/** The names a shared package exports, for the shim's `export const { … }`. */
async function exportNames(name: string): Promise<string[]> {
  const namespace = (await import(name)) as Record<string, unknown>;
  return Object.keys(namespace).filter((k) => k !== 'default' && /^[A-Za-z_$][\w$]*$/.test(k)).sort();
}

/** A Vite plugin: the shared packages resolve to the host's copies. */
async function sharedPlugin(): Promise<{ name: string; enforce: 'pre'; resolveId(id: string): string | undefined; load(id: string): string | undefined }> {
  const names = new Map<string, string[]>();
  for (const name of SHARED) {
    try {
      names.set(name, await exportNames(name));
    } catch {
      names.set(name, []);
    }
  }
  const PREFIX = '\0wirehub-shared:';
  return {
    name: 'wirehub-shared',
    enforce: 'pre',
    resolveId: (id) => ((SHARED as readonly string[]).includes(id) ? `${PREFIX}${id}` : undefined),
    load(id) {
      if (!id.startsWith(PREFIX)) return undefined;
      const name = id.slice(PREFIX.length);
      const list = names.get(name) ?? [];
      return [
        `const shared = globalThis.__wirehub && globalThis.__wirehub.shared && globalThis.__wirehub.shared[${JSON.stringify(name)}];`,
        `if (shared === undefined) throw new Error(${JSON.stringify(`WireHub does not share '${name}' with modules here`)});`,
        'export default shared;',
        ...(list.length === 0 ? [] : [`export const { ${list.join(', ')} } = shared;`]),
      ].join('\n');
    },
  };
}

/**
 * `@wirehub/*` resolve to this checkout's packages, wherever the module lives:
 * a module in a store repository has no `node_modules` of its own for them, and
 * one in this repository gets exactly the files its workspace links to.
 */
const WIREHUB_ALIASES = [
  { find: /^@wirehub\/([a-z-]+)$/, replacement: `${join(repo, 'packages')}/$1/src/index.ts` },
  { find: /^@wirehub\/([a-z-]+)\/(.+)$/, replacement: `${join(repo, 'packages')}/$1/$2` },
];

/** Bundle `entry` for one side; `exportName` undefined re-exports all of it (the probe build), else that export becomes the default. */
async function bundle(entry: string, exportName: string | undefined, side: 'server' | 'browser', root: string): Promise<{ js: string; css?: string }> {
  const { build } = await import('vite');
  // the bundle's default export is the module: a one-line entry beside nothing, outside the package
  const work = mkdtempSync(join(tmpdir(), 'wirehub-module-'));
  const entryFile = join(work, 'entry.mjs');
  writeFileSync(entryFile, exportName === undefined ? `export * from ${JSON.stringify(entry)};\n` : `export { ${exportName} as default } from ${JSON.stringify(entry)};\n`);
  try {
    return await bundleEntry(build, entryFile, side, root);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function bundleEntry(build: typeof import('vite').build, entryFile: string, side: 'server' | 'browser', root: string): Promise<{ js: string; css?: string }> {
  const result = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    mode: 'production',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [await sharedPlugin()],
    resolve: { alias: [...WIREHUB_ALIASES, ...(side === 'browser' ? [{ find: /^node:(fs|url|path)$/, replacement: nodeShim }] : [])] },
    ...(side === 'server' ? { ssr: { noExternal: true, target: 'node' as const } } : {}),
    build: {
      write: false,
      minify: false,
      sourcemap: false,
      emptyOutDir: false,
      copyPublicDir: false,
      target: 'es2022',
      ...(side === 'server' ? { ssr: entryFile } : { lib: { entry: entryFile, formats: ['es' as const], fileName: () => 'browser.mjs' } }),
      rollupOptions: { output: { format: 'es', codeSplitting: false, entryFileNames: side === 'server' ? 'server.mjs' : 'browser.mjs' } },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as { output: { type: string; fileName: string; code?: string; source?: string | Uint8Array }[] }[];
  const files = outputs.flatMap((o) => o.output);
  const chunks = files.filter((f) => f.type === 'chunk');
  if (chunks.length !== 1) throw new ModuleBuildError(`the ${side} build made ${chunks.length} files; a module entry must be one file (no dynamic imports of separate chunks)`);
  const css = files.filter((f) => f.type === 'asset' && f.fileName.endsWith('.css')).map((f) => (typeof f.source === 'string' ? f.source : new TextDecoder().decode(f.source))).join('\n');
  return { js: chunks[0]!.code ?? '', ...(css.trim() === '' ? {} : { css }) };
}

function packFilesOf(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...packFilesOf(dir, path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

/** The host's React for the probe import (what the shim reads at load). */
function installSharedForBuild(): void {
  const g = globalThis as { __wirehub?: { shared?: Record<string, unknown> } };
  g.__wirehub ??= {};
  g.__wirehub.shared = { ...(g.__wirehub.shared ?? {}), react: React, 'react/jsx-runtime': JsxRuntime };
}

/** Does the browser need this module's code? (UI, and the pure parts the browser runs: exporters, rules, the scheme, the hook.) */
function wantsBrowser(m: WireHubModule): boolean {
  const points = extensionPointsOf(m);
  return ['panels', 'routes', 'compareViews', 'commitHook', 'exporters', 'partNumberScheme', 'validationRules', 'importers', 'art'].some((p) => points.includes(p as never));
}

export async function buildModule(options: BuildOptions): Promise<BuildResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const moduleDir = resolve(options.moduleDir);
  const pkgPath = join(moduleDir, 'package.json');
  if (!existsSync(pkgPath)) throw new ModuleBuildError(`${moduleDir} has no package.json`);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; main?: string; license?: string };
  const entry = resolve(moduleDir, pkg.main ?? 'src/index.ts');
  if (!existsSync(entry)) throw new ModuleBuildError(`the module's entry ${relative(process.cwd(), entry)} does not exist`);

  // the module object itself (its id, version and what it contributes), from a probe build of the whole entry:
  // the same code the hub will load, so its dependencies need resolving only once, the bundler's way
  const probe = await bundle(entry, undefined, 'server', moduleDir);
  installSharedForBuild();
  const probeDir = mkdtempSync(join(tmpdir(), 'wirehub-module-probe-'));
  let namespace: Record<string, unknown>;
  try {
    writeFileSync(join(probeDir, 'probe.mjs'), probe.js);
    namespace = (await import(pathToFileURL(join(probeDir, 'probe.mjs')).href)) as Record<string, unknown>;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
  const candidates = Object.entries(namespace).filter(([key, v]) => (options.exportName === undefined ? key !== 'default' : key === options.exportName) && isModule(v));
  if (candidates.length !== 1) {
    throw new ModuleBuildError(options.exportName === undefined ? `the entry exports ${candidates.length} modules (${candidates.map(([k]) => k).join(', ') || 'none'}); name one with --export` : `the entry exports no module '${options.exportName}'`);
  }
  const [exportName, module] = candidates[0] as [string, WireHubModule];
  const refused = extensionPointsOf(module).filter((p) => (RUNTIME_REFUSED_POINTS as readonly string[]).includes(p));
  if (refused.length > 0) throw new ModuleBuildError(`a module installed at runtime cannot use ${refused.join(', ')}`);
  const ignored = extensionPointsOf(module).filter((p) => (RUNTIME_IGNORED_POINTS as readonly string[]).includes(p));
  if (ignored.length > 0) log(`note: ${ignored.join(' and ')} are not used at runtime: the bundle's own data (--pack) is installed with it`);

  const browser = options.browser ?? wantsBrowser(module);
  log(`building ${module.id} ${module.version}: server${browser ? ' and browser' : ''} entries`);
  const server = await bundle(entry, exportName, 'server', moduleDir);
  const client = browser ? await bundle(entry, exportName, 'browser', moduleDir) : undefined;

  const points = extensionPointsOf(module).filter((p) => !(RUNTIME_IGNORED_POINTS as readonly string[]).includes(p));
  const block: CodeModuleManifest = {
    id: module.id,
    version: module.version,
    label: module.label,
    apiVersion: MODULE_API_VERSION,
    server: codeFilePath(module.id, 'server.mjs'),
    ...(client === undefined ? {} : { browser: codeFilePath(module.id, 'browser.mjs') }),
    ...(client?.css === undefined ? {} : { css: codeFilePath(module.id, 'browser.css') }),
    extensionPoints: points,
    permissions: permissionsOf(module, { browser: client !== undefined }),
  };

  // the pack: the module's data (its pack/ directory, or --pack), then the code
  const packDir = options.packDir === undefined ? (existsSync(join(moduleDir, 'pack', 'wirehub-pack.json')) ? join(moduleDir, 'pack') : undefined) : resolve(options.packDir);
  const base: Partial<PackManifest> = packDir === undefined ? {} : (JSON.parse(readFileSync(join(packDir, 'wirehub-pack.json'), 'utf8')) as PackManifest);
  const { files: _pins, module: _old, ...kept } = base;
  const manifest: PackManifest = {
    format: 1,
    id: base.id ?? module.id,
    name: base.name ?? module.label,
    version: base.version ?? module.version,
    license: base.license ?? module.license ?? pkg.license ?? 'NOASSERTION',
    ...kept,
    ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
    module: block,
  } as PackManifest;
  if (manifest.version !== module.version) log(`note: the pack is version ${manifest.version}, the module ${module.version}`);

  const dir = join(resolve(options.out), `${manifest.id}-${manifest.version}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (packDir !== undefined) {
    for (const path of packFilesOf(packDir)) {
      if (path === 'wirehub-pack.json' || path === PACK_SIGNATURE || path.startsWith('code/')) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      cpSync(join(packDir, path), join(dir, path));
    }
  }
  mkdirSync(join(dir, 'code', module.id), { recursive: true });
  writeFileSync(join(dir, block.server), server.js);
  if (client !== undefined) writeFileSync(join(dir, block.browser!), client.js);
  if (client?.css !== undefined) writeFileSync(join(dir, block.css!), client.css);

  const keys = options.keys ?? [];
  let final = manifest;
  if (keys.length > 0) {
    if (manifest.publisher?.id === undefined) throw new ModuleBuildError('signing needs the publisher in the manifest: give --publisher-id and --publisher-name, or a --pack whose manifest names it');
    // what a hub keeps of the pack (`pack-archive.ts`): data, images and code; a LICENSE or README rides along unpinned
    const files = new Map(packFilesOf(dir).filter((p) => p !== 'wirehub-pack.json' && p !== PACK_SIGNATURE && isPackFilePath(p)).map((p) => [p, new Uint8Array(readFileSync(join(dir, p)))] as const));
    final = { ...manifest, files: packDigests(files) };
    writeFileSync(join(dir, 'wirehub-pack.json'), `${JSON.stringify(final, null, 2)}\n`);
    writeFileSync(join(dir, PACK_SIGNATURE), signPackManifest(final, keys));
    log(`signed by ${keys.length} key(s)`);
  } else {
    writeFileSync(join(dir, 'wirehub-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log('not signed (no --key): a hub installs a code module only when its publisher signed it');
  }
  let zip: string | undefined;
  if (options.zip === true) {
    execFileSync(process.execPath, [join(repo, 'scripts/store-index.mjs'), 'bundle', dir, '--out', resolve(options.out)], { stdio: 'inherit' });
    zip = join(resolve(options.out), `${manifest.id}-${manifest.version}.zip`);
  }
  log(`wrote ${dir}${zip === undefined ? '' : ` and ${zip}`}`);
  return { dir, manifest: final, module: block, ...(zip === undefined ? {} : { zip }) };
}

function parseArgs(argv: string[]): { command?: string; positional: string[]; flags: Map<string, string[]>; bools: Set<string> } {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--no-browser' || arg === '--zip') bools.add(arg.slice(2));
    else if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined) throw new ModuleBuildError(`${arg} needs a value`);
      flags.set(arg.slice(2), [...(flags.get(arg.slice(2)) ?? []), value]);
      i += 1;
    } else positional.push(arg);
  }
  const [command, ...rest] = positional;
  return { ...(command === undefined ? {} : { command }), positional: rest, flags, bools };
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command !== 'build' || args.positional.length !== 1) {
    console.error('usage: wirehub-module build <module-package-dir> [--out dir] [--key publisher.key] [--publisher-id id --publisher-name name] [--pack dir] [--export name] [--no-browser] [--zip]');
    return 2;
  }
  const cwd = process.env['INIT_CWD'] ?? process.cwd();
  const one = (name: string): string | undefined => args.flags.get(name)?.[0];
  const keyFiles = args.flags.get('key') ?? [];
  const keys = keyFiles.length > 0 ? keyFiles.map((f) => readFileSync(resolve(cwd, f), 'utf8')) : (process.env['WIREHUB_PACK_SIGNING_KEY'] ?? '').trim() === '' ? [] : [process.env['WIREHUB_PACK_SIGNING_KEY'] as string];
  const publisherId = one('publisher-id');
  await buildModule({
    moduleDir: resolve(cwd, args.positional[0] as string),
    out: resolve(cwd, one('out') ?? 'dist-module'),
    ...(one('export') === undefined ? {} : { exportName: one('export') as string }),
    ...(one('pack') === undefined ? {} : { packDir: resolve(cwd, one('pack') as string) }),
    keys,
    ...(publisherId === undefined ? {} : { publisher: { id: publisherId, name: one('publisher-name') ?? publisherId } }),
    ...(args.bools.has('no-browser') ? { browser: false } : {}),
    zip: args.bools.has('zip'),
  });
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof ModuleBuildError ? `wirehub-module: ${error.message}` : error);
      process.exit(1);
    },
  );
}
