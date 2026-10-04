// @vitest-environment jsdom
/**
 * The shared asset picker, end to end: the picker
 * component on its own, then wired into the drawing sheet's photo field —
 * picking one calls the same `onPhoto` a fresh upload would, so the sidecar
 * hook's existing draft/dirty/save plumbing needs no changes to support it.
 */

import type { CableDesign, Db } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetsAdapter, SharedAsset } from '../src/assets.ts';
import { AssetPicker } from '../src/panels/AssetPicker.tsx';
import { DocumentsPane } from '../src/panels/Documents.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

afterEach(cleanup);

const SCART: SharedAsset = {
  id: 'sha-scart',
  mime: 'image/jpeg',
  originalName: 'scart-connector.jpg',
  src: 'Photographed on the bench.',
  bytes: 2048,
  dataUri: 'data:image/jpeg;base64,c2NhcnQ=',
};
const HDMI: SharedAsset = {
  id: 'sha-hdmi',
  mime: 'image/png',
  originalName: 'hdmi-cable.png',
  src: 'Vendor product page.',
  bytes: 4096,
  dataUri: 'data:image/png;base64,aGRtaQ==',
};

function stubAssets(assets: SharedAsset[]): AssetsAdapter & { noted: string[] } {
  const noted: string[] = [];
  return {
    noted,
    list: async () => ({ ok: true, value: assets }),
    recentIds: () => [],
    noteUsed: (id) => noted.push(id),
  };
}

describe('<AssetPicker>', () => {
  it('lists every asset, filters by search, and picking one calls onPick and noteUsed', async () => {
    const adapter = stubAssets([SCART, HDMI]);
    const onPick = vi.fn();
    render(<AssetPicker assets={adapter} onPick={onPick} onClose={() => {}} />);

    expect(await screen.findByText('scart-connector.jpg')).toBeTruthy();
    expect(screen.getByText('hdmi-cable.png')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search assets'), { target: { value: 'hdmi' } });
    expect(screen.queryByText('scart-connector.jpg')).toBeNull();
    expect(screen.getByText('hdmi-cable.png')).toBeTruthy();

    fireEvent.click(screen.getByTitle(`${HDMI.originalName} — ${HDMI.src}`));
    expect(onPick).toHaveBeenCalledWith(HDMI);
    expect(adapter.noted).toEqual([HDMI.id]);
  });

  it('says so in plain words when the list comes back empty', async () => {
    const adapter = stubAssets([]);
    render(<AssetPicker assets={adapter} onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('Nothing has been uploaded yet.')).toBeTruthy();
  });

  it('reports the adapter’s own failure instead of an empty list', async () => {
    const adapter: AssetsAdapter = { list: async () => ({ ok: false, message: 'The workbench could not be reached.' }) };
    render(<AssetPicker assets={adapter} onPick={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('The workbench could not be reached.')).toBeTruthy();
  });

  it('Cancel closes without picking anything', async () => {
    const adapter = stubAssets([SCART]);
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<AssetPicker assets={adapter} onPick={onPick} onClose={onClose} />);
    await screen.findByText('scart-connector.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('the drawing sheet photo field, with a shared asset library', () => {
  const db: Db = loadDbFromDisk();
  const design: CableDesign = loadDesignFromDisk('de9-terminal-board');

  it('offers "Choose from library…", and picking an asset drives the same preview an upload would', async () => {
    const adapter = stubAssets([SCART]);
    const drawings = {
      load: async () => ({ ok: true as const, value: { meta: {} } }),
      save: async (id: string, meta: unknown) => ({ ok: true as const, value: meta as never }),
      savePhoto: async () => ({ ok: true as const, value: {} }),
    };

    render(<DocumentsPane design={design} db={db} saved={design} drawings={drawings} assets={adapter} />);

    fireEvent.click(screen.getByRole('button', { name: 'Drawing sheet' }));
    await screen.findByText('Title block, lengths & photo');

    fireEvent.click(screen.getByRole('button', { name: 'Choose from library…' }));
    await screen.findByText('scart-connector.jpg');

    fireEvent.click(screen.getByTitle(`${SCART.originalName} — ${SCART.src}`));

    // the picker closes, the field now shows a photo is set, and Save is
    // live — exactly what a fresh upload would have done via `onPhoto`
    await waitFor(() => expect(screen.queryByLabelText('Search assets')).toBeNull());
    expect(await screen.findByText('A photo is on the sheet.')).toBeTruthy();
    expect(screen.getByText('unsaved')).toBeTruthy();
  });

  it('has no "Choose from library…" button without an assets adapter', async () => {
    const drawings = {
      load: async () => ({ ok: true as const, value: { meta: {} } }),
      save: async (id: string, meta: unknown) => ({ ok: true as const, value: meta as never }),
      savePhoto: async () => ({ ok: true as const, value: {} }),
    };
    render(<DocumentsPane design={design} db={db} saved={design} drawings={drawings} />);
    fireEvent.click(screen.getByRole('button', { name: 'Drawing sheet' }));
    await screen.findByText('Title block, lengths & photo');
    expect(screen.queryByRole('button', { name: 'Choose from library…' })).toBeNull();
  });
});
