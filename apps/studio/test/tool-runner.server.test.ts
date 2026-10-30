/** The tool runner's trust boundary, with a fake Docker engine: network opt-in, and output verification. */

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { CreateSpec, DockerEngine } from '../server/tools/docker-engine.ts';
import { dockerToolRunner, toolRegistryAuth, ToolRunError, type ToolManifest } from '../server/tools/runner.ts';
import { TOOL_PACKS } from '../server/tools/packs.ts';
import { sweepOrphanedToolContainers } from '../server/tools/sweep.ts';

const root = mkdtempSync(join(tmpdir(), 'wh-runner-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sha = (b: string): string => createHash('sha256').update(b).digest('hex');

/** An engine whose "container" writes `files` (and a manifest built by `manifest`) into the out mount. */
function fakeEngine(pack: string, op: string, files: Record<string, string>, manifest: (inputs: { path: string; sha256: string }[]) => Partial<ToolManifest>) {
  const created: CreateSpec[] = [];
  let spec: CreateSpec | undefined;
  const engine: DockerEngine = {
    describe: 'fake',
    imageId: async () => 'sha256:fake',
    create: async (s) => { created.push(s); spec = s; return 'c1'; },
    start: async () => {
      const out = spec!.mounts.find((m) => m.target === '/work/out')!.source;
      const request = JSON.parse(readFileSync(join(spec!.mounts.find((m) => m.target === '/work/in')!.source, 'request.json'), 'utf8')) as { inputs: { path: string; sha256: string }[] };
      for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(out, path)), { recursive: true }); writeFileSync(join(out, path), text); }
      writeFileSync(join(out, 'manifest.json'), JSON.stringify({ pack, packVersion: '1', tool: { name: 't', version: '1' }, op, inputs: request.inputs, outputs: [], findings: [], status: 'ok', ...manifest(request.inputs) }));
    },
    wait: async () => 0, logs: async () => '', kill: async () => undefined, remove: async () => undefined,
  };
  return { engine, created };
}

const out = (path: string, text: string) => ({ path, sha256: sha(text), role: 'result', mediaType: 'text/plain' });
const run = (engine: DockerEngine, request: { pack: string; op: string; network?: boolean }) =>
  dockerToolRunner({ engine, workDir: root, env: {} }).run({ ...request, params: {}, inputs: [{ path: 'a.txt', bytes: new TextEncoder().encode('in') }] });

