/**
 * The example module against the registry and the base: one contribution to
 * every extension point, the pack validating over the starter catalog, and
 * each pure piece of logic. The module end to end in the app (API on the file
 * and Postgres backends, the SPA, auth) is `apps/studio/test/*modules*`.
 */

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, installPack, layeredCatalogSource, readPackManifest } from '@wirehub/catalog';
import { readSignalWords, validateDb, validateDesign, type CableDesign, type Db } from '@wirehub/model';
import { createRegistry, manifestProblems, type WireHubModule } from '@wirehub/modules';
import { describe, expect, it } from 'vitest';

import { dataOf, deriveSummary, EXAMPLE_PACK, example, importResistors, jointsCsv, recordEdit, todoLabelRule } from '../src/index.ts';

const starter: Db = createCatalog(fsCatalogSource(dataPath(''), 'starter')).loadDb();
const packDir = fileURLToPath(EXAMPLE_PACK);
const withPack: Db = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(packDir, 'example')])).loadDb();
const design = (label = 'Cable'): CableDesign => ({ schemaVersion: 4, id: 'cable', label, instances: { connectors: [{ id: 'j1', def: 'de9-male' }], segments: [], components: [], pcbas: [] }, joints: [{ a: { instance: 'j1', terminal: '1' }, b: { instance: 'j1', terminal: '2' }, note: 'a, "b"' }], src: 'synthetic example' });

describe('the example module', () => {
  const registry = createRegistry([example]);

  it('is clearly labelled as an example and valid in a manifest', () => {
    expect(manifestProblems([example])).toEqual([]);
    expect(example.label).toMatch(/Example module \(reference implementation, not for production\)/);
    expect(example.setup?.description).toMatch(/EXAMPLE ONLY/);
  });

  it('contributes to every extension point of the module API', () => {
    const keys = Object.keys(example).sort();
    // every optional member of WireHubModule is set (a new extension point added to the API fails this until the example shows it)
    const everyPoint: (keyof WireHubModule)[] = ['setup', 'catalogPacks', 'importers', 'exporters', 'partNumberScheme', 'validationRules', 'integrations', 'panels', 'compareViews', 'routes', 'authProviders', 'commitHook', 'documents', 'derived'];
    for (const point of everyPoint) expect(keys, point).toContain(point);
    expect(registry.domains().map((m) => m.id)).toEqual(['example']);
    expect(registry.catalogPacks().map((p) => p.id)).toEqual(['example']);
    expect(registry.partNumberScheme()?.id).toBe('example');
    expect(registry.commitHook()).toBe(recordEdit);
    expect(registry.importersFor('Parts.CSV').map((i) => i.id)).toEqual(['resistor-csv']);
    expect(registry.exporters().map((e) => e.id)).toEqual(['joints-csv', 'tester-netlist']);
    expect(registry.integrations().flatMap((i) => (i.routes ?? []).map((r) => `${r.method} ${r.path}${r.writes === true ? ' (writes)' : ''}`))).toEqual(['GET status', 'POST recount', 'GET recount', 'POST echo (writes)']);
    for (const slot of ['cable-inspector', 'cable-documents', 'library-detail', 'settings'] as const) expect(registry.panels(slot), slot).toHaveLength(1);
    expect(registry.compareViews().map((v) => v.id)).toEqual(['example-compare']);
    expect(registry.compareViewFor('mechanicals')?.module).toBe('example');
    expect(registry.compareViewFor('connectors')).toBeUndefined();
    expect(registry.queues().map((q) => q.kind)).toEqual(['example:recount']);
    expect(registry.routes().map((r) => r.path)).toEqual(['status']);
    expect(registry.authProviders().map((a) => a.id)).toEqual(['example-sso']);
    expect(registry.documentFor('data/example/notes.json')?.module).toBe('example');
    expect(registry.catalogDirs()).toEqual(['derived/example', 'example']);
    expect(registry.derived().flatMap((d) => d.files)).toEqual(['summary.json', 'summary.md']);
  });

  it('ships a pack that validates over the starter catalog and installs without a conflict', () => {
    expect(readPackManifest(packDir)).toMatchObject({ id: 'example', license: 'CC0-1.0' });
    expect(validateDb(withPack).filter((i) => i.severity === 'error')).toEqual([]);
    // the pack teaches the base's readers its word
    expect(readSignalWords(starter.vocab, 'EX TICK')).toBeUndefined();
    expect(readSignalWords(withPack.vocab, 'EX TICK')).toBe('example-tick');
    const work = mkdtempSync(join(tmpdir(), 'wirehub-example-'));
    try {
      cpSync(dataPath(''), work, { recursive: true });
      installPack(work, packDir);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('refuses a TODO label with its module-prefixed code, and lets other labels through', () => {
    const issues = registry.validate(design('TODO name'), starter);
    expect(issues.map((i) => i.code)).toEqual(['example/todo-label']);
    expect(issues[0]?.severity).toBe('error');
    expect(registry.validate(design('Finished cable'), starter)).toEqual([]);
    expect(todoLabelRule(design('todo'))).toHaveLength(1);
  });

  it('imports CSV lines as proposed resistors the library accepts, and notes the bad lines', () => {
    const out = importResistors('p.csv', new TextEncoder().encode('id,label,value\nex-r-1k,Example 1k,1 kΩ\r\nnot a line\n\nEx R,x,y\n'));
    expect(out.definitions?.components?.map((c) => c.id)).toEqual(['ex-r-1k']);
    expect(out.definitions?.components?.[0]?.src).toMatch(/example importer: p\.csv line 2/);
    expect(out.notes).toHaveLength(2);
    expect(validateDb({ ...starter, components: [...starter.components, ...(out.definitions?.components ?? [])] }).filter((i) => i.severity === 'error')).toEqual([]);
    expect(importResistors('e.csv', new Uint8Array()).notes).toEqual(['the file has no usable lines']);
  });

  it('exports the joints as CSV with quoting', () => {
    const out = jointsCsv(design());
    expect(out).toMatchObject({ mimeType: 'text/csv', fileName: 'cable-joints.csv' });
    expect(out.body).toBe('a,b,note\nj1.1,j1.2,"a, ""b"""\n');
  });

  it('records each edit under extensions.example, keeping other modules\' data', () => {
    const first = recordEdit(design(), { ...design(), extensions: { other: { x: 1 } } }, 'add part');
    expect(first.extensions).toEqual({ other: { x: 1 }, example: { schema: 1, edits: 1, last: 'add part' } });
    expect(dataOf(recordEdit(first, first, 'move'))?.edits).toBe(2);
    expect(dataOf(design())).toBeUndefined();
    // the design is still valid with module data on it: the base carries it through
    expect(validateDesign(first, starter).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('derives a deterministic summary: data and a report, for exactly the files it declares', () => {
    const out = deriveSummary({ designs: [design(), { ...design(), id: 'b' }], db: starter });
    expect(Object.keys(out).sort()).toEqual(example.derived?.[0]?.files.slice().sort());
    expect(out['summary.json']).toMatchObject({ designs: 2, joints: 2, connectors: [{ def: 'de9-male', count: 2 }] });
    expect(out['summary.md']).toBe('# Example summary\n\n2 designs, 2 joints.\n\n- de9-male: 2\n');
    expect(deriveSummary({ designs: [design(), { ...design(), id: 'b' }], db: starter })).toEqual(out);
  });
});
