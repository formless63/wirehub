// @vitest-environment jsdom
import { join } from 'node:path';
import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory } from '@tanstack/react-router';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRegistry } from '@wirehub/modules';
import { afterEach, expect, it, vi } from 'vitest';
import { handleWorkbenchRequest } from '../server/api.ts';
import { App } from '../src/App.tsx';
import { createStudioRouter } from '../src/router.tsx';
import { representationFixture } from './representation-fixture.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('uses one persisted native cover in the real library row and record header, including after navigation/reload', async () => {
  window.localStorage.clear();
  const modules = createRegistry([]);
  const { deps } = memoryWriteBackend(modules, join(process.cwd(), '../../packages/catalog'));
  const { board, depiction } = await representationFixture(await deps.loadDb());
  await deps.definitions!.write('pcbas', [board]);
  await deps.depictions!.writeMeta(board.id, depiction.meta);
  for (const [file, content] of Object.entries(depiction.files)) await deps.depictions!.writeAsset(board.id, file, content);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const response = await handleWorkbenchRequest({ method: init?.method ?? 'GET', path: String(input), headers,
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}) }, deps);
    return new Response(response.bytes === undefined ? JSON.stringify(response.body) : response.bytes as BodyInit, {
      status: response.status, headers: { 'content-type': response.contentType ?? 'application/json', ...(response.headers ?? {}) },
    });
  }));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const mount = () => render(<App modules={modules} queryClient={client} router={createStudioRouter(createMemoryHistory({ initialEntries: [`/library/boards/${board.id}`] }))} />);
  mount();
  const cover = await screen.findByRole('region', { name: 'Record cover' });
  expect(cover.getAttribute('title')).toBe('Shared cover · lists and record'); // the caption is the region's tooltip
  const chooser = await within(cover).findByRole('combobox', { name: 'Choose preview' });
  fireEvent.click(chooser);
  fireEvent.click(await screen.findByRole('option', { name: 'Board bottom' }));
  fireEvent.click(within(cover).getByRole('button', { name: 'Use as cover' }));
  expect(await within(cover).findByText('Cover saved.')).toBeTruthy();
  await waitFor(() => expect(screen.getAllByAltText(`${board.label} — Board bottom`)).toHaveLength(2));
  const sources = screen.getAllByAltText(`${board.label} — Board bottom`).map((el) => el.getAttribute('src'));
  expect(new Set(sources).size).toBe(1);
  cleanup();
  client.clear();
  mount();
  await waitFor(() => expect(screen.getAllByAltText(`${board.label} — Board bottom`)).toHaveLength(2));
  const fresh = screen.getByRole('region', { name: 'Record cover' });
  fireEvent.click(within(fresh).getByRole('button', { name: 'Automatic cover' }));
  await waitFor(() => expect(screen.getAllByAltText(`${board.label} — Board top`)).toHaveLength(2));
});
