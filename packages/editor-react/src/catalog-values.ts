/**
 * The values the catalog already uses, per field — what the Library's forms
 * offer as suggestions (: free-text fields that obviously
 * should be pickers from existing catalog values).
 *
 * Deliberately no vocabulary of its own: every list is read off the records
 * that exist (plus the small suggestion lists the forms already had), and a
 * value nobody has used yet can still be typed. A controlled vocabulary is a
 * separate piece of work (specs/data-model-v2.md).
 */

import type { Db, Element } from '@cable-studio/model';
import { createContext, useContext } from 'react';

export interface CatalogValues {
  connectorFamilies: string[];
  /** what connector pins carry (`Red`, `GND`, `Audio L`) */
  pinSignals: string[];
  componentValues: string[];
  colors: string[];
  conductorMaterials: string[];
  conductorFormations: string[];
  insulationMaterials: string[];
  shieldMaterials: string[];
  shieldCoverages: string[];
  pcbaRevisions: string[];
  pcbaBuilds: string[];
  /** what board pads carry */
  padSignals: string[];
}

/** Distinct, trimmed, first spelling wins (case-insensitively), sorted. */
export function distinctValues(values: Iterable<string | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
}

function* elements(root: Element): Generator<Element> {
  yield root;
  if (root.kind === 'group') for (const child of root.children) yield* elements(child);
}

export function catalogValues(db: Db): CatalogValues {
  const all = db.wires.flatMap((wire) => [...elements(wire.structure)]);
  const conductors = all.filter((element) => element.kind === 'conductor');
  const insulations = all.filter((element) => element.kind === 'insulation');
  const shields = all.filter((element) => element.kind === 'shield');
  return {
    connectorFamilies: distinctValues(db.connectors.map((connector) => connector.family)),
    pinSignals: distinctValues(db.connectors.flatMap((connector) => connector.pins.map((pin) => pin.label))),
    componentValues: distinctValues(db.components.map((component) => component.value)),
    colors: distinctValues([
      ...conductors.map((element) => element.color),
      ...insulations.map((element) => element.color),
    ]),
    conductorMaterials: distinctValues(conductors.map((element) => element.material)),
    conductorFormations: distinctValues(conductors.map((element) => element.formation)),
    insulationMaterials: distinctValues(insulations.map((element) => element.material)),
    shieldMaterials: distinctValues(shields.map((element) => element.material)),
    shieldCoverages: distinctValues(shields.map((element) => element.coveragePct)),
    pcbaRevisions: distinctValues(db.pcbas.map((pcba) => pcba.revision)),
    pcbaBuilds: distinctValues(db.pcbas.map((pcba) => pcba.build)),
    padSignals: distinctValues(
      db.pcbas.flatMap((pcba) => pcba.terminals.filter((t) => !t.id.includes('.')).map((t) => t.label)),
    ),
  };
}

export const EMPTY_CATALOG_VALUES: CatalogValues = {
  connectorFamilies: [],
  pinSignals: [],
  componentValues: [],
  colors: [],
  conductorMaterials: [],
  conductorFormations: [],
  insulationMaterials: [],
  shieldMaterials: [],
  shieldCoverages: [],
  pcbaRevisions: [],
  pcbaBuilds: [],
  padSignals: [],
};

/** The values in scope for the forms below — `Library` provides them. */
export const CatalogValuesContext = createContext<CatalogValues>(EMPTY_CATALOG_VALUES);

export function useCatalogValues(): CatalogValues {
  return useContext(CatalogValuesContext);
}
