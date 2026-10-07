import { expect, test } from 'vitest';
import { isSourceSolderMask, textureBoardCoatings, type SourceIdentifiedPart } from '../server/models/board-coating.ts';

const bounds = { minX: 0, maxX: 2, minY: 0, maxY: 2 };
const images = { top: new Uint8Array([1]), bottom: new Uint8Array([2]) };
function shell(): SourceIdentifiedPart {
  return {
    name: 'part-255',
    sourceProductName: 'Synthetic PCB_soldermask',
    positions: new Float32Array([0, 0, 1, 2, 0, 1, 0, 2, 1, 0, 0, 0, 0, 2, 0, 2, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5, 0, 3, 1]),
    color: [0.1, 0.2, 0.3],
  };
}

test('explicit source identities reveal artwork while preserving every coating triangle and position', () => {
  const part = shell();
  const result = textureBoardCoatings([part], bounds, images);
  expect(result).toHaveLength(3);
  expect(result.map((p) => [...p.indices])).toEqual([[0, 1, 2], [3, 4, 5], [0, 3, 1]]);
  expect(result.every((p) => p.positions === part.positions && p.sourceProductName === part.sourceProductName)).toBe(true);
  expect(result[0]!.image).toBe(images.top);
  expect(result[1]!.image).toBe(images.bottom);
  expect(result[0]!.color).toBeUndefined();
  expect(result[2]!.color).toEqual(part.color);
  expect([...result[0]!.uv!].slice(0, 6)).toEqual([0, 1, 1, 1, 0, 0]);
  expect([...result[1]!.uv!].slice(6)).toEqual([1, 1, 1, 0, 0, 1]);
  expect(part.image).toBeUndefined();
  expect([...part.indices]).toEqual([0, 1, 2, 3, 4, 5, 0, 3, 1]);
});

test('coincident anonymous surfaces, silkscreen and lookalike names retain source appearance', () => {
  const anonymous = { ...shell(), sourceProductName: undefined, name: 'Synthetic PCB_soldermask' };
  const silk = { ...shell(), sourceProductName: 'Synthetic PCB_silkscreen' };
  const lookalike = { ...shell(), sourceProductName: 'Synthetic PCB_soldermask_connector' };
  for (const part of [anonymous, silk, lookalike]) {
    expect(isSourceSolderMask(part)).toBe(false);
    expect(textureBoardCoatings([part], bounds, images)).toEqual([part]);
    expect(textureBoardCoatings([part], bounds, images)[0]).toBe(part);
  }
});

test('source occurrence role supports unnamed products, without guessing from dimensions', () => {
  const part = { ...shell(), sourceProductName: undefined, sourceOccurrenceName: 'Synthetic PCB_SOLDERMASK' };
  expect(isSourceSolderMask(part)).toBe(true);
  expect(textureBoardCoatings([part], bounds, images)[0]!.image).toBe(images.top);
  const edgeOnly = { ...part, indices: new Uint32Array([0, 3, 1]) };
  expect(textureBoardCoatings([edgeOnly], bounds, images)[0]).toBe(edgeOnly);
});
