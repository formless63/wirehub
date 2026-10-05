/**
 * The life of an uploaded or store-installed pack's SVG face, one flow for both backends
 * (`pack-bundle-assets.server.test.ts`, `pg/pack-bundle-assets.server.test.ts`): install, the
 * face served by content address from `/api/blobs`, an update with a changed SVG, a disable
 * that removes the file.
 */

import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { expect } from 'vitest';

export const FACE_SRC = 'synthetic example: bundled face';
export const svgFace = (mark: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" onload="alert(1)"><script>alert('${mark}')</script><title>${mark}</title><rect width="4" height="4" fill="none" stroke="#000"/><a href="https://evil.example/x"><circle r="1"/></a></svg>\n`;

/** A stored zip of name → bytes (a folder prefix is the caller's). */
export function zipFiles(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc32(data), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

/** The files of a pack `id` at `version` with `face` as `depictions/<id>-face/mating-face.svg`. */
export function packWithFace(id: string, version: string, face: string): Record<string, string> {
  const j = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
  return {
    'wirehub-pack.json': j({ format: 1, id, name: `Face ${id}`, version, license: 'CC-BY-4.0' }),
    'components.json': j([{ id: `${id}-r`, label: '10 resistor', kind: 'resistor', value: '10', terminals: [{ id: 'a' }, { id: 'b' }], src: FACE_SRC }]),
    [`depictions/${id}-face/meta.json`]: j({ defId: `${id}-face`, views: { 'mating-face': { file: 'mating-face.svg', kind: 'vector', mmPerUnit: 1, sourceKind: 'hand', widthUnits: 4, heightUnits: 4, src: FACE_SRC } }, src: FACE_SRC, license: 'CC-BY-4.0' }),
    [`depictions/${id}-face/mating-face.svg`]: face,
  };
}

export interface FlowHooks {
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; bytes?: Uint8Array }>;
  /** make version `version` with `face` installable: the request that installs it (without `apply`) */
  source: (version: string, face: string) => Promise<{ path: string; body: object }>;
  /** the pack's id and the def its face belongs to */
  id: string;
  /** the face file as the backend holds it now */
  readFace: (defId: string) => Promise<Uint8Array | undefined>;
  /** the sha256s of blobs of faces that no longer belong to anything must not be served */
  strictRemoval?: boolean;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const text = (bytes: Uint8Array | undefined): string => (bytes === undefined ? '' : new TextDecoder().decode(bytes));

export async function runFaceFlow(h: FlowHooks): Promise<void> {
  const def = `${h.id}-face`;
  const install = async (version: string, mark: string) => {
    const { path, body } = await h.source(version, svgFace(mark));
    const preview = await h.call('POST', path, body);
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.verified ?? true).toBe(true);
    const done = await h.call('POST', path, { ...body, apply: true });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.installed).toBe(true);
  };
  const served = async (bytes: Uint8Array) => h.call('GET', `/api/blobs/${sha(bytes)}`);

  // install: the face arrives, sanitised, and is served by its content address
  await install('1.0.0', 'v1');
  const first = await h.readFace(def);
  expect(text(first)).toContain('v1');
  expect(text(first)).not.toMatch(/script|onload|evil\.example/);
  const blob1 = await served(first as Uint8Array);
  expect(blob1.status, JSON.stringify(blob1.body)).toBe(200);
  expect(blob1.bytes && text(blob1.bytes)).toBe(text(first));

  // update with a changed SVG: replaced (the pack owns it), the new bytes are served
  await install('1.1.0', 'v2');
  const second = await h.readFace(def);
  expect(text(second)).toContain('v2');
  expect(text(second)).not.toContain('v1');
  expect((await served(second as Uint8Array)).status).toBe(200);
  if (h.strictRemoval) expect((await served(first as Uint8Array)).status).toBe(404);

  // disable: the file is removed
  const gone = await h.call('DELETE', `/api/packs/${h.id}`);
  expect(gone.status, JSON.stringify(gone.body)).toBe(200);
  expect(await h.readFace(def)).toBeUndefined();
  expect((await served(second as Uint8Array)).status).toBe(404);
}
