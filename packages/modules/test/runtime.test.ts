import { describe, expect, it } from 'vitest';
import { prefixPartNumberScheme, type CableDesign, type Db } from '@wirehub/model';

import {
  MODULE_API_VERSION,
  apiCompatibility,
  applyModeOf,
  codeModuleManifestProblems,
  composeRegistry,
  createLiveRegistry,
  createRegistry,
  defineModule,
  extensionPointsOf,
  forRuntime,
  isCodeFilePath,
  isLiveRegistry,
  permissionsOf,
  pickModuleExport,
  runtimeModuleProblems,
  type CodeModuleManifest,
} from '../src/index.ts';

const db: Db = { connectors: [], wires: [], components: [], pcbas: [] };
const design: CableDesign = { schemaVersion: 4, id: 'd', label: 'TODO', instances: { connectors: [], segments: [], components: [], pcbas: [] }, joints: [], src: 'synthetic example' };

const rule = defineModule({
  id: 'acme',
  label: 'ACME',
  version: '1.0.0',
  validationRules: [{ id: 'todo', label: 'No TODO', check: (d: CableDesign) => (d.label.includes('TODO') ? [{ code: 'todo', severity: 'error' as const, message: 'TODO' }] : []) }],
  integrations: [
    {
      id: 'erp',
      label: 'ERP',
      env: ['ACME_URL'],
      routes: [{ method: 'POST', path: 'push', writes: true, handle: async () => ({ status: 200, body: {} }) }],
      queues: [{ id: 'sync', label: 'Sync', run: async () => ({}) }],
    },
  ],
  authProviders: [{ id: 'acme-sso', label: 'ACME', kind: 'oidc', config: { issuer: 'https://idp.example.invalid', clientId: 'x', clientSecretEnv: 'ACME_SECRET' } }],
});

const manifest = (over: Partial<CodeModuleManifest> = {}): CodeModuleManifest => ({
  id: 'acme',
  version: '1.0.0',
  label: 'ACME',
  apiVersion: MODULE_API_VERSION,
  server: 'code/acme/server.mjs',
  extensionPoints: ['validationRules', 'integrations', 'queues', 'authProviders'],
  permissions: ['server-code', 'routes', 'writes', 'jobs', 'sign-in', 'env:ACME_URL', 'env:ACME_SECRET'],
  ...over,
});

describe('the module API version', () => {
  it('is compatible on the same major with a minor no newer than the host', () => {
    expect(apiCompatibility('1.0', '1.1')).toEqual({ ok: true });
    expect(apiCompatibility('1.1', '1.1')).toEqual({ ok: true });
    expect(apiCompatibility('1.2', '1.1').ok).toBe(false);
    expect(apiCompatibility('2.0', '1.1').ok).toBe(false);
    expect(apiCompatibility('0.9', '1.1').ok).toBe(false);
    expect(apiCompatibility('one', '1.1').ok).toBe(false);
    expect(apiCompatibility(undefined).ok).toBe(false);
  });
});

describe('extension points, permissions, apply mode', () => {
  it('lists what a module contributes, queues apart from integrations', () => {
    expect(extensionPointsOf(rule)).toEqual(['validationRules', 'integrations', 'queues', 'authProviders']);
  });
  it('derives the permissions, env names included', () => {
    expect(permissionsOf(rule, { browser: true })).toEqual(['server-code', 'browser-code', 'routes', 'writes', 'jobs', 'sign-in', 'env:ACME_SECRET', 'env:ACME_URL']);
  });
  it('applies supported runtime points including job queues live', () => {
    expect(applyModeOf(['validationRules', 'panels', 'authProviders', 'art', 'bench'])).toBe('live');
    expect(applyModeOf(['exporters', 'queues'])).toBe('live');
  });
});

