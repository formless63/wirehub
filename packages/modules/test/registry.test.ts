import { describe, expect, it } from 'vitest';
import { prefixPartNumberScheme, type CableDesign, type Db } from '@wirehub/model';

import { EMPTY_REGISTRY, ModuleManifestError, createRegistry, defineModule, manifestProblems } from '../src/index.ts';

const db: Db = { connectors: [], wires: [], components: [], pcbas: [] };
const design: CableDesign = {
  schemaVersion: 4,
  id: 'empty',
  label: 'Empty',
  instances: { connectors: [], segments: [], components: [], pcbas: [] },
  joints: [],
  src: 'synthetic example',
};

const example = defineModule({
  id: 'example',
  label: 'Example module',
  version: '0.1.0',
  partNumberScheme: prefixPartNumberScheme({ id: 'ex', prefixes: { connector: 'EXC' } }),
  validationRules: [
    {
      id: 'needs-joint',
      label: 'A design needs at least one joint',
      check: (d: CableDesign) => (d.joints.length === 0 ? [{ code: 'no-joints', severity: 'warning' as const, message: 'no joints yet' }] : []),
    },
  ],
  importers: [{ id: 'csv-pins', label: 'Pin table (CSV)', accepts: ['.csv'], import: () => ({ notes: [] }) }],
  panels: [{ id: 'hello', label: 'Hello', slot: 'cable-inspector', component: 'HelloPanel' }],
});

describe('module registry', () => {
  it('an empty manifest is usable and contributes nothing', () => {
    expect(EMPTY_REGISTRY.modules).toEqual([]);
    expect(EMPTY_REGISTRY.partNumberScheme()).toBeUndefined();
    expect(EMPTY_REGISTRY.validate(design, db)).toEqual([]);
  });

  it('collects contributions, tagged with their module', () => {
    const registry = createRegistry([example]);
    expect(registry.partNumberScheme()?.id).toBe('ex');
    expect(registry.importersFor('pins.CSV').map((i) => `${i.module}:${i.id}`)).toEqual(['example:csv-pins']);
    expect(registry.importersFor('board.kicad_pcb')).toEqual([]);
    expect(registry.panels('cable-inspector').map((p) => p.id)).toEqual(['hello']);
    expect(registry.panels('settings')).toEqual([]);
  });

  it('prefixes rule issue codes with the module id', () => {
    const issues = createRegistry([example]).validate(design, db);
    expect(issues).toEqual([{ code: 'example/no-joints', severity: 'warning', message: 'no joints yet' }]);
  });

  it('refuses duplicate ids, a second scheme and bad versions', () => {
    const twin = { ...example, partNumberScheme: example.partNumberScheme };
    expect(manifestProblems([example, twin])).toEqual(
      expect.arrayContaining([
        "module 'example' is listed twice",
        'more than one module sets a part-number scheme (example, example)',
        "importer 'csv-pins' is contributed by both example and example",
      ]),
    );
    expect(manifestProblems([{ id: 'Bad Id', label: 'x', version: 'one' }])).toEqual([
      "'Bad Id' is not a kebab-case module id",
      "module 'Bad Id' version 'one' is not semver",
    ]);
    expect(() => createRegistry([example, twin])).toThrow(ModuleManifestError);
  });
});

describe('domain modules', () => {
  const bus = defineModule({
    id: 'bus',
    label: 'Bus',
    version: '0.1.0',
    setup: { kind: 'domain', description: 'Bus signals and connectors.', suggested: true },
    catalogPacks: [{ id: 'bus', label: 'Bus', version: '0.1.0', root: 'file:///packs/bus/' }],
  });

  it('lists the optional domain modules setup offers, and only those', () => {
    const registry = createRegistry([example, bus]);
    expect(registry.domains().map((m) => m.id)).toEqual(['bus']);
  });

  it('refuses a domain module with nothing to install', () => {
    const { catalogPacks: _packs, ...empty } = bus;
    expect(manifestProblems([empty])).toEqual(["domain module 'bus' ships no catalog pack for setup to install"]);
  });
});

