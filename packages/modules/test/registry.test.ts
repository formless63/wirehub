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
  const video = defineModule({
    id: 'video',
    label: 'Video',
    version: '0.1.0',
    setup: { kind: 'domain', description: 'Video signals and connectors.', suggested: true },
    catalogPacks: [{ id: 'video', label: 'Video', version: '0.1.0', root: 'file:///packs/video/' }],
  });

  it('lists the optional domain modules setup offers, and only those', () => {
    const registry = createRegistry([example, video]);
    expect(registry.domains().map((m) => m.id)).toEqual(['video']);
  });

  it('refuses a domain module with nothing to install', () => {
    const { catalogPacks: _packs, ...empty } = video;
    expect(manifestProblems([empty])).toEqual(["domain module 'video' ships no catalog pack for setup to install"]);
  });
});
