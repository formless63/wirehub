/**
 * The enclosure run record (`data/enclosures/<id>.json`) and the pack/op names, on their own: the
 * job (`job.ts`) writes it, the panel API, representations and print preparation read it. A leaf
 * module (type-only imports), so readers do not pull the job's runtime imports into an import cycle.
 */

import type { EnclosureSpec } from '@wirehub/model';

import type { PackFinding } from './request.ts';

export const ENCLOSURE_PACK = 'enclosure';
export const ENCLOSURE_OP = 'enclosure-generate';
export const enclosureRunPath = (id: string): string => `data/enclosures/${id}.json`;

export interface EnclosureOutput {
  role: string;
  path: string;
  mediaType: string;
  sha256: string;
  /** the asset id, for the outputs kept as assets (everything but the manifest-only JSON) */
  asset?: string;
  bytes: number;
}

/** One generation, as stored and as the panel shows it. */
export interface EnclosureRun {
  enclosure: string;
  generatedAt: string;
  by?: string;
  status: 'ok' | 'failed';
  pack: string;
  packVersion: string;
  image: string;
  imageId?: string;
  /** the job that ran it */
  job?: string;
  tool: Record<string, string>;
  requestSha256: string;
  inputs: { spec: EnclosureSpec; sources: { pcba: string; path: string; sha256: string }[] };
  findings: PackFinding[];
  outputs: EnclosureOutput[];
  result: unknown;
  log: string;
}
