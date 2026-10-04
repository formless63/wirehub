/**
 * Mounting: how one *design* uses a connector — as
 * opposed to `connectorConstruction` (`interfaces.ts`), which is what the
 * part physically is. A solder-cup connector is wired one of two ways:
 *
 * - `direct-solder` — wires land on the cups (the ordinary use);
 * - `board-straddle` — a PCB edge is forced between the solder-cup rows and
 *   soldered, so the connector stands in for a PCB-mount part (DB-23,
 *   SCART, mini-DIN 9/10, multi-out ports, HD15, JP21 all take this
 *   treatment).
 *
 * Derived from the design rather than stored, except where derivation can't
 * tell: a connector instance whose pins land straight on a PCBA's terminals —
 * either because the design boards it directly (no wire in between: the source device
 * DB-23 `j1.3` → `u1.j.3`) or because the connector is one of a board's own
 * `integratedConnectors` (a multi-out plug on PCA-00110, SCART male on
 * PCA-00101 — the connector has no instance of its own at all, its mating
 * pins simply *are* the board's terminals) — is board-straddle; one whose
 * pins land on wire-stock conductors (or nothing but another of its own pins,
 * an internal jumper) is direct-solder.
 *
 * Pure: designs and the catalog in, mountings out.
 */

import type { CableDesign, ConnectorInstance, Db, TerminalRef } from './model.ts';

/** `direct-solder` | `board-straddle`, open like `ConnectorGender` — a vocab `connector-mountings` id. */
export type ConnectorMounting = 'direct-solder' | 'board-straddle' | (string & {});

/** Just enough of a design to derive mounting: its instances (kind lookup) and joints. */
export type MountingDesign = Pick<CableDesign, 'instances' | 'joints'>;

function otherEnd(joint: { a: TerminalRef; b: TerminalRef }, instanceId: string): TerminalRef | undefined {
  if (joint.a.instance === instanceId) return joint.b;
  if (joint.b.instance === instanceId) return joint.a;
  return undefined;
}

/** Which of the four instance categories an id is in, without requiring a full `CableDesign`. */
function instanceKind(design: MountingDesign, id: string): 'connector' | 'segment' | 'component' | 'pcba' | undefined {
  if (design.instances.connectors.some((i) => i.id === id)) return 'connector';
  if (design.instances.segments.some((i) => i.id === id)) return 'segment';
  if (design.instances.components.some((i) => i.id === id)) return 'component';
  if (design.instances.pcbas.some((i) => i.id === id)) return 'pcba';
  return undefined;
}

/**
 * The mounting of one connector instance: its own stored `mounting` first,
 * else derived from its joints, else `undefined` — nothing joints it yet, or
 * it joints only to other connectors with no board or wire in the mix.
 */
export function connectorMountingOfInstance(
  design: MountingDesign,
  instanceId: string,
  instance?: Pick<ConnectorInstance, 'mounting'>,
): ConnectorMounting | undefined {
  const stored = instance?.mounting ?? design.instances.connectors.find((c) => c.id === instanceId)?.mounting;
  if (stored !== undefined) return stored;
  let sawBoard = false;
  let sawWire = false;
  for (const joint of design.joints) {
    const other = otherEnd(joint, instanceId);
    if (other === undefined || other.instance === instanceId) continue;
    const kind = instanceKind(design, other.instance);
    if (kind === 'pcba') sawBoard = true;
    else if (kind === 'segment' || kind === 'component') sawWire = true;
  }
  if (sawBoard) return 'board-straddle';
  if (sawWire) return 'direct-solder';
  return undefined;
}

/** Which designs mount a connector definition board-straddle vs direct-solder. */
export interface ConnectorMountingUsage {
  /** design ids where the connector is board-straddle (an instance, or a board that integrates it) */
  straddle: string[];
  /** design ids where the connector is direct-solder */
  direct: string[];
}

/**
 * Every design's mounting of a connector definition, across the design's own
 * connector instances and the boards it uses that integrate the connector
 * (`db.pcbas[].integratedConnectors` — always board-straddle: forcing the PCB
 * in is the whole point of that mechanism). A design that mounts the
 * connector both ways (unusual — two instances, one of each) counts in both.
 */
export function connectorMountingUsage(
  db: Pick<Db, 'pcbas'>,
  designs: readonly (MountingDesign & { id: string })[],
  connectorId: string,
): ConnectorMountingUsage {
  const integratingBoards = new Set(
    db.pcbas.filter((p) => (p.integratedConnectors ?? []).some((entry) => entry.connectorDefId === connectorId)).map((p) => p.id),
  );
  const straddle = new Set<string>();
  const direct = new Set<string>();
  for (const design of designs) {
    if (design.instances.pcbas.some((i) => integratingBoards.has(i.def))) straddle.add(design.id);
    for (const instance of design.instances.connectors) {
      if (instance.def !== connectorId) continue;
      const mounting = connectorMountingOfInstance(design, instance.id, instance);
      if (mounting === 'board-straddle') straddle.add(design.id);
      else if (mounting === 'direct-solder') direct.add(design.id);
    }
  }
  return { straddle: [...straddle], direct: [...direct] };
}
