/**
 * The design lifecycle, driven with a `Map` for a host.
 *
 * These are the rules the buttons stand on: what counts as unsaved, what a
 * suggested id looks like, and — the part that matters most — what the user is
 * told when the answer is no. Every failure asserted here is a sentence with a
 * next step and, when the validator refused the document, one plain line per
 * problem. Nothing in this path may show a code or a payload.
 */

import type { CableDesign, Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  createDesign,
  deleteDesign,
  duplicateDesign,
  problemOf,
  renameDesign,
  saveDesign,
} from '../src/lifecycle.ts';
import {
  blankDesign,
  isDesignId,
  isDirty,
  slugify,
  suggestDesignId,
} from '../src/persistence.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';
import { memoryPersistence } from './memory-persistence.ts';

const db: Db = loadDbFromDisk();
const REAL: CableDesign = loadDesignFromDisk('rs485-de9-terminal-board');

function host(): ReturnType<typeof memoryPersistence> {
  return memoryPersistence(db, [REAL, blankDesign('scratch-one', 'Scratch one', 'test fixture')]);
}

/* ------------------------------------------------------------------ *
 * Names
 * ------------------------------------------------------------------ */

describe('ids and names', () => {
  it('accepts kebab-case and nothing else', () => {
    for (const good of ['a', 'rs485-de9-terminal-board', 'cable2', 'pca-00110-rev4']) {
      expect(isDesignId(good), good).toBe(true);
    }
    for (const bad of ['', 'A', 'a b', 'a_b', 'a.json', '../x', 'a--b', '-a', 'a-', 'a/b', 42]) {
      expect(isDesignId(bad), String(bad)).toBe(false);
    }
  });

  it('suggests an id from what the user typed as the name', () => {
    expect(slugify('Mixer (Main) → Stage, 75 Ω coax — csync')).toBe('mixer-main-stage-75-coax-csync');
    expect(slugify('Café Studio')).toBe('cafe-studio');
    expect(slugify('   ')).toBe('');
    expect(isDesignId(slugify('XLR → Mixer: hot!'))).toBe(true);
  });

  it('steps around the ids already in use rather than suggesting a clash', () => {
    expect(suggestDesignId('Scratch one', ['scratch-one'])).toBe('scratch-one-2');
    expect(suggestDesignId('Scratch one', ['scratch-one', 'scratch-one-2'])).toBe('scratch-one-3');
    expect(suggestDesignId('Scratch one', [])).toBe('scratch-one');
  });
});

/* ------------------------------------------------------------------ *
 * Dirty tracking
 * ------------------------------------------------------------------ */

