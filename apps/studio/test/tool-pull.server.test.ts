import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { dockerEngine, splitImageRef } from '../server/tools/docker-engine.ts';

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; } });
async function daemon(handle: (res: ServerResponse, url: string, auth?: string) => void) {
  server = createServer((req, res) => handle(res, req.url!, req.headers['x-registry-auth'] as string | undefined));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  return dockerEngine(`tcp://127.0.0.1:${address.port}`);
}
it('pulls a tagged reference and interprets progress, including errors in a successful HTTP response', async () => {
  let fail = false;
  const engine = await daemon((res, url, auth) => {
    expect(url).toBe('/images/create?fromImage=registry.example%3A5000%2Fteam%2Ftool&tag=1.2');
    expect(JSON.parse(Buffer.from(auth!, 'base64url').toString())).toMatchObject({ username: 'reader', serveraddress: 'registry.example:5000' });
    res.writeHead(200); res.write('{"status":"Downloading"}\n');
    res.end(fail ? '{"error":"permission denied"}\n' : '{"status":"Downloaded"}\n');
  });
  const auth = { username: 'reader', password: 'synthetic', serveraddress: 'registry.example:5000' };
  await engine.pull!('registry.example:5000/team/tool:1.2', auth);
  fail = true;
  await expect(engine.pull!('registry.example:5000/team/tool:1.2', auth)).rejects.toThrow('permission denied');
  expect(splitImageRef('registry.example:5000/team/tool@sha256:abc')).toEqual({ fromImage: 'registry.example:5000/team/tool@sha256:abc' });
});
it('cancels a stalled first download', async () => {
  const controller = new AbortController();
  const engine = await daemon((res) => { res.writeHead(200); res.write('{"status":"Waiting"}\n'); controller.abort(); });
  await expect(engine.pull!('registry.example/tool:1', undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
});
