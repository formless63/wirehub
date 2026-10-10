// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ArtworkAdapter, ArtworkDetail } from '../src/artwork.ts';
import type { ModelsAdapter } from '../src/models.ts';
import { ModelPanel } from '../src/panels/ModelPanel.tsx';

vi.mock('../src/panels/ModelViewer3d.tsx', () => ({ default: () => <p>Loaded synthetic model</p> }));
beforeEach(() => { window.localStorage.clear(); Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined }); });
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
  const trigger = screen.getByRole('combobox', { name: '2D artwork view' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const option = await screen.findByRole('option', { name: 'board bottom' });
  fireEvent.click(option);
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


it('shows artwork coverage and never claims a reflected anchor set is a generated opposite-side image', async () => {
  render(<ModelPanel kind="pcbas" id="synthetic-board" label="Synthetic board" models={modelsOf()} artwork={artworkOf()} readOnly />);
  await screen.findByText('Top: artwork available');
  expect(screen.getByText('Bottom: artwork missing')).toBeTruthy();
  expect(screen.getByText('3D missing')).toBeTruthy();
});

const bodyDetail: ArtworkDetail = {
  ...detail, defId: 'synthetic-body', views: [
    { ...detail.views[0]!, view: 'mating-face', file: 'mating-face.svg' },
    { ...detail.views[0]!, view: 'solder-side', file: 'solder-side.svg', derived: true, mirrorOf: 'mating-face' },
  ],
};

it('inherits a shared body manifest and reads both faces from that body without writes', async () => {
  const artwork = artworkOf();
  artwork.detail = vi.fn(async (id) => ({ ok: true as const, value: id === 'synthetic-body' ? bodyDetail : { ...detail, defId: id, exists: false, views: [] } }));
  artwork.artwork = vi.fn(async (id, view) => ({ ok: true as const, value: { kind: 'vector' as const, source: `<svg xmlns="http://www.w3.org/2000/svg"><title>${id}/${view}</title></svg>` } }));
  artwork.upload = vi.fn(artwork.upload);
  artwork.saveAnchors = vi.fn(artwork.saveAnchors);
  render(<ModelPanel kind="connectors" id="synthetic-pinout" label="Synthetic connector" models={modelsOf()} artwork={artwork} artworkFallbackIds={['synthetic-body', 'synthetic-drawing']} readOnly />);
  const image = await screen.findByRole('img', { name: '2D art of Synthetic connector' });
  expect(decodeURIComponent(image.getAttribute('src')!)).toContain('synthetic-body/mating-face');
  expect(screen.getByText('Front: artwork available')).toBeTruthy();
  expect(screen.getByText('Back: artwork available · reflected anchors')).toBeTruthy();
  expect(artwork.detail).toHaveBeenCalledTimes(2);
  expect(artwork.detail).toHaveBeenNthCalledWith(1, 'synthetic-pinout');
  expect(artwork.detail).toHaveBeenNthCalledWith(2, 'synthetic-body');
  fireEvent.keyDown(screen.getByRole('combobox', { name: '2D artwork view' }), { key: 'ArrowDown' });
  fireEvent.click(await screen.findByRole('option', { name: 'solder side' }));
  await screen.findByText('solder side', { selector: 'p' });
  expect(artwork.artwork).toHaveBeenCalledWith('synthetic-body', 'solder-side');
  expect(decodeURIComponent(screen.getByRole('img', { name: '2D art of Synthetic connector' }).getAttribute('src')!)).toContain('synthetic-body/solder-side');
  expect(artwork.upload).not.toHaveBeenCalled();
  expect(artwork.saveAnchors).not.toHaveBeenCalled();
});

it('keeps a connector-specific manifest authoritative instead of merging missing body views', async () => {
  const artwork = artworkOf();
  artwork.detail = vi.fn(async (id) => ({ ok: true as const, value: id === 'synthetic-pinout' ? { ...bodyDetail, defId: id, views: bodyDetail.views.slice(0, 1) } : bodyDetail }));
  artwork.artwork = vi.fn(artwork.artwork);
  render(<ModelPanel kind="connectors" id="synthetic-pinout" label="Synthetic connector" models={modelsOf()} artwork={artwork} artworkFallbackIds={['synthetic-body']} />);
  await screen.findByRole('img', { name: '2D art of Synthetic connector' });
  expect(screen.getByText('Back: artwork missing')).toBeTruthy();
  expect(artwork.detail).toHaveBeenCalledTimes(1);
  expect(artwork.artwork).toHaveBeenCalledWith('synthetic-pinout', 'mating-face');
});

it('uses the body drawing alias only when neither connector nor body has a manifest', async () => {
  const artwork = artworkOf();
  artwork.detail = vi.fn(async (id) => ({ ok: true as const, value: id === 'synthetic-drawing' ? { ...bodyDetail, defId: id } : { ...detail, defId: id, exists: false, views: [] } }));
  artwork.artwork = vi.fn(artwork.artwork);
  render(<ModelPanel kind="connectors" id="synthetic-pinout" label="Synthetic connector" models={modelsOf()} artwork={artwork} artworkFallbackIds={['synthetic-body', 'synthetic-drawing']} />);
  await screen.findByRole('img', { name: '2D art of Synthetic connector' });
  expect(artwork.detail).toHaveBeenCalledTimes(3);
  expect(artwork.artwork).toHaveBeenCalledWith('synthetic-drawing', 'mating-face');
});

it('does not hide a failed connector artwork request behind its shared body', async () => {
  const artwork = artworkOf();
  artwork.detail = vi.fn(async () => ({ ok: false as const, message: 'Picture service unavailable' }));
  render(<ModelPanel kind="connectors" id="synthetic-pinout" label="Synthetic connector" models={modelsOf()} artwork={artwork} artworkFallbackIds={['synthetic-body']} />);
  expect((await screen.findByRole('alert')).textContent).toContain('Picture service unavailable');
  expect(artwork.detail).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Back: artwork missing')).toBeNull();
});