describe('the bundle manifest', () => {
  it('accepts a sound block and names every problem of a bad one', () => {
    expect(codeModuleManifestProblems(manifest())).toEqual([]);
    expect(codeModuleManifestProblems(manifest({ browser: 'code/acme/browser.mjs', permissions: ['server-code'] }))).toEqual(["a module with a browser entry declares 'browser-code'"]);
    expect(codeModuleManifestProblems(manifest({ server: 'server.mjs' }))).toEqual(["the module's server entry must be code/acme/server.mjs"]);
    expect(codeModuleManifestProblems(manifest({ extensionPoints: ['migrations'] }))).toContain("SQL migrations declare the permission 'database-schema'");
    expect(codeModuleManifestProblems(manifest({ permissions: ['server-code', 'root'] }))).toEqual(["'root' is not a permission"]);
    expect(codeModuleManifestProblems('x')).toEqual(['the manifest\'s "module" is not an object']);
  });
  it('allows only explicit entries and SQL paths', () => {
    expect(isCodeFilePath('code/acme/server.mjs')).toBe(true);
    expect(isCodeFilePath('code/acme/browser.css')).toBe(true);
    expect(isCodeFilePath('code/acme/other.mjs')).toBe(false);
    expect(isCodeFilePath('code/acme/migrations/0001_acme_table.sql')).toBe(true);
    expect(isCodeFilePath('code/acme/migrations/extra.sql')).toBe(false);
    expect(codeModuleManifestProblems(manifest({ apiVersion: '1.2', extensionPoints: ['migrations'], permissions: ['server-code', 'database-schema'], migrations: [{ path: 'code/acme/migrations/0001_acme_table.sql', sha256: 'a'.repeat(64) }] }))).toContain('SQL migrations require module API 1.3 or newer');
    expect(isCodeFilePath('code/../server.mjs')).toBe(false);
    expect(isCodeFilePath('code/Acme/server.mjs')).toBe(false);
  });
  it('checks the loaded module against its manifest', () => {
    expect(runtimeModuleProblems(rule, manifest())).toEqual([]);
    expect(runtimeModuleProblems(rule, manifest({ version: '1.0.1' }))).toEqual(['the code is version 1.0.0, but the manifest says 1.0.1']);
    expect(runtimeModuleProblems(rule, manifest({ extensionPoints: ['validationRules', 'integrations', 'authProviders'] }))).toEqual(["it uses 'queues', which its manifest does not declare"]);
    expect(runtimeModuleProblems(rule, manifest({ permissions: ['server-code', 'routes', 'writes', 'jobs', 'sign-in', 'env:ACME_URL'] }))).toEqual(["it needs the permission 'env:ACME_SECRET', which its manifest does not declare"]);
    const migrating = defineModule({ ...rule, migrations: { dir: '/x' } });
    expect(runtimeModuleProblems(migrating, manifest())).toEqual(["it uses 'migrations', which its manifest does not declare", "it needs the permission 'database-schema', which its manifest does not declare"]);
  });
  it('ignores setup and catalog packs at runtime', () => {
    const domain = defineModule({ ...rule, setup: { kind: 'domain', description: 'd' }, catalogPacks: [{ id: 'p', label: 'p', version: '1.0.0' }] });
    expect(runtimeModuleProblems(domain, manifest())).toEqual([]);
    expect(forRuntime(domain).setup).toBeUndefined();
    expect(forRuntime(domain).catalogPacks).toBeUndefined();
  });
  it('picks the module export', () => {
    expect(pickModuleExport({ default: rule }, 'acme')).toBe(rule);
    expect(pickModuleExport({ acme: rule, helper: () => 1 }, 'acme')).toBe(rule);
    expect(pickModuleExport({ acme: rule }, 'other')).toBeUndefined();
  });
});

describe('the live registry', () => {
  it('delegates to what it holds and tells subscribers about a swap', () => {
    const live = createLiveRegistry(createRegistry([]));
    expect(isLiveRegistry(live)).toBe(true);
    expect(isLiveRegistry(createRegistry([]))).toBe(false);
    expect(live.validate(design, db)).toEqual([]);
    let heard = 0;
    const off = live.subscribe(() => (heard += 1));
    live.replace(createRegistry([rule]));
    expect(live.generation).toBe(1);
    expect(heard).toBe(1);
    expect(live.modules.map((m) => m.id)).toEqual(['acme']);
    expect(live.validate(design, db).map((i) => i.code)).toEqual(['acme/todo']);
    off();
    live.replace(createRegistry([]));
    expect(heard).toBe(1);
    expect(live.validate(design, db)).toEqual([]);
  });
});

