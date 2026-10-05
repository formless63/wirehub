/**
 * `models.json` keys a part revision's own model `revisions/<part>/<revision>` (cs-9ar). `<part>` is a Library record
 * id or a part number (`ABC-123456-00`, upper case): the codec accepts both, and the API answers for either spelling of
 * the record that carries the part number.
 */

import { isModelRecordKey } from '@wirehub/catalog/src/codec/index.ts';
import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryAssetStore } from '../server/assets.ts';
import { memoryModelLinkStore } from '../server/models/links.ts';

describe('revision model-link keys', () => {
  it('accept a record id and a part number, and still refuse what is neither', () => {
    for (const key of ['revisions/pair-terminal-board/Rev1', 'revisions/ABC-123456-00/Rev1', 'revisions/abc-123456-00/rev2', 'connectors/de9-male']) expect(isModelRecordKey(key), key).toBe(true);
    for (const key of ['revisions/ABC-123456-00', 'revisions//Rev1', 'revisions/-ABC/Rev1', 'revisions/ABC 1/Rev1', 'connectors/DE9', 'Revisions/ABC/Rev1', 'revisions/a/b/c']) expect(isModelRecordKey(key), key).toBe(false);
  });

  it('answers for the part number or the record id of the same record', async () => {
    const links = memoryModelLinkStore();
    const link = { record: 'revisions/ABC-123456-00/Rev1', asset: 'a'.repeat(64), sourceKind: 'vendor' as const, src: 'synthetic example', status: 'superseded' as const };
    await links.put(link);
    const db = { pcbas: [{ id: 'parity-board', partNumber: 'ABC-123456-00' }] };
    const deps = { designs: { list: () => [], has: () => false, read: () => undefined, write: () => ({ changed: true }), remove: () => undefined }, loadDb: () => db, assets: memoryAssetStore(), modelLinks: links, today: () => '2026-10-05' } as unknown as WorkbenchDeps;
    const get = async (path: string) => (await handleWorkbenchRequest({ method: 'GET', path }, deps)) as { status: number; body: any };
    expect((await get('/api/models/revisions/ABC-123456-00/Rev1')).body.link.record).toBe('revisions/ABC-123456-00/Rev1');
    // by the record's id, and by the part number in another case
    expect((await get('/api/models/revisions/parity-board/Rev1')).body.link.record).toBe('revisions/ABC-123456-00/Rev1');
    expect((await get('/api/models/revisions/abc-123456-00/Rev1')).body.link.record).toBe('revisions/ABC-123456-00/Rev1');
    // another revision, and an unknown part, have none
    expect((await get('/api/models/revisions/parity-board/Rev9')).body.link).toBeNull();
    expect((await get('/api/models/revisions/ZZZ-000000-00/Rev1')).body.link).toBeNull();
  });
});
