import { afterEach, expect, it, vi } from 'vitest';
import { startCompile } from '../src/firmware.browser.ts';
afterEach(() => vi.unstubAllGlobals());
it('keeps compilation offline unless the user opts in, including board placements', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
  await startCompile('example');
  await startCompile('example', { design: 'demo', instance: 'u1' }, true);
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({});
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual({ occurrence: { design: 'demo', instance: 'u1' }, network: true });
});
