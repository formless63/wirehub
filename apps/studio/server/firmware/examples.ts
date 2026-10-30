/**
 * The synthetic examples a firmware tool pack ships (`tools/<pack>/examples/<name>/`), offered as a
 * project's starting source. A PlatformIO example's own `platformio.ini` is kept only when it has an
 * environment for the project's target; otherwise the sketch goes alone and the pack writes the
 * project file for the chosen target, as it does for any bare sketch.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FirmwareExample {
  id: string;
  files: { path: string; base64: string }[];
}

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '../../../../tools');
const MAX_FILES = 20;
const MAX_BYTES = 64 * 1024;

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (out.length < MAX_FILES && statSync(full).size <= MAX_BYTES) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const cache = new Map<string, FirmwareExample[]>();

export function firmwareExamples(pack: string, target: string): FirmwareExample[] {
  if (!/^firmware-[a-z0-9-]+$/.test(pack)) return [];
  const key = `${pack}:${target}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const root = join(TOOLS, pack, 'examples');
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n) && statSync(join(root, n)).isDirectory()).sort();
  } catch {
    names = [];
  }
  const out = names.map((id): FirmwareExample => {
    const dir = join(root, id);
    const files = filesUnder(dir).flatMap((full) => {
      const path = relative(dir, full).split('\\').join('/');
      const bytes = readFileSync(full);
      if (path === 'platformio.ini' && !bytes.toString('utf8').includes(`[env:${target}]`)) return [];
      return [{ path, base64: bytes.toString('base64') }];
    });
    return { id, files };
  }).filter((e) => e.files.length > 0);
  cache.set(key, out);
  return out;
}
