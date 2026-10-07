// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArtworkAdapter, ArtworkDetail } from '../src/artwork.ts';
import type { ModelsAdapter } from '../src/models.ts';
import { ModelPanel } from '../src/panels/ModelPanel.tsx';

vi.mock('../src/panels/ModelViewer3d.tsx', () => ({ default: () => <p>Loaded synthetic model</p> }));
beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const modelsOf = (): ModelsAdapter => ({
  get: vi.fn<ModelsAdapter['get']>(async () => ({ ok: true, value: null })),
  list: async () => ({ ok: true, value: { links: [], models: [] } }),
  attach: async () => ({ ok: false, message: 'Not used' }),
  upload: async () => ({ ok: false, message: 'Not used' }),
  detach: async () => ({ ok: true, value: null }),
  fetchModel: async () => ({ ok: false, message: 'Not used' }),
});
const detail: ArtworkDetail = {
  defId: 'synthetic-board', exists: true,
  views: [{ view: 'board-top', file: 'board-top.svg', kind: 'vector', mmPerUnit: 1, sourceKind: 'gerber', src: 'synthetic example', derived: false, anchors: {} }],
  pinAnchors: {}, unanchored: [], issues: [], uploadableViews: [],
};
const artworkOf = (): ArtworkAdapter => ({
  detail: async () => ({ ok: true, value: detail }),
  artwork: async () => ({ ok: true, value: { kind: 'vector', source: '<svg xmlns="http://www.w3.org/2000/svg"/>' } }),
  upload: async () => ({ ok: false, message: 'Not used' }),
  saveAnchors: async () => ({ ok: false, message: 'Not used' }),
});

it('distinguishes a failed link request from an absent model and retries in read-only views', async () => {
  const models = modelsOf();
  models.get = vi.fn().mockResolvedValueOnce({ ok: false, message: 'Model service unavailable', hint: 'Try again later.' }).mockResolvedValue({ ok: true, value: null });
  render(<ModelPanel kind="pcbas" id="synthetic-board" label="Synthetic board" models={models} readOnly />);
  expect((await screen.findByRole('alert')).textContent).toContain('Model service unavailable');
  expect(screen.queryByText('No 3D model')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Attach model' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry pictures' }));
  expect(await screen.findByText('No 3D model')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('replaces failed artwork loading with an error and recovers the same view', async () => {
  const artwork = artworkOf();
  artwork.artwork = vi.fn().mockResolvedValueOnce({ ok: false, message: 'Picture unavailable' }).mockResolvedValue({ ok: true, value: { kind: 'vector', source: '<svg xmlns="http://www.w3.org/2000/svg"/>' } });
  render(<ModelPanel kind="pcbas" id="synthetic-board" label="Synthetic board" models={modelsOf()} artwork={artwork} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Picture unavailable');
  expect(screen.queryByText('Loading…')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry picture' }));
  expect(await screen.findByRole('img', { name: '2D art of Synthetic board' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('retries failed 3D bytes without discarding the existing model link', async () => {
  const models = modelsOf();
  models.get = vi.fn<ModelsAdapter['get']>(async () => ({ ok: true, value: { record: 'pcbas/synthetic-board', asset: 'a'.repeat(64), sourceKind: 'uploaded', src: 'synthetic example', built: false } }));
  models.fetchModel = vi.fn().mockRejectedValueOnce(new Error('synthetic connection failure')).mockResolvedValue({ ok: true, value: { bytes: new ArrayBuffer(16), mime: 'model/gltf-binary' } });
  render(<ModelPanel kind="pcbas" id="synthetic-board" label="Synthetic board" models={models} />);
  expect((await screen.findByRole('alert')).textContent).toContain('3D model could not be loaded');
  expect(screen.getByRole('button', { name: 'Replace model' })).toBeTruthy();
  expect(screen.getByText(/not built yet/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry 3D model' }));
  expect(await screen.findByText('Loaded synthetic model')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByText(/not built yet/)).toBeNull();
});

it('ignores a late rejected request after switching records', async () => {
  const models = modelsOf();
  let reject!: (error: Error) => void;
  models.get = vi.fn().mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; })).mockResolvedValue({ ok: true, value: null });
  const page = render(<ModelPanel kind="pcbas" id="first-board" label="First board" models={models} />);
  page.rerender(<ModelPanel kind="pcbas" id="second-board" label="Second board" models={models} />);
  await screen.findByText('No 3D model');
  await act(async () => { reject(new Error('late synthetic rejection')); });
  expect(screen.queryByRole('alert')).toBeNull();
});

it('shows supplied bottom artwork with mirrored anchors and switches without editing', async () => {
  const artwork = artworkOf();
  artwork.detail = async () => ({ ok: true, value: { ...detail, views: [
    { ...detail.views[0]!, view: 'board-bottom', file: 'board-bottom.svg', derived: true, mirrorOf: 'board-top' },
    detail.views[0]!,
  ] } });
  artwork.artwork = vi.fn(async (_id, view) => ({ ok: true as const, value: { kind: 'vector' as const, source: `<svg xmlns="http://www.w3.org/2000/svg"><title>${view}</title></svg>` } }));
  render(<ModelPanel kind="pcbas" id="synthetic-board" label="Synthetic board" models={modelsOf()} artwork={artwork} readOnly />);
  const image = await screen.findByRole('img', { name: '2D art of Synthetic board' });
  expect(decodeURIComponent(image.getAttribute('src')!)).toContain('board-top');
  fireEvent.change(screen.getByRole('combobox', { name: '2D artwork view' }), { target: { value: 'board-bottom' } });
  await screen.findByText('board bottom', { selector: 'p' });
  expect(decodeURIComponent(screen.getByRole('img', { name: '2D art of Synthetic board' }).getAttribute('src')!)).toContain('board-bottom');
  expect(artwork.artwork).toHaveBeenCalledWith('synthetic-board', 'board-bottom');
});

it('shows bottom-only artwork without inventing a top view', async () => {
  const artwork = artworkOf();
  artwork.detail = async () => ({ ok: true, value: { ...detail, views: [{ ...detail.views[0]!, view: 'board-bottom', file: 'board-bottom.svg', derived: true, mirrorOf: 'board-top' }] } });
  artwork.artwork = vi.fn(artwork.artwork);
  render(<ModelPanel kind="pcbas" id="synthetic-board" label="Synthetic board" models={modelsOf()} artwork={artwork} />);
  await screen.findByRole('img', { name: '2D art of Synthetic board' });
  expect(artwork.artwork).toHaveBeenCalledWith('synthetic-board', 'board-bottom');
  expect(screen.queryByRole('combobox', { name: '2D artwork view' })).toBeNull();
});