describe('unsaved changes', () => {
  it('is nothing when the draft still says what the stored design says', () => {
    expect(isDirty(structuredClone(REAL), REAL)).toBe(false);
  });

  it('ignores key order — a round trip is not an edit', () => {
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(REAL).reverse())),
    ) as CableDesign;
    expect(isDirty(reordered, REAL)).toBe(false);
  });

  it('notices a changed fact', () => {
    expect(isDirty({ ...REAL, label: 'something else' }, REAL)).toBe(true);
    expect(isDirty({ ...REAL, joints: REAL.joints.slice(1) }, REAL)).toBe(true);
  });

  it('counts a draft with no baseline as unsaved, which is the safe way to be wrong', () => {
    expect(isDirty(REAL, undefined)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Save
 * ------------------------------------------------------------------ */

describe('Save', () => {
  it('writes the draft and reports the design that was stored', async () => {
    const adapter = host();
    const result = await saveDesign(adapter, { ...structuredClone(REAL), label: 'Edited in the GUI' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toEqual({
      kind: 'saved',
      design: expect.objectContaining({ id: REAL.id, label: 'Edited in the GUI' }),
    });
    expect(adapter.stored.get(REAL.id)?.label).toBe('Edited in the GUI');
    // the draft is now the stored design: the baseline moved with it
    if (result.change.kind !== 'saved') return;
    expect(isDirty(result.change.design, adapter.stored.get(REAL.id))).toBe(false);
  });

  it('turns a refused design into sentences, and writes nothing', async () => {
    const adapter = host();
    const broken = structuredClone(REAL);
    broken.instances.connectors.push({ id: 'j99', def: 'no-such-connector' });

    const result = await saveDesign(adapter, broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain(REAL.id);
    expect(result.problem.hint).toContain('untouched');
    expect(result.problem.details.length).toBeGreaterThan(0);
    expect(result.problem.details.join(' ')).toContain('no-such-connector');
    // plain language only: no codes, no JSON
    expect(result.problem.details.join(' ')).not.toContain('unknown-def');
    expect(result.problem.details.join(' ')).not.toContain('{');
    expect(adapter.stored.get(REAL.id)).toEqual(REAL);
  });

  it('says so when the design it was asked to save is not there any more', async () => {
    const adapter = host();
    adapter.stored.delete(REAL.id);
    const result = await saveDesign(adapter, REAL);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain(REAL.id);
    expect(result.problem.hint).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * New
 * ------------------------------------------------------------------ */

describe('New', () => {
  it('creates a blank design that is valid the moment it exists', async () => {
    const adapter = host();
    const result = await createDesign(adapter, {
      id: 'fresh-cable',
      label: 'Fresh cable',
      src: 'bench measurement 2026-08-18',
    });

    expect(result.ok).toBe(true);
    const created = adapter.stored.get('fresh-cable');
    expect(created).toMatchObject({ label: 'Fresh cable', src: 'bench measurement 2026-08-18' });
    expect(created?.joints).toEqual([]);
  });

  it('insists on knowing where the information comes from', async () => {
    const adapter = host();
    const result = await createDesign(adapter, { id: 'fresh-cable', label: 'Fresh', src: '  ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain('where its information comes from');
    expect(result.problem.hint).toBeDefined();
    // refused before it ever reached the host
    expect(adapter.calls).toEqual([]);
  });

  it('refuses an unusable id without a round trip, and says what a usable one is', async () => {
    const adapter = host();
    const result = await createDesign(adapter, { id: 'Fresh Cable', label: 'Fresh', src: 'note' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.hint).toContain('lowercase words joined by hyphens');
    expect(adapter.calls).toEqual([]);
  });

  it('refuses a design with no name', async () => {
    const adapter = host();
    const result = await createDesign(adapter, { id: 'fresh-cable', label: '   ', src: 'note' });
    expect(result.ok).toBe(false);
    expect(adapter.calls).toEqual([]);
  });

  it('reports the id already being in use as something the user can fix', async () => {
    const adapter = host();
    const result = await createDesign(adapter, {
      id: 'scratch-one',
      label: 'Another scratch',
      src: 'note',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain('already exists');
    expect(result.problem.hint).toContain('different id');
    expect(adapter.stored.get('scratch-one')?.label).toBe('Scratch one');
  });
});

/* ------------------------------------------------------------------ *
 * Duplicate / Rename
 * ------------------------------------------------------------------ */

describe('Duplicate', () => {
  it('copies every part and joint under the new name, leaving the original alone', async () => {
    const adapter = host();
    const result = await duplicateDesign(adapter, REAL.id, {
      id: 'xlr-experiment',
      label: 'XLR experiment',
    });

    expect(result.ok).toBe(true);
    const copy = adapter.stored.get('xlr-experiment');
    expect(copy?.joints).toEqual(REAL.joints);
    expect(copy?.instances).toEqual(REAL.instances);
    expect(copy?.src).toContain(`duplicated from design '${REAL.id}'`);
    expect(adapter.stored.get(REAL.id)).toEqual(REAL);
  });

  it('tells the host what it came from, so the host can open it', async () => {
    const adapter = host();
    const result = await duplicateDesign(adapter, REAL.id, { id: 'xlr-copy', label: 'Copy' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toMatchObject({ kind: 'duplicated', from: REAL.id });
  });

  it('will not copy onto a name in use', async () => {
    const adapter = host();
    const result = await duplicateDesign(adapter, REAL.id, {
      id: 'scratch-one',
      label: 'Clash',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain('already exists');
  });
});

describe('Rename', () => {
  it('moves the design and removes the old one', async () => {
    const adapter = host();
    const result = await renameDesign(adapter, 'scratch-one', {
      id: 'scratch-renamed',
      label: 'Scratch, renamed',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toMatchObject({ kind: 'renamed', from: 'scratch-one' });
    expect(adapter.stored.has('scratch-one')).toBe(false);
    expect(adapter.stored.get('scratch-renamed')?.label).toBe('Scratch, renamed');
  });

  it('can change only the name, keeping the id', async () => {
    const adapter = host();
    const result = await renameDesign(adapter, 'scratch-one', {
      id: 'scratch-one',
      label: 'Better name',
    });
    expect(result.ok).toBe(true);
    expect(adapter.stored.get('scratch-one')?.label).toBe('Better name');
  });

  it('will not rename onto a name in use, and keeps both designs', async () => {
    const adapter = host();
    const result = await renameDesign(adapter, 'scratch-one', { id: REAL.id, label: 'Clash' });
    expect(result.ok).toBe(false);
    expect(adapter.stored.has('scratch-one')).toBe(true);
    expect(adapter.stored.get(REAL.id)).toEqual(REAL);
  });
});

/* ------------------------------------------------------------------ *
 * Delete
 * ------------------------------------------------------------------ */

describe('Delete', () => {
  it('removes the design once its id is confirmed', async () => {
    const adapter = host();
    const result = await deleteDesign(adapter, 'scratch-one', 'scratch-one');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.change).toEqual({ kind: 'deleted', id: 'scratch-one' });
    expect(adapter.stored.has('scratch-one')).toBe(false);
  });

  it('never reaches the host without the confirmation', async () => {
    const adapter = host();
    const result = await deleteDesign(adapter, 'scratch-one', '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain('Nothing was deleted');
    expect(result.problem.hint).toContain('scratch-one');
    expect(adapter.calls).toEqual([]);
    expect(adapter.stored.has('scratch-one')).toBe(true);
  });

  it('refuses a confirmation that names a different design', async () => {
    const adapter = host();
    const result = await deleteDesign(adapter, 'scratch-one', REAL.id);
    expect(result.ok).toBe(false);
    expect(adapter.stored.has('scratch-one')).toBe(true);
    expect(adapter.stored.has(REAL.id)).toBe(true);
  });

  it('says so when there is nothing left to delete', async () => {
    const adapter = host();
    adapter.stored.delete('scratch-one');
    const result = await deleteDesign(adapter, 'scratch-one', 'scratch-one');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.message).toContain('scratch-one');
  });
});

/* ------------------------------------------------------------------ *
 * The picker's data
 * ------------------------------------------------------------------ */

describe('the design list', () => {
  it('comes back sorted, with the labels a picker shows', async () => {
    const adapter = host();
    const listed = await adapter.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((summary) => summary.id)).toEqual([REAL.id, 'scratch-one'].sort());
  });

  it('includes a design created a moment ago, with no code change anywhere', async () => {
    const adapter = host();
    await createDesign(adapter, { id: 'just-made', label: 'Just made', src: 'note' });
    const listed = await adapter.list();
    expect(listed.ok && listed.value.some((summary) => summary.id === 'just-made')).toBe(true);
  });
});

describe('problemOf', () => {
  it('keeps the sentence and drops the machinery', () => {
    const problem = problemOf({
      ok: false,
      message: 'no',
      hint: 'do this instead',
      issues: [
        { code: 'unknown-def', severity: 'error', message: 'connector j99 is not in the library', where: 'j99' },
        { code: 'floating-end', severity: 'warning', message: 'this end is not soldered' },
      ],
    });
    expect(problem.message).toBe('no');
    expect(problem.hint).toBe('do this instead');
    // errors only — a warning is not why a save was refused
    expect(problem.details).toEqual(['connector j99 is not in the library (j99)']);
  });
});
