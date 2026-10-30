/**
 * The tool packs this WireHub knows (`tools/<pack>/`, contract v0). The
 * version is the image tag the runner starts: `wirehub-tool-<pack>:<version>`.
 * A pack is "enabled" for a deployment by building or pulling that image on the
 * worker's Docker (or by WIREHUB_TOOL_REGISTRY, which pulls it on first use); a request
 * never names an image of its own.
 */

export interface ToolPackInfo {
  pack: string;
  version: string;
  /** what the pack wraps, for people */
  tool: string;
  ops: Record<string, ToolOpInfo>;
}

export interface ToolOpInfo {
  timeoutMs: number;
  label: string;
  /**
   * Network opt-in: a run of this op may ask for a network (`ToolRunRequest.network`), e.g. a
   * firmware compile that fetches declared libraries. Absent: never — the container has
   * `NetworkMode: none` whatever the request says.
   */
  network?: 'opt-in';
}

export const TOOL_PACKS: Record<string, ToolPackInfo> = {
  kicad: {
    pack: 'kicad',
    version: '10.0.6-7',
    tool: 'KiCad 10.0.6 (kicad-cli)',
    ops: {
      'board-render': { timeoutMs: 5 * 60_000, label: 'Board artwork and renders' },
      'board-3d': { timeoutMs: 10 * 60_000, label: '3D model (STEP, GLB)' },
      fab: { timeoutMs: 5 * 60_000, label: 'Fabrication files' },
      netlist: { timeoutMs: 3 * 60_000, label: 'Nets (schematic and board)' },
    },
  },
  'slicer-prusaslicer': {
    pack: 'slicer-prusaslicer',
    version: '2.9.2-3',
    tool: 'PrusaSlicer 2.9.2 (CLI)',
    ops: {
      slice: { timeoutMs: 15 * 60_000, label: 'Slice for FDM printing (G-code)' },
    },
  },
  'slicer-resin': {
    pack: 'slicer-resin',
    version: '0.1.1',
    tool: 'PrusaSlicer 2.9.2 (SLA) + UVtools 7.0.2',
    ops: {
      slice: { timeoutMs: 20 * 60_000, label: 'Slice for resin printing (.goo)' },
    },
  },
  'slicer-orcaslicer': {
    pack: 'slicer-orcaslicer',
    version: '2.4.2-2',
    tool: 'OrcaSlicer 2.4.2 (CLI)',
    ops: {
      slice: { timeoutMs: 15 * 60_000, label: 'Slice for FDM printing (G-code, Bambu Lab 3MF)' },
      profiles: { timeoutMs: 2 * 60_000, label: 'List the printer, filament and process presets' },
    },
  },
  'firmware-platformio': {
    pack: 'firmware-platformio',
    version: '0.1.0',
    tool: 'PlatformIO 6.2.0',
    ops: { compile: { timeoutMs: 15 * 60_000, label: 'Firmware compile', network: 'opt-in' } },
  },
  'firmware-platformio-esp32': {
    pack: 'firmware-platformio-esp32',
    version: '0.1.0',
    tool: 'PlatformIO 6.2.0 (ESP32)',
    ops: { compile: { timeoutMs: 25 * 60_000, label: 'Firmware compile', network: 'opt-in' } },
  },
  'firmware-platformio-rp2040': {
    pack: 'firmware-platformio-rp2040',
    version: '0.1.0',
    tool: 'PlatformIO 6.2.0 (RP2040)',
    ops: { compile: { timeoutMs: 25 * 60_000, label: 'Firmware compile', network: 'opt-in' } },
  },
  'firmware-esphome': {
    pack: 'firmware-esphome',
    version: '0.1.0',
    tool: 'ESPHome 2026.9.0',
    ops: { compile: { timeoutMs: 25 * 60_000, label: 'Firmware compile', network: 'opt-in' } },
  },
  enclosure: {
    pack: 'enclosure',
    version: '0.3.5',
    tool: 'build123d (Open CASCADE) enclosure generator',
    ops: {
      'enclosure-generate': { timeoutMs: 5 * 60_000, label: 'Enclosure generate' },
      'device-assemble': { timeoutMs: 10 * 60_000, label: 'Device assembly (STEP, GLB, drawing)' },
    },
  },
};

/**
 * The image a pack runs as: `WIREHUB_TOOL_IMAGE_<PACK>` overrides it outright; otherwise
 * `WIREHUB_TOOL_REGISTRY` (a prefix such as `registry.example.com/owner`) names where the
 * pinned tag lives, `<prefix>/wirehub-tool-<pack>:<version>`; unset, the local build's tag.
 */
export function toolImage(pack: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const info = TOOL_PACKS[pack];
  if (info === undefined) throw new Error(`there is no tool pack '${pack}'`);
  const override = env[`WIREHUB_TOOL_IMAGE_${pack.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`]?.trim();
  if (override !== undefined && override !== '') return override;
  const registry = toolRegistry(env);
  return `${registry === undefined ? '' : `${registry}/`}wirehub-tool-${pack}:${info.version}`;
}

/** `WIREHUB_TOOL_REGISTRY` without a trailing slash, or undefined when unset. */
export function toolRegistry(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const value = env.WIREHUB_TOOL_REGISTRY?.trim().replace(/\/+$/, '');
  return value === undefined || value === '' ? undefined : value;
}

/** Human-readable progress text; internal operation keys stay in recorded job metadata. */
export function toolOperationName(pack: string, op: string): string {
  return TOOL_PACKS[pack]?.ops[op]?.label ?? 'Native tool operation';
}
