/**
 * The definition lifecycle, driven end to end against an in-memory host.
 *
 * The same shape as `lifecycle.test.ts` and for the same reason: these are the
 * operations that change *what exists*, every one of them can be told no, and
 * what a refusal reads like on screen is as much a part of the feature as the
 * write is.
 */

import { loadDb, loadDesign } from '@wirehub/catalog';
import type { ConnectorDefinition, Db, WireDefinition } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import {
  checkDefinition,
  createDefinition,
  deleteDefinition,
  isDefinitionId,
  saveDefinition,
  usageNames,
  usageSentence,
} from '../src/definitions.ts';
import { connectorDraftOf, connectorOf, wireDefinitionOf, wireFormOf } from '../src/library.ts';
import { memoryDefinitions } from './memory-definitions.ts';

const db: Db = loadDb();
const DESIGNS = [loadDesign('de9-crossover'), loadDesign('de9-terminal-board')];

const host = (): ReturnType<typeof memoryDefinitions> => memoryDefinitions(db, DESIGNS);

const connector = (id: string): ConnectorDefinition =>
  structuredClone(db.connectors.find((candidate) => candidate.id === id) as ConnectorDefinition);

const NEW_PLUG: ConnectorDefinition = {
  id: 'test-2p-header',
  label: 'Test 2-pin header',
  family: 'header',
  pins: [
    { id: '1', label: 'Signal' },
    { id: '2', label: 'GND' },
  ],
  src: 'test fixture',
};

/* ------------------------------------------------------------------ *
 * The checks that need no round trip
 * ------------------------------------------------------------------ */

describe('checkDefinition', () => {
  it('accepts a complete record', () => {
    expect(checkDefinition('connectors', NEW_PLUG)).toBeUndefined();
  });

  it('asks for an id in words, and shows what one looks like', () => {
    const result = checkDefinition('connectors', { ...NEW_PLUG, id: '' });
    expect(result?.ok).toBe(false);
    expect(result?.ok === false && result.problem.message).toContain('needs an id');
    expect(result?.ok === false && result.problem.hint).toContain('hyphens');
  });

  it('refuses an id that is not a slug, naming it', () => {
    const result = checkDefinition('components', { ...NEW_PLUG, id: 'Not A Slug' } as never);
    expect(result?.ok === false && result.problem.message).toContain("'Not A Slug'");
  });

  it('insists on provenance, in the spec’s own words', () => {
    const result = checkDefinition('wires', { ...NEW_PLUG, src: '   ' } as never);
    expect(result?.ok === false && result.problem.message).toContain('where its information comes from');
  });

  it('knows a usable id when it sees one', () => {
    expect(isDefinitionId('pca-00101-rev6-basic')).toBe(true);
    expect(isDefinitionId('cap-220uf-tant')).toBe(true);
    expect(isDefinitionId('Scart_Male')).toBe(false);
    expect(isDefinitionId('../etc/passwd')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

describe('saveDefinition', () => {

  it('does not reach the host at all when the record is obviously incomplete', async () => {
    const adapter = host();
    const result = await saveDefinition(adapter, 'connectors', { ...NEW_PLUG, src: '' });
    expect(result.ok).toBe(false);
    expect(adapter.calls).toEqual([]);
  });

  it('carries a form round trip through unchanged', async () => {
    const adapter = host();
    const source = connector('jst-xh-2-dc');
    const result = await saveDefinition(
      adapter,
      'connectors',
      connectorOf(connectorDraftOf(source)),
    );
    expect(result.ok).toBe(true);
    expect(adapter.db().connectors.find((c) => c.id === 'jst-xh-2-dc')).toEqual(source);
  });
});

describe('createDefinition', () => {
  it('adds a record that was not there', async () => {
    const adapter = host();
    const result = await createDefinition(adapter, 'connectors', NEW_PLUG);
    expect(result.ok).toBe(true);
    expect(result.ok && result.status).toBe('added test-2p-header');
    expect(adapter.db().connectors.at(-1)?.id).toBe('test-2p-header');
  });

  it('refuses a record with a duplicate pin, in the validator’s words', async () => {
    const adapter = host();
    const result = await createDefinition(adapter, 'connectors', {
      ...NEW_PLUG,
      pins: [...NEW_PLUG.pins, { id: '1', label: 'Signal again' }],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.details[0]).toContain('duplicate pin');
  });
});

/* ------------------------------------------------------------------ *
 * Deleting — the referential check the user actually sees
 * ------------------------------------------------------------------ */

describe('deleteDefinition', () => {
  it('needs the id confirmed, and says so without asking the host', async () => {
    const adapter = host();
    const result = await deleteDefinition(adapter, 'connectors', 'scart-male', 'scart');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem.hint).toContain('scart-male');
    expect(adapter.calls).toEqual([]);
  });

  it('deletes a definition nothing points at', async () => {
    const adapter = host();
    await createDefinition(adapter, 'connectors', NEW_PLUG);
    const result = await deleteDefinition(
      adapter,
      'connectors',
      'test-2p-header',
      'test-2p-header',
    );
    expect(result.ok).toBe(true);
    expect(adapter.db().connectors.some((c) => c.id === 'test-2p-header')).toBe(false);
  });

});

/* ------------------------------------------------------------------ *
 * Saying it on screen
 * ------------------------------------------------------------------ */

describe('the caution line', () => {
  it('says nothing when nothing uses the record', () => {
    expect(
      usageSentence({ kind: 'components', id: 'r-1', designs: [], definitions: [], count: 0 }),
    ).toBeUndefined();
  });

  it('counts designs and other definitions separately, in words', () => {
    const sentence = usageSentence({
      kind: 'connectors',
      id: 'scart-male',
      designs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      definitions: ['pcbas/x'],
      count: 3,
    });
    expect(sentence).toBe('Used by 2 designs and 1 other definition — changes here affect them.');
  });

  it('gets the singular right, because a tool that says "1 designs" is not trusted', () => {
    expect(
      usageSentence({
        kind: 'wires',
        id: 'w',
        designs: [{ id: 'a', label: 'A' }],
        definitions: [],
        count: 1,
      }),
    ).toBe('Used by 1 design — changes here affect it.');
  });

  it('names the referrers for the dialog', () => {
    expect(
      usageNames({
        kind: 'wires',
        id: 'w',
        designs: [{ id: 'a', label: 'A cable' }],
        definitions: ['pcbas/x'],
        count: 2,
      }),
    ).toEqual(['a — A cable', 'pcbas/x']);
  });
});