describe('tool runner', () => {
  it('gives a container a network only when the op opts in and the request asks', async () => {
    const compile = fakeEngine('firmware-platformio', 'compile', {}, () => ({}));
    await run(compile.engine, { pack: 'firmware-platformio', op: 'compile' });
    await run(compile.engine, { pack: 'firmware-platformio', op: 'compile', network: true });
    expect(compile.created.map((c) => c.network === true)).toEqual([false, true]);
    const fab = fakeEngine('kicad', 'fab', {}, () => ({}));
    await expect(run(fab.engine, { pack: 'kicad', op: 'fab', network: true })).rejects.toBeInstanceOf(ToolRunError);
    expect(fab.created).toHaveLength(0);
  });

  it('accepts honest outputs and refuses escapes, bad hashes and an unconfirmed input', async () => {
    const ok = fakeEngine('kicad', 'fab', { 'r.txt': 'hello' }, (i) => ({ inputs: i, outputs: [out('r.txt', 'hello')] }));
    expect((await run(ok.engine, { pack: 'kicad', op: 'fab' })).read('r.txt')).toEqual(new TextEncoder().encode('hello'));

    const cases: [string, Record<string, string>, (i: { path: string; sha256: string }[]) => Partial<ToolManifest>, string][] = [
      ['parent path', { 'r.txt': 'x' }, (i) => ({ inputs: i, outputs: [out('../r.txt', 'x')] }), 'manifest'],
      ['absolute path', { 'r.txt': 'x' }, (i) => ({ inputs: i, outputs: [out('/etc/passwd', 'x')] }), 'manifest'],
      ['sha mismatch', { 'r.txt': 'x' }, (i) => ({ inputs: i, outputs: [{ ...out('r.txt', 'x'), sha256: sha('y') }] }), 'hash-mismatch'],
      ['unconfirmed input', { 'r.txt': 'x' }, () => ({ inputs: [], outputs: [out('r.txt', 'x')] }), 'manifest'],
    ];
    for (const [name, files, manifest, code] of cases) {
      const e = fakeEngine('kicad', 'fab', files, manifest);
      await expect(run(e.engine, { pack: 'kicad', op: 'fab' }), name).rejects.toMatchObject({ code });
    }
  });

  it('pulls a missing pack image from WIREHUB_TOOL_REGISTRY once, and keeps a pinned run to its image id', async () => {
    const env = { WIREHUB_TOOL_REGISTRY: 'reg.example/owner/', WIREHUB_TOOL_REGISTRY_USER: 'u', WIREHUB_TOOL_REGISTRY_TOKEN: 't' };
    const e = fakeEngine('kicad', 'fab', {}, (i) => ({ inputs: i }));
    const present = new Set<string>();
    const pulls: { ref: string; server?: string }[] = [];
    e.engine.imageId = async (ref) => (present.has(ref) ? 'sha256:'.padEnd(71, 'a') : undefined);
    e.engine.pull = async (ref, auth) => { pulls.push({ ref, server: auth?.serveraddress }); present.add(ref); };
    const runner = dockerToolRunner({ engine: e.engine, workDir: root, env });
    const input = { params: {}, inputs: [{ path: 'a.txt', bytes: new TextEncoder().encode('in') }] };
    await runner.run({ pack: 'kicad', op: 'fab', ...input });
    await runner.run({ pack: 'kicad', op: 'fab', ...input });
    const ref = `reg.example/owner/wirehub-tool-kicad:${TOOL_PACKS.kicad!.version}`;
    expect(pulls).toEqual([{ ref, server: 'reg.example' }]);
    expect(e.created[0]?.image).toBe('sha256:'.padEnd(71, 'a'));
    // a recorded run whose exact image the pull does not bring back still fails as image-missing
    await expect(runner.run({ pack: 'kicad', op: 'fab', imageId: 'sha256:'.padEnd(71, 'b'), ...input })).rejects.toMatchObject({ code: 'image-missing' });
  });
  it('keeps registry credentials on their configured host', () => {
    const env = { WIREHUB_TOOL_REGISTRY: 'registry.example/team', WIREHUB_TOOL_REGISTRY_USER: 'reader', WIREHUB_TOOL_REGISTRY_TOKEN: 'secret' };
    expect(toolRegistryAuth(env, 'registry.example/team/tool:1')?.serveraddress).toBe('registry.example');
    expect(toolRegistryAuth(env, 'another.example/tool:1')).toBeUndefined();
  });

  it('does not start a tool after cancellation during its first download', async () => {
    const e = fakeEngine('kicad', 'fab', {}, (inputs) => ({ inputs }));
    const controller = new AbortController();
    e.engine.imageId = async () => undefined;
    e.engine.pull = async (_ref, _auth, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new Error('download aborted');
    };
    const runner = dockerToolRunner({ engine: e.engine, workDir: root, env: { WIREHUB_TOOL_REGISTRY: 'registry.example/tools' } });
    await expect(runner.run({ pack: 'kicad', op: 'fab', inputs: [], signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(e.created).toHaveLength(0);
  });

  it('reports a registry failure without starting a tool', async () => {
    const e = fakeEngine('kicad', 'fab', {}, (inputs) => ({ inputs }));
    e.engine.imageId = async () => undefined;
    e.engine.pull = async () => { throw new Error('access denied'); };
    const runner = dockerToolRunner({ engine: e.engine, workDir: root, env: { WIREHUB_TOOL_REGISTRY: 'registry.example/tools' } });
    await expect(runner.run({ pack: 'kicad', op: 'fab', inputs: [] })).rejects.toMatchObject({ code: 'image-missing', message: expect.stringContaining('access denied') });
    expect(e.created).toHaveLength(0);
  });

});

describe('orphaned tool container sweep', () => {
  it("removes only its own stack's containers of jobs that stopped running", async () => {
    const own = { 'org.wirehub.tool-owner': 'volume:a-work', 'org.wirehub.tool-pack': 'kicad' };
    const containers = [
      { id: 'interrupted', state: 'running', labels: { ...own, 'org.wirehub.job': 'j1' } },
      { id: 'live', state: 'running', labels: { ...own, 'org.wirehub.job': 'j2' } },
      { id: 'unknown-job', state: 'exited', labels: { ...own, 'org.wirehub.job': 'j9' } },
      { id: 'no-job-stopped', state: 'exited', labels: own },
      { id: 'no-job-running', state: 'running', labels: own },
      { id: 'other-stack', state: 'exited', labels: { ...own, 'org.wirehub.tool-owner': 'volume:b-work', 'org.wirehub.job': 'j1' } },
      { id: 'not-a-pack', state: 'exited', labels: { 'org.wirehub.tool-owner': 'volume:a-work' } },
    ];
    const removed: string[] = [];
    // an engine that ignores the label filter: the sweep must still check the owner itself
    const engine = { list: async () => containers, remove: async (id: string) => void removed.push(id) } as unknown as DockerEngine;
    const statuses: Record<string, string> = { j1: 'interrupted', j2: 'running' };
    const out = await sweepOrphanedToolContainers({ env: { WIREHUB_TOOL_RUNNER: 'docker', WIREHUB_TOOL_WORK_VOLUME: 'a-work' }, engine, jobStatus: async (id) => statuses[id] });
    expect(out).toEqual(['interrupted', 'no-job-stopped']);
    expect(removed).toEqual(out);
  });
});
