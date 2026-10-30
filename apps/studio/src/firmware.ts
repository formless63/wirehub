/**
 * Firmware projects (WF-FW, first journey): source + configuration linked to a board, and to
 * particular placements of that board in designs (occurrences), each with its own overrides.
 * A compile runs the `firmware-platformio` tool pack offline and keeps its binaries, size report,
 * log and the exact toolchain. Compiling is not device operation: flashing a unit is a separate,
 * separately authorised commissioning record (`firmware-commission.ts`, `docs/firmware.md`).
 *
 * Shared by the server (`server/firmware/api.ts`) and the browser; no runtime dependencies.
 */

/** A configuration value, passed to the build as a C macro (`-DNAME=value`); null = defined, no value. */
export type ConfigValue = string | number | boolean | null;
export type ConfigParams = Record<string, ConfigValue>;

/** One placement of the board in a design (a `pcbas` instance) with what differs for it. */
export interface FirmwareOccurrence {
  design: string;
  /** the `PcbaInstance.id` within that design */
  instance: string;
  /** values that replace the project's defaults for this occurrence: pins, bus addresses, names */
  overrides: ConfigParams;
  note?: string;
}

export interface FirmwareSourceFile {
  /** relative path inside the project (`src/main.cpp`, `platformio.ini`) or an archive name */
  path: string;
  sha256: string;
  bytes: number;
}

export interface FirmwareTarget {
  id: string;
  label: string;
  platform: string;
  framework: string;
  /** the tool pack whose image compiles this target */
  pack?: string;
}

export interface FirmwareProject {
  id: string;
  label: string;
  /** provenance, as every record carries one: "synthetic example", a repository URL… */
  src: string;
  /** the board (`pcbas` definition id) this firmware runs on */
  board?: string;
  toolchain: { pack: string; target: string; environment?: string };
  source: FirmwareSourceFile[];
  /** the project's default configuration */
  params: ConfigParams;
  occurrences: FirmwareOccurrence[];
  note?: string;
}

export type FirmwareBuildStatus = 'queued' | 'running' | 'ok' | 'failed' | 'error' | 'cancelled';

export interface FirmwareBuildOutput {
  path: string;
  sha256: string;
  role: string;
  mediaType: string;
  bytes: number;
}

export interface FirmwareBuild {
  id: string;
  project: string;
  startedAt: string;
  finishedAt?: string;
  status: FirmwareBuildStatus;
  /** absent: the project's own defaults; present: one occurrence's effective configuration */
  occurrence?: { design: string; instance: string };
  /** the job that runs (ran) the compile (`/api/jobs/:id`): progress, cancel */
  job?: string;
  /** whether the compile was allowed a network (to fetch declared libraries) */
  network?: boolean;
  /** the job's latest step, while it is queued or running (not stored) */
  progress?: string;
  /** exactly what the build was given */
  effective: { target: string; environment?: string; defines: ConfigParams; source: FirmwareSourceFile[] };
  pack?: string;
  packVersion?: string;
  /** the image reference and its content id (`sha256:…`), so the toolchain can be found again */
  image?: string;
  imageId?: string;
  tool?: { name: string; version: string };
  /** platform and package versions the pack reported */
  toolchain?: { platformio?: string; platforms?: { name: string; version: string }[]; packages?: { name: string; version: string }[] };
  outputs: FirmwareBuildOutput[];
  /** sha256 of the build log */
  log?: string;
  findings: { level: 'info' | 'warn' | 'error'; message: string }[];
  /** why the run itself could not happen (no tool image, no Docker …) */
  message?: string;
  durationMs?: number;
}

const MACRO = /^[A-Z_][A-Z0-9_]{0,63}$/;
const TEXT = /^[A-Za-z0-9 _.,:/+@#-]{0,128}$/;

/** Problems with one set of configuration values, in words; empty when every value is usable. */
export function configProblems(params: unknown): string[] {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return ['Configuration must be an object of NAME: value.'];
  const out: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (!MACRO.test(name)) out.push(`${name}: a name of capital letters, digits and _ (a C macro).`);
    else if (typeof value === 'string' && !TEXT.test(value)) out.push(`${name}: text may hold letters, digits, space and _ . , : / + @ # - only, up to 128.`);
    else if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${name}: not a finite number.`);
    else if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) out.push(`${name}: a number, true/false, text or null.`);
  }
  return out;
}

/** The configuration a build of the project gets: its defaults, then the occurrence's overrides. */
export function effectiveConfig(project: FirmwareProject, occurrence?: { design: string; instance: string }): ConfigParams {
  if (occurrence === undefined) return { ...project.params };
  const found = project.occurrences.find((o) => o.design === occurrence.design && o.instance === occurrence.instance);
  return { ...project.params, ...(found?.overrides ?? {}) };
}

export const isFirmwareId = (id: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && id.length <= 80;