describe('derived records, owned files and reserved names', () => {
  const withDerived = defineModule({
    id: 'reports',
    label: 'Reports',
    version: '1.0.0',
    documents: [{ path: 'data/reports/', class: 'report' }, { path: 'data/shared-register.json', class: 'imported' }, { path: 'data/imports/pins.json', class: 'imported' }],
    derived: [{ id: 'summary', label: 'Summary', files: ['summary.json', 'notes.md'], derive: () => ({ 'summary.json': {}, 'notes.md': '' }) }],
  });

  it('lists the catalog directories modules own, derived ones included', () => {
    expect(createRegistry([withDerived]).catalogDirs()).toEqual(['', 'derived/reports', 'imports', 'reports']);
    expect(EMPTY_REGISTRY.catalogDirs()).toEqual([]);
  });

  it('looks importers and exporters up by module and id', () => {
    const registry = createRegistry([example]);
    expect(registry.importer('example', 'csv-pins')?.label).toBe('Pin table (CSV)');
    expect(registry.importer('example', 'nope')).toBeUndefined();
    expect(registry.exporter('example', 'x')).toBeUndefined();
  });

  it('refuses bad derived files, documents under data/derived/, reserved route names and duplicate panels', () => {
    const bad = defineModule({
      id: 'bad',
      label: 'Bad',
      version: '1.0.0',
      derived: [{ id: 'x', label: 'X', files: ['Report.txt', 'a.json', 'a.json'], derive: () => ({}) }],
      documents: [{ path: 'data/derived/bad/', class: 'report' }],
      integrations: [{ id: 'i', label: 'I', routes: [{ method: 'GET', path: '_import/x', handle: async () => ({ status: 200, body: null }) }] }],
      routes: [{ path: 'Has Spaces', label: 'R', component: null }],
      panels: [
        { id: 'p', label: 'P', slot: 'settings', component: null },
        { id: 'p', label: 'P2', slot: 'settings', component: null },
      ],
    });
    const problems = manifestProblems([bad]);
    expect(problems).toHaveLength(6);
    expect(problems.join('\n')).toMatch(/Report\.txt.*\.json or \.md/);
    expect(problems.join('\n')).toMatch(/'a\.json' twice/);
    expect(problems.join('\n')).toMatch(/data\/derived\//);
    expect(problems.join('\n')).toMatch(/reserves|reserved/);
    expect(problems.join('\n')).toMatch(/UI route 'Has Spaces'/);
    expect(problems.join('\n')).toMatch(/two panels/);
  });
});

describe('art contributions', () => {
  const mod = (id: string, art: object) => defineModule({ id, label: id, version: '1.0.0', art });
  it('lists each module\'s art in manifest order', () => {
    const registry = createRegistry([mod('a-mod', { connectors: [{ id: 'one' }] }), mod('b-mod', { bodyLayouts: [{ id: 'two' }] })]);
    expect(registry.art().map((a) => a.module)).toEqual(['a-mod', 'b-mod']);
  });
  it('refuses a record without a kebab id and an id two modules both draw', () => {
    expect(() => createRegistry([mod('a-mod', { connectors: [{ short: 'x' }] })])).toThrow(/without a kebab-case id/);
    expect(() => createRegistry([mod('a-mod', { connectors: [{ id: 'one' }] }), mod('b-mod', { connectors: [{ id: 'one' }] })])).toThrow(/'one' is contributed by both/);
  });

  it('lists the job queues an integration registers, as <module>:<queue>', () => {
    const m = defineModule({
      id: 'acme',
      label: 'Acme',
      version: '1.0.0',
      integrations: [{ id: 'sync', label: 'Sync', queues: [{ id: 'push', label: 'Push', schedule: '*/15 * * * *', run: async () => ({ pushed: 1 }) }, { id: 'pull', label: 'Pull', run: async () => undefined }] }],
    });
    expect(manifestProblems([m])).toEqual([]);
    expect(createRegistry([m]).queues().map((q) => [q.kind, q.module, q.id, q.schedule])).toEqual([
      ['acme:push', 'acme', 'push', '*/15 * * * *'],
      ['acme:pull', 'acme', 'pull', undefined],
    ]);
    expect(EMPTY_REGISTRY.queues()).toEqual([]);
  });

  it('refuses a queue with a bad id, a duplicate id or a schedule that is not cron', () => {
    const run = async (): Promise<void> => undefined;
    const bad = defineModule({
      id: 'bad',
      label: 'Bad',
      version: '1.0.0',
      integrations: [{ id: 'i', label: 'I', queues: [{ id: 'Not Kebab', label: 'A', run }, { id: 'dup', label: 'B', run }, { id: 'dup', label: 'C', run }, { id: 'when', label: 'D', schedule: 'daily', run }] }],
    });
    const problems = manifestProblems([bad]).join('\n');
    expect(problems).toMatch(/queue 'Not Kebab' is not a kebab-case id/);
    expect(problems).toMatch(/two queues with id 'dup'/);
    expect(problems).toMatch(/queue 'when' schedule must be a five-field cron/);
  });
});

describe('compare views', () => {
  const view = (id: string, kinds?: string[]) => ({ id, label: id, ...(kinds === undefined ? {} : { kinds }), component: () => null });

  it('are found by the Library kind they declare, the first registration winning; none declared = every kind', () => {
    const registry = createRegistry([
      defineModule({ id: 'one', label: 'One', version: '1.0.0', compareViews: [view('boards', ['pcbas'])] }),
      defineModule({ id: 'two', label: 'Two', version: '1.0.0', compareViews: [view('any')] }),
    ]);
    expect(registry.compareViews().map((v) => `${v.module}/${v.id}`)).toEqual(['one/boards', 'two/any']);
    expect(registry.compareViewFor('pcbas')?.module).toBe('one');
    expect(registry.compareViewFor('wires')?.module).toBe('two');
    expect(createRegistry([]).compareViewFor('pcbas')).toBeUndefined();
  });

  it('refuse two views with one id in a module', () => {
    expect(() => createRegistry([defineModule({ id: 'one', label: 'One', version: '1.0.0', compareViews: [view('x'), view('x')] })])).toThrow(/two compare views with id 'x'/);
  });
});
