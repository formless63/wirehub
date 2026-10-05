// @vitest-environment jsdom
/**
 * The board-import module's page (`/m/board-import/boards`) in the SPA: the
 * KiCad board is read as a job, its plan (with the art previewed) published;
 * a BOM's columns are found and can be remapped before its import starts.
 * The transport is the real API router over the in-memory commit tree.
 */

import { join } from 'node:path';

import { BoardImportPage } from '@wirehub/module-board-import';
import { BOM_CSV, kicadPcb, ODD_BOM_CSV } from '@wirehub/module-board-import/test/synthetic.ts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { baseJobHandlers } from '../server/jobs/handlers.ts';
import { createJobService, inlineJobRunner, memoryJobStore } from '../server/jobs/service.ts';
import { boardImportRegistry } from './board-import-scenario.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const realFetch = globalThis.fetch;
let deps: WorkbenchDeps;
const bodies: unknown[] = [];

function serve(): void {
  deps = memoryWriteBackend(boardImportRegistry, join(DATA, '..')).deps;
  const store = memoryJobStore();
  deps.jobs = createJobService({ store, runner: inlineJobRunner(store, () => baseJobHandlers({ deps })), kinds: ['import'], pollMs: 20 });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (body !== undefined) bodies.push(body);
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), ...(body === undefined ? {} : { body }) }, deps);
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  bodies.length = 0;
  vi.restoreAllMocks();
});

const page = async (): Promise<void> => {
  const db = await deps.loadDb();
  render(createElement(BoardImportPage, { module: 'board-import', path: 'boards', db, api: async () => ({ status: 200, body: {} }) }));
};

describe('the board import page', () => {
  it('reads a KiCad board as a job, previews its art and publishes it', async () => {
    serve();
    await page();
    const input = screen.getByTestId('board-import-kicad-file');
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File([kicadPcb()], 'synthetic-adapter.kicad_pcb')] } });
    });
    fireEvent.change(screen.getByTestId('board-import-kicad-partNumber'), { target: { value: 'PCA-SYN-2' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('board-import-kicad-start'));
    });
    await waitFor(() => expect(screen.getByTestId('board-import-publish')).toBeTruthy(), { timeout: 5000 });
    const job = screen.getByTestId('board-import-job');
    expect(job.textContent).toContain('pcbas/synthetic-adapter-rev-2 — Synthetic adapter');
    expect(job.textContent).toContain('Board art for synthetic-adapter-rev-2');
    expect(job.querySelectorAll('img').length).toBe(2);
    expect((bodies[0] as { options: unknown }).options).toEqual({ partNumber: 'PCA-SYN-2' });
    await act(async () => {
      fireEvent.click(screen.getByTestId('board-import-publish'));
    });
    await waitFor(() => expect(job.textContent).toContain('Published.'));
    expect((await deps.loadDb()).pcbas.find((p) => p.id === 'synthetic-adapter-rev-2')?.partNumber).toBe('PCA-SYN-2');
    expect(screen.getByTestId('board-import-attach-model')).toBeTruthy();
  }, 20_000);

  it('finds a BOM’s columns, lets them be remapped, and sends the mapping with the files', async () => {
    serve();
    await page();
    await act(async () => {
      fireEvent.change(screen.getByTestId('board-import-bom-file'), { target: { files: [new File([BOM_CSV], 'bom.csv')] } });
    });
    const mapping = await screen.findByTestId('board-import-bom-mapping');
    expect((mapping.querySelector('select[data-field="refs"]') as HTMLSelectElement).value).toBe('Designator');
    expect((mapping.querySelector('select[data-field="supplierPart"]') as HTMLSelectElement).value).toBe('LCSC');
    // a BOM nobody's tool wrote: nothing found, the person maps it
    await act(async () => {
      fireEvent.change(screen.getByTestId('board-import-bom-file'), { target: { files: [new File([ODD_BOM_CSV], 'odd.csv')] } });
    });
    await waitFor(() => expect((screen.getByTestId('board-import-bom-mapping').querySelector('select[data-field="refs"]') as HTMLSelectElement).value).toBe(''));
    fireEvent.change(screen.getByTestId('board-import-bom-mapping').querySelector('select[data-field="refs"]')!, { target: { value: 'Where' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('board-import-bom-start'));
    });
    const sent = bodies.at(-1) as { fileName: string; options: { mapping: string } };
    expect(sent.fileName).toBe('odd.board-bom.json');
    expect(JSON.parse(sent.options.mapping)).toEqual({ bom: { refs: 'Where' } });
  });
});