describe('built-ins with runtime modules', () => {
  const scheme = (id: string) => defineModule({ id, label: id, version: '1.0.0', partNumberScheme: prefixPartNumberScheme({ id, prefixes: { connector: 'X' } }) });
  it('keeps the built-ins first and refuses a clash, one module at a time', () => {
    const builtin = scheme('house');
    const composed = composeRegistry([builtin], [rule, scheme('other'), defineModule({ id: 'house', label: 'again', version: '2.0.0' })]);
    expect(composed.accepted).toEqual(['acme']);
    expect(composed.refused).toEqual([
      { id: 'house', problems: ["this hub's image has a built-in module 'house', which wins"] },
      { id: 'other', problems: ['more than one module sets a part-number scheme (house, other)'] },
    ]);
    expect(composed.registry.modules.map((m) => m.id)).toEqual(['house', 'acme']);
  });
});

describe('declared module settings (API 1.5)', () => {
  const keyed = defineModule({
    id: 'keyed',
    label: 'Keyed',
    version: '1.0.0',
    settings: [
      { key: 'apiKey', label: 'API key', required: true, gates: 'lookup', env: 'KEYED_API_KEY' },
      { key: 'providers', label: 'Providers', kind: 'list', options: ['one', 'two'], env: 'KEYED_PROVIDERS' },
      { key: 'note', label: 'Note', kind: 'text' },
    ],
  });
  it('is its own extension point, and each env override is a permission', () => {
    expect(extensionPointsOf(keyed)).toEqual(['settings']);
    expect(permissionsOf(keyed)).toEqual(['server-code', 'env:KEYED_API_KEY', 'env:KEYED_PROVIDERS']);
    expect(createRegistry([keyed]).module('keyed')?.settings?.map((s) => s.key)).toEqual(['apiKey', 'providers', 'note']);
  });
  it('refuses keys, kinds and env names the host cannot keep', () => {
    const bad = defineModule({
      id: 'bad',
      label: 'Bad',
      version: '1.0.0',
      settings: [
        { key: 'api-key', label: 'x' },
        { key: 'dup', label: 'x', env: 'SAME' },
        { key: 'dup', label: '', env: 'SAME' },
        { key: 'file', label: 'x', env: 'KEY_FILE' },
        { key: 'odd', label: 'x', kind: 'number' as never },
        { key: 'opts', label: 'x', kind: 'text', options: ['a'] },
      ],
    });
    expect(() => createRegistry([bad])).toThrow(/must be camelCase/);
    const problems = (() => {
      try {
        createRegistry([bad]);
        return [];
      } catch (error) {
        return (error as { problems: string[] }).problems;
      }
    })();
    expect(problems).toEqual(expect.arrayContaining([
      "module 'bad' setting 'api-key' must be camelCase letters and digits (at most 64)",
      "module 'bad' has two settings with key 'dup'",
      "module 'bad' setting 'dup' needs a label",
      "module 'bad' setting 'file' env must be an upper-case variable name (not a _FILE)",
      "module 'bad' setting 'odd' kind must be one of secret, text, bool, list",
      "module 'bad' setting 'opts' options belong to a list of kebab-case words",
      "module 'bad' names one environment variable for two settings",
    ]));
  });
  it('needs API 1.5 in a bundle, and older modules keep loading', () => {
    const block = { id: 'keyed', version: '1.0.0', label: 'Keyed', server: 'code/keyed/server.mjs', extensionPoints: ['settings'], permissions: ['server-code', 'env:KEYED_API_KEY', 'env:KEYED_PROVIDERS'] };
    expect(codeModuleManifestProblems({ ...block, apiVersion: '1.4' })).toEqual(['declared module settings require module API 1.5 or newer']);
    expect(codeModuleManifestProblems({ ...block, apiVersion: '1.5' })).toEqual([]);
    expect(runtimeModuleProblems(keyed, { ...block, apiVersion: '1.5' })).toEqual([]);
    expect(runtimeModuleProblems(keyed, { ...block, apiVersion: '1.5', permissions: ['server-code'] })).toEqual([
      "it needs the permission 'env:KEYED_API_KEY', which its manifest does not declare",
      "it needs the permission 'env:KEYED_PROVIDERS', which its manifest does not declare",
    ]);
    expect(apiCompatibility('1.4')).toEqual({ ok: true });
    expect(runtimeModuleProblems(rule, manifest({ apiVersion: '1.4' }))).toEqual([]);
  });
});
