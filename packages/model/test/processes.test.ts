/** Required manufacturing processes: declared + derived, unknown ids, the save policy, and capture in saved versions. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesigns } from '@wirehub/catalog';

import { createVersion, freezeDefinitions, integrityIssues, requiredProcesses, validateDesign, versionDb, type CableDesign, type Db, type ProcessDefinition } from '../src/index.ts';

const db = loadDb();
const design = (): CableDesign => structuredClone(loadDesigns().find((d) => d.id === 'de9-crossover') as CableDesign);
const withProcesses = (processes: ProcessDefinition[]): Db => ({ ...db, processes });

// synthetic vocabulary: the starter design has two backshells (m1, m3) and two jackscrews
const SHELL: ProcessDefinition = { id: 'shell-fit', label: 'Shell fitting', derive: [{ each: 'mechanical', where: { eq: [{ path: 'kind' }, 'shell'] } }], src: 'synthetic example' };
const BOARD: ProcessDefinition = { id: 'pcba-assembly', label: 'PCBA assembly', derive: [{ each: 'pcba' }], src: 'synthetic example' };
const LABEL: ProcessDefinition = { id: 'hand-label', label: 'Hand labelling', src: 'synthetic example' };
const UNUSED: ProcessDefinition = { id: 'potting', label: 'Potting', src: 'synthetic example' };

describe('requiredProcesses', () => {
  it('joins declared and derived: both, with the matching subjects', () => {
    const d = { ...design(), processes: [{ id: 'shell-fit', note: 'both ends' }, { id: 'hand-label' }] };
    const { processes, issues } = requiredProcesses(d, withProcesses([SHELL, BOARD, LABEL, UNUSED]));
    expect(issues).toEqual([]);
    expect(processes).toEqual([
      { id: 'hand-label', label: 'Hand labelling', known: true, source: 'declared', declared: {} },
      { id: 'shell-fit', label: 'Shell fitting', known: true, source: 'both', declared: { note: 'both ends' }, derived: { matches: [{ each: 'mechanical', subject: 'm1' }, { each: 'mechanical', subject: 'm3' }], more: 0 } },
    ]);
  });

  it('an unknown or switched-off id stays, known: false, with a warning', () => {
    const d = { ...design(), processes: [{ id: 'mystery' }, { id: 'hand-label' }] };
    const vocab = withProcesses([{ ...LABEL, enabled: false }]);
    const { processes, issues } = requiredProcesses(d, vocab);
    expect(processes.map((p) => [p.id, p.label, p.known, p.source])).toEqual([
      ['hand-label', 'hand-label', false, 'declared'],
      ['mystery', 'mystery', false, 'declared'],
    ]);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([['process-unknown', 'warning'], ['process-unknown', 'warning']]);
    expect(validateDesign(d, vocab).filter((i) => i.code === 'process-unknown')).toHaveLength(2);
  });

  it('a malformed declaration refuses the save; a well-formed one does not', () => {
    for (const bad of [{ id: 'x' }, [{ id: 'Not Kebab' }], [{ id: 'a' }, { id: 'a' }], [{ id: 'a', note: 'n'.repeat(501) }]]) {
      const d = { ...design(), processes: bad } as unknown as CableDesign;
      expect(integrityIssues(validateDesign(d, db)).map((i) => i.code), JSON.stringify(bad).slice(0, 40)).toContain('invalid-processes');
    }
    expect(integrityIssues(validateDesign({ ...design(), processes: [{ id: 'mystery', note: 'fine' }] }, db))).toEqual([]);
  });
});

describe('saved versions', () => {
  it('capture only the declared or matched processes, and read only those later', () => {
    const d = { ...design(), processes: [{ id: 'hand-label' }] };
    const live = withProcesses([SHELL, BOARD, LABEL, UNUSED]);
    expect(freezeDefinitions(d, live).processes?.map((p) => p.id)).toEqual(['hand-label', 'shell-fit']);
    expect(freezeDefinitions(design(), db).processes).toBeUndefined();
    const file = createVersion({ design: d, db: live, rev: 1, at: 't', by: 'x', note: 'n' });
    const before = requiredProcesses(file.design, versionDb(file.definitions, live));
    // later the live process is renamed and derives from every connector; a new one would match too
    const changed = withProcesses([{ ...SHELL, label: 'Renamed', derive: [{ each: 'connector' }] }, { ...UNUSED, derive: [{ each: 'design' }] }, LABEL]);
    expect(requiredProcesses(file.design, versionDb(file.definitions, changed))).toEqual(before);
    expect(before.processes.map((p) => [p.id, p.label, p.source])).toEqual([['hand-label', 'Hand labelling', 'declared'], ['shell-fit', 'Shell fitting', 'derived']]);
  });
});
