// @vitest-environment jsdom
/**
 * The Library's Views panel and 3D viewer, mounted.
 * jsdom has no WebGL, so the viewer must mount its canvas and say in words
 * why nothing is drawn — never throw. The panel's attach and detach go
 * through the adapter, and are disabled while someone else holds the lock.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelLinkView, ModelsAdapter } from '../src/models.ts';
import { EditSessionContext } from '../src/panels/edit-session.ts';
import { ModelPanel } from '../src/panels/ModelPanel.tsx';
import ModelViewer3d from '../src/panels/ModelViewer3d.tsx';
import { modelPreviewNote } from '../src/model-preview.ts';

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const GLB = (() => {
  const buffer = readFileSync(join(here, 'fixtures/tetra.glb'));
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
})();

const LINK: ModelLinkView = {
  record: 'mechanicals/shell-hd15-coax',
  asset: 'a'.repeat(64),
  sourceKind: 'resin-print',
  src: 'alex-resin/SHL-00103 …/Rev1/… — Revision 1',
  revision: 'Rev1',
};

function adapter(initial: ModelLinkView | null): ModelsAdapter & { calls: string[] } {
  let link = initial;
  const calls: string[] = [];
  return {
    calls,
    get: async () => ({ ok: true, value: link }),
    list: async () => ({ ok: true, value: { links: link === null ? [] : [link], models: [{ id: LINK.asset, mime: 'model/gltf-binary', originalName: 'SHL-00103-00 Rev1.glb', src: 'x', bytes: 1234 }] } }),
    attach: async (kind, id, asset) => {
      calls.push(`attach ${kind}/${id} ${asset}`);
      link = { ...LINK, record: `${kind}/${id}`, asset };
      return { ok: true, value: link };
    },
    upload: async () => ({ ok: false, message: 'not in this test' }),
    detach: async (kind, id) => {
      calls.push(`detach ${kind}/${id}`);
      link = null;
      return { ok: true, value: null };
    },
    fetchModel: async () => ({ ok: true, value: { bytes: GLB, mime: 'model/gltf-binary' } }),
  };
}

describe('ModelViewer3d', () => {
  it('mounts its canvas and, without WebGL, says why instead of drawing', async () => {
    // jsdom logs "not implemented" for getContext; that is the point here
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<ModelViewer3d bytes={GLB} mime="model/gltf-binary" label="HD15 shell" />);
    expect(container.querySelector('canvas.cs-model-canvas')).not.toBeNull();
    expect(screen.getByRole('img', { name: /3D model of HD15 shell/ })).toBeTruthy();
    expect(await screen.findByText(/WebGL is unavailable/)).toBeTruthy();
    quiet.mockRestore();
  });
});

function annotatedGlb(extras: Record<string, unknown>): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0', extras } }));
  const padded = Math.ceil(json.length / 4) * 4;
  const bytes = new ArrayBuffer(20 + padded);
  const view = new DataView(bytes);
  [0x46546c67, 2, bytes.byteLength, padded, 0x4e4f534a].forEach((value, i) => view.setUint32(i * 4, value, true));
  new Uint8Array(bytes, 20).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  return bytes;
}

it('ignores malformed GLB metadata without turning source hints into a loading error', () => {
  const bytes = annotatedGlb({ source: 'kicad-assembly', instances: 0 });
  expect(modelPreviewNote(bytes.slice(0, 16), 'model/gltf-binary')).toBeUndefined();
  expect(modelPreviewNote(bytes, 'model/stl')).toBeUndefined();
  const oversizedChunk = bytes.slice(0);
  new DataView(oversizedChunk).setUint32(12, bytes.byteLength, true);
  expect(modelPreviewNote(oversizedChunk, 'model/gltf-binary')).toBeUndefined();
  const brokenJson = bytes.slice(0);
  new Uint8Array(brokenJson)[20] = 0;
  expect(modelPreviewNote(brokenJson, 'model/gltf-binary')).toBeUndefined();
});

it('explains an explicitly board-only assembly and clears that context when the model changes', () => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { rerender } = render(<ModelViewer3d bytes={annotatedGlb({ source: 'kicad-assembly', instances: 0 })} mime="model/gltf-binary" label="Synthetic board" />);
  expect(screen.getByRole('note').textContent).toBe('This preview contains board geometry only; no footprint models were included.');
  rerender(<ModelViewer3d bytes={GLB} mime="model/gltf-binary" label="Synthetic solid" />);
  expect(screen.queryByRole('note')).toBeNull();
  quiet.mockRestore();
});

it.each([
  { source: 'step', instances: 0 },
  { source: 'kicad-assembly', instances: 1 },
  { source: 'kicad-assembly', instances: '0' },
  { instances: 0 },
])('does not infer assembly coverage from unrelated or ambiguous metadata %j', (extras) => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<ModelViewer3d bytes={annotatedGlb(extras)} mime="model/gltf-binary" label="Synthetic model" />);
  expect(screen.queryByRole('note')).toBeNull();
  quiet.mockRestore();
});

it.each([0, 3])('reports unread footprint models without claiming coverage at %s instances', (instances) => {
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(<ModelViewer3d bytes={annotatedGlb({ source: 'kicad-assembly', instances, unreadModels: 'synthetic.step' })} mime="model/gltf-binary" label="Synthetic incomplete board" />);
  expect(screen.getByRole('note').textContent).toBe('Some footprint models could not be read; this preview is incomplete.');
  expect(screen.queryByText(/no footprint models were included/)).toBeNull();
  quiet.mockRestore();
});

describe('ModelPanel', () => {
  it('shows a linked model in 3D with its source, and detaches it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const models = adapter(LINK);
    render(<ModelPanel kind="mechanicals" id="shell-hd15-coax" label="HD15 shell" models={models} />);
    expect(await screen.findByText('Resin print · Rev1')).toBeTruthy();
    expect(screen.getByRole('button', { name: '3D' }).getAttribute('aria-pressed')).toBe('true');
    // the lazy viewer chunk arrives, and falls back in jsdom
    expect(await screen.findByText(/WebGL is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Detach' }));
    await waitFor(() => expect(models.calls).toEqual(['detach mechanicals/shell-hd15-coax']));
    expect(await screen.findByText('No 3D model')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it('attaches an imported model picked from the list', async () => {
    const models = adapter(null);
    const onDirtyChange = vi.fn();
    render(
      <EditSessionContext.Provider value={{ locked: false, onDirtyChange }}>
        <ModelPanel kind="pcbas" id="PCA-00109-rev3" label="Perfboard" models={models} />
      </EditSessionContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Attach model' }));
    // opening the form starts an edit: the host's lock scope takes the lease
    expect(onDirtyChange).toHaveBeenCalledWith(true);
    const list = await screen.findByRole('listbox', { name: 'imported model' });
    await screen.findByText(/SHL-00103-00 Rev1\.glb/);
    fireEvent.change(list, { target: { value: LINK.asset } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await waitFor(() => expect(models.calls).toEqual([`attach pcbas/PCA-00109-rev3 ${LINK.asset}`]));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('says an imported model is not built yet, in words, instead of drawing', async () => {
    const models = adapter({ ...LINK, built: false });
    models.fetchModel = async () => ({ ok: false, message: 'This 3D model has not been built on this studio yet.', hint: 'Run the model-cache job.', status: 404 });
    render(<ModelPanel kind="mechanicals" id="shell-hd15-coax" label="HD15 shell" models={models} />);
    expect(await screen.findByText('Resin print · Rev1 · not built yet')).toBeTruthy();
    expect(await screen.findByText(/not been built on this studio yet\. Run the model-cache job\./)).toBeTruthy();
  });

  it("is read-only while someone else holds the record's lock", async () => {
    render(
      <EditSessionContext.Provider value={{ locked: true }}>
        <ModelPanel kind="mechanicals" id="shell-hd15-coax" label="HD15 shell" models={adapter(LINK)} />
      </EditSessionContext.Provider>,
    );
    const detach = await screen.findByRole('button', { name: 'Detach' });
    expect((detach as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Replace model' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
