/**
 * A saved design version's device in its package: the enclosure generations the
 * version pinned (`file.device`) and the device export made from that version. A
 * newer generation or a working-copy export is never substituted: what is not there is listed
 * under `missing` with the reason.
 */

import { createHash } from 'node:crypto';

import type { DesignVersionFile } from '@wirehub/model';

import type { ToolRunRecord } from '../tools/outputs.ts';
import type { PackageFile, PackageMissing } from './package.ts';

const hex = (sha: string): string => sha.replace(/^sha256:/, '');
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface DeviceAsSaved {
  /** the pinned shells' outputs and their generation records */
  files: PackageFile[];
  /** the device export made from this version (the newest ok one), when one is kept */
  export?: ToolRunRecord;
  missing: PackageMissing[];
}

/**
 * What a version's package carries of its device. `readAsset` returns an asset's bytes (the pinned
 * shell outputs are assets); `deviceRuns` are the design's device-export runs, newest first.
 */
export async function deviceAsSaved(
  file: DesignVersionFile,
  readAsset: (id: string) => Promise<Uint8Array | undefined>,
  deviceRuns: readonly ToolRunRecord[],
): Promise<DeviceAsSaved> {
  const files: PackageFile[] = [];
  const missing: PackageMissing[] = [];
  const shells = [...new Set((file.design.instances.mechanical ?? []).map((m) => m.def))]
    .filter((id) => file.definitions.mechanicals.some((d) => d.id === id && d.enclosure !== undefined))
    .sort();
  for (const shell of shells) {
    const pin = file.device?.enclosures[shell];
    if (pin === undefined) {
      missing.push({ what: `mechanicals/${shell} enclosure-generate`, why: `Rev ${file.rev} kept no generation of this enclosure (none was ok when it was saved); newer generations are not used` });
      continue;
    }
    files.push({ path: `record/enclosures/${shell}.json`, bytes: new TextEncoder().encode(`${JSON.stringify({ enclosure: shell, ...pin }, null, 2)}\n`), kind: 'record', mediaType: 'application/json' });
    for (const o of pin.outputs) {
      if (o.asset === undefined) continue;
      const bytes = await readAsset(o.asset);
      if (bytes === undefined || sha256(bytes) !== hex(o.sha256)) {
        missing.push({ what: `mechanicals/${shell} enclosure-generate output ${o.path}`, sha256: hex(o.sha256), why: bytes === undefined ? 'not stored any more' : 'the stored bytes do not match their hash' });
        continue;
      }
      files.push({ path: `outputs/enclosure-${shell}/${o.path}`, bytes, kind: 'output', role: o.role, mediaType: o.mediaType });
    }
  }
  const exported = deviceRuns.find((r) => r.status === 'ok' && r.op === 'device-assemble' && (r.params as { design?: { rev?: number } }).design?.rev === file.rev);
  if (exported === undefined && file.design.device !== undefined) {
    missing.push({ what: `designs/${file.designId} device-assemble`, why: `no device export of Rev ${file.rev} is kept; working-copy exports are not used (Export Rev ${file.rev} on its Device view)` });
  }
  return { files, ...(exported === undefined ? {} : { export: exported }), missing };
}
