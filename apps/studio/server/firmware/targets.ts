/**
 * Firmware targets, as the tool packs declare them: each pack keeps its own `pack.json`
 * (`tools/firmware-platformio/families/*`, `tools/firmware-esphome/`) and the image is built from
 * the same file, so the target list in the UI cannot drift from what an image can compile.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FirmwareTarget } from '../../src/firmware.ts';

interface PackDeclaration {
  pack: string;
  packVersion: string;
  targets: { id: string; label: string; platform: string; framework: string }[];
}

// read on first use rather than JSON-imported: the files live outside apps/studio, and import
// attributes (or vite's `new URL(…, import.meta.url)` rewriting) break the vite/vitest bundling
const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '../../../../tools');
const PACK_DIRS = ['firmware-platformio/families/classic', 'firmware-platformio/families/esp32', 'firmware-platformio/families/rp2040', 'firmware-esphome'];
let declarations: PackDeclaration[] | undefined;

export const firmwarePackDeclarations = (): PackDeclaration[] =>
  (declarations ??= PACK_DIRS.map((rel) => JSON.parse(readFileSync(join(TOOLS, rel, 'pack.json'), 'utf8')) as PackDeclaration));

/** Pack name to image version, for the runner's registry. */
export const firmwarePackVersions = (): Record<string, string> => Object.fromEntries(firmwarePackDeclarations().map((p) => [p.pack, p.packVersion]));

export const firmwareTargets = (): FirmwareTarget[] =>
  firmwarePackDeclarations().flatMap((p) => p.targets.map((t) => ({ id: t.id, label: t.label, platform: t.platform, framework: t.framework, pack: p.pack })));

/** The pack whose image compiles a target (the first pack for an unknown target, so the job reports it). */
export const packOfTarget = (target: string): string => firmwareTargets().find((t) => t.id === target)?.pack ?? 'firmware-platformio';
