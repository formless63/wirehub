/**
 * A save that would give two parts one number is refused (cs-5k1.3); an
 * existing number, and a free one, are not.
 */

import { describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type WorkbenchDeps } from '../server/api.ts';
import { memoryWriteBackend } from './storage-contract/writes.ts';

const send = (deps: WorkbenchDeps, method: string, path: string, body?: unknown, ifMatch?: string) =>
  handleWorkbenchRequest({ method, path, ...(body === undefined ? {} : { body }), ...(ifMatch === undefined ? {} : { headers: { 'if-match': ifMatch } }) }, deps);

describe('part-number guard', () => {
  it('refuses a definition save that takes another part\'s number, but not a rename or an unchanged number', async () => {
    const { deps } = memoryWriteBackend();
    const wire = await send(deps, 'GET', '/api/definitions/wires/' + ((await send(deps, 'GET', '/api/db')).body as { wires: { id: string; partNumber?: string }[] }).wires.find((w) => w.partNumber !== undefined)!.id);
    const record = wire.body as { id: string; partNumber: string; label: string };
    const component = ((await send(deps, 'GET', '/api/db')).body as { components: { id: string; partNumber?: string }[] }).components.find((c) => c.partNumber !== undefined)!;
    const cRead = await send(deps, 'GET', `/api/definitions/components/${component.id}`);
    const taken = await send(deps, 'PUT', `/api/definitions/components/${component.id}`, { ...(cRead.body as object), partNumber: record.partNumber.toLowerCase() }, cRead.headers!.ETag);
    expect(taken.status).toBe(422);
    expect(JSON.stringify(taken.body)).toContain('pn-duplicate');
    // untouched number, other edit: fine
    const fine = await send(deps, 'PUT', `/api/definitions/components/${component.id}`, { ...(cRead.body as object), label: 'Relabelled' }, cRead.headers!.ETag);
    expect(fine.status).toBe(200);
  });

  it('refuses a new definition that reuses a number', async () => {
    const { deps } = memoryWriteBackend();
    const db = (await send(deps, 'GET', '/api/db')).body as { components: { id: string; partNumber?: string }[] };
    const existing = db.components.find((c) => c.partNumber !== undefined)!;
    const source = (await send(deps, 'GET', `/api/definitions/components/${existing.id}`)).body as Record<string, unknown>;
    const copy = await send(deps, 'POST', '/api/definitions/components', { ...source, id: 'copy-of-it' });
    expect(copy.status).toBe(422);
    const free = await send(deps, 'POST', '/api/definitions/components', { ...source, id: 'copy-of-it', partNumber: 'CMP-09999' });
    expect(free.status).toBe(201);
  });

  it('refuses a drawing number or a product reference another design carries', async () => {
    const { deps } = memoryWriteBackend();
    const dwg = await send(deps, 'GET', '/api/drawings/dc-led-lead');
    const saved = await send(deps, 'PUT', '/api/drawings/dc-led-lead', { ...(dwg.body as { meta?: object }).meta, partNumber: 'CBL-04242', src: 'test' }, dwg.headers!.ETag);
    expect(saved.status).toBe(200);
    const other = await send(deps, 'GET', '/api/drawings/de9-crossover');
    const clash = await send(deps, 'PUT', '/api/drawings/de9-crossover', { partNumber: 'cbl-04242', src: 'test' }, other.headers!.ETag);
    expect(clash.status).toBe(422);
    // the same design repeating its own number is not a clash
    const again = await send(deps, 'GET', '/api/drawings/dc-led-lead');
    expect((await send(deps, 'PUT', '/api/drawings/dc-led-lead', { partNumber: 'CBL-04242', src: 'test2' }, again.headers!.ETag)).status).toBe(200);
    const design = await send(deps, 'GET', '/api/designs/de9-crossover');
    const byRef = await send(deps, 'PUT', '/api/designs/de9-crossover', { ...(design.body as object), productRef: 'CBL-04242' }, design.headers!.ETag);
    expect(byRef.status).toBe(422);
  });
});
