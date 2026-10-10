import { DEFAULT_PART_NUMBER_SCHEME } from '@wirehub/model';
import { partNumberScope } from '../src/part-numbers.ts';
import { describe, expect, it } from 'vitest';
import { assetCoverage, sourceRevisionModels } from '../src/asset-coverage.ts';
import type { ModelLinkView } from '../src/models.ts';
import { libraryRows } from '../src/library-table.ts';
import { loadDbFromDisk } from './fixture.ts';

const link: ModelLinkView = { record: 'pcbas/synthetic-board', asset: 'a'.repeat(64), sourceKind: 'vendor', src: 'Synthetic citation' };
function glb(document: object): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(document));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(length + 20); const view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.byteLength, true); view.setUint32(12, length, true); view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20).fill(32); new Uint8Array(bytes, 20, json.length).set(json);
  return bytes;
}

describe('evidence-based asset coverage', () => {
  it('never treats a vendor label or citation as verified exact CAD', () => {
    const value = assetCoverage('pcbas', link, [], { bytes: glb({ asset: { version: '2.0' }, materials: [{}] }), mime: 'model/gltf-binary' }, false, true);
    expect(value.model).toBe('Source model'); expect(value.explanation).toContain('not been verified');
    expect(value.materials).toContain('finish not verified'); expect(value.back).toBe('Bottom: artwork missing');
  });
  it('recognizes generated GLB bytes even if a link calls them an upload', () => {
    const value = assetCoverage('connectors', { ...link, sourceKind: 'uploaded' }, [], { bytes: glb({ asset: { extras: { source: 'parametric' } }, materials: [{}] }), mime: 'model/gltf-binary' }, true);
    expect(value.model).toBe('Generated approximation'); expect(value.materials).toBe('Illustrative materials'); expect(value.front).toContain('generated pin diagram');
  });
  it('does not turn an unqueried artwork adapter into evidence of missing artwork', () => {
    const value = assetCoverage('pcbas', link, [], undefined, false, false);
    expect(value.front).toBe('Top: artwork not inspected'); expect(value.back).toBe('Bottom: artwork not inspected');
    expect(assetCoverage('connectors', link, [], undefined, true, false).front).toBe('Front: generated pin diagram');
  });
  it('distinguishes absent, unavailable, unbuilt and geometry-only assets', () => {
    expect(assetCoverage('pcbas', null, []).model).toBe('3D missing');
    expect(assetCoverage('pcbas', undefined, []).model).toBe('3D status loading');
    expect(assetCoverage('pcbas', { ...link, built: false }, []).model).toBe('3D awaiting build');
    expect(assetCoverage('pcbas', link, [], { bytes: glb({ asset: {} }), mime: 'model/gltf-binary' }).materials).toBe('No material data recorded');
    expect(assetCoverage('pcbas', link, [], { bytes: new ArrayBuffer(0), mime: 'model/stl' }).materials).toContain('STL has no material');
    expect(assetCoverage('pcbas', link, [], { bytes: new ArrayBuffer(20), mime: 'model/gltf-binary' }).materials).toBe('Material data unknown');
  });
  it('does not invent source revisions from current links and favors record-specific assets', () => {
    const values = sourceRevisionModels([
      { ...link, record: 'revisions/BOARD-1/Rev2' },
      { ...link, record: 'revisions/synthetic-board/Rev2', asset: 'b'.repeat(64) },
      { ...link, record: 'revisions/synthetic-board/Rev10' },
      { ...link, record: 'revisions/other-board/Rev1' }, link,
    ], 'synthetic-board', 'board-1');
    expect(values.map((v) => v.revision)).toEqual(['Rev2', 'Rev10']); expect(values[0]!.link.asset).toBe('b'.repeat(64));
  });
  it('permits choosing the shared body number but catches an independent number already assigned to another pinout', () => {
    const db = loadDbFromDisk(); const first = db.connectors.find((c) => c.body !== undefined)!;
    const sharedPn = db.bodies!.find((b) => b.id === first.body)!.partNumber!;
    db.connectors = [first, { ...first, id: 'synthetic-another-pinout', partNumber: 'CON-77777' }];
    const scope = partNumberScope({ scheme: DEFAULT_PART_NUMBER_SCHEME }, db);
    expect(scope.taken(sharedPn, { kind: 'connector', def: first })).toEqual([]);
    expect(scope.taken('CON-77777', { kind: 'connector', def: { ...first, partNumber: 'CON-77777' } })).toEqual(['connectors/synthetic-another-pinout']);
  });
  it('explains shared physical numbers visibly without renumbering definitions', () => {
    const db = loadDbFromDisk(); const first = db.connectors.find((c) => c.body !== undefined)!;
    db.connectors.push({ ...first, id: 'synthetic-another-pinout', interface: undefined });
    const before = JSON.stringify(db); const rows = libraryRows('connectors', db.connectors, [], { db });
    expect(rows.find((r) => r.id === first.id)!.pn.sharedBody).toBe(first.body);
    expect(rows.find((r) => r.id === first.id)!.pn.note).toContain('shared by 2 pinouts');
    expect(JSON.stringify(db)).toBe(before);
  });
});
