/**
 * Installs the drawings the deployment's modules carry (`ArtContribution`,
 * `docs/modules.md` "Art") into the registries that draw with them: connector
 * art (canvas and schematic), body layouts (the connector builder), the
 * drawing sheet's art and the bench's work instructions.
 *
 * Shared by the browser (`src/App.tsx`) and the server (`server/modules.ts`, which Node loads by type
 * stripping — nothing here may import React or `.tsx`).
 * Every record is validated first; a module that ships a broken record fails
 * at start with a sentence per problem, like a bad manifest does.
 */

import { parseBodyLayouts, parseConnectorArt, type BodyLayoutRecord } from '@wirehub/catalog';
import { drawingArtProblems, registerDrawingArt, type DrawingArt } from '@wirehub/docs';
import type { ModuleRegistry } from '@wirehub/modules';
import { registerConnectorArt } from '@wirehub/render-svg';

/**
 * Register every module's art; returns the function that removes it all.
 * `extra` lets the browser add what only it uses (the connector builder's body
 * layouts, which live in the React package the server never loads).
 */
export function installModuleArt(registry: ModuleRegistry, extra: (layouts: readonly BodyLayoutRecord[]) => () => void = () => () => {}): () => void {
  const problems: string[] = [];
  const offs: (() => void)[] = [];
  for (const contribution of registry.art()) {
    const connectors = (contribution.connectors ?? []).flatMap((raw, i) => {
      const parsed = parseConnectorArt(raw, `${contribution.module} art.connectors[${i}]`);
      problems.push(...parsed.issues.map((issue) => `${issue.where}: ${issue.message}`));
      return parsed.record === undefined ? [] : [parsed.record];
    });
    const layouts = parseBodyLayouts(contribution.bodyLayouts ?? [], `${contribution.module} art.bodyLayouts`);
    problems.push(...layouts.issues.map((issue) => `${issue.where}: ${issue.message}`));
    const drawing = drawingArtProblems(contribution.drawing).map((p) => `${contribution.module} art.drawing: ${p}`);
    problems.push(...drawing);
    if (problems.length > 0) continue;
    offs.push(registerConnectorArt(connectors), extra(layouts.records));
    if (contribution.drawing !== undefined) offs.push(registerDrawingArt(contribution.drawing as DrawingArt));
  }
  if (problems.length > 0) {
    for (const off of offs) off();
    throw new Error(`module art: ${problems.join('; ')}`);
  }
  return () => offs.forEach((off) => off());
}

/** Where the title block's logo cell is, on the drawing sheet (points: x, y, width, height). */
export const BRANDING_LOGO_BOX = [20, 543, 210, 54] as const;

/** The hub's branding settings as `GET /api/settings/branding` answers them. */
export interface BrandingSettings {
  organisation?: string;
  standard?: string;
  rights?: string;
  designer?: string;
  /** the prefix of exported wire spec files */
  filePrefix?: string;
  notes?: [string, string, string];
  logoDataUri?: string;
}

/** The drawing art a branding setting stands for; `undefined` when nothing is set (the generic text stays). */
export function brandingArt(settings: BrandingSettings | undefined): DrawingArt | undefined {
  if (settings === undefined) return undefined;
  const { organisation, standard, rights, designer, filePrefix, notes, logoDataUri } = settings;
  const png = logoDataUri === undefined ? undefined : /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(logoDataUri)?.[1];
  const titleBlock = {
    ...(organisation === undefined ? {} : { organisation }),
    ...(standard === undefined ? {} : { standard }),
    ...(rights === undefined ? {} : { rights }),
    ...(designer === undefined ? {} : { designer }),
    ...(filePrefix === undefined ? {} : { filePrefix }),
    ...(notes === undefined ? {} : { notes }),
  };
  if (png === undefined && Object.keys(titleBlock).length === 0) return undefined;
  return {
    ...(Object.keys(titleBlock).length === 0 ? {} : { titleBlock }),
    ...(png === undefined ? {} : { logo: { pngBase64: png, box: BRANDING_LOGO_BOX } }),
  };
}

/**
 * Register the hub's branding as drawing art and return the function that
 * removes it. Call it after `installModuleArt`: the earliest registration to
 * set a part wins, so a module's art still beats the setting.
 */
export function installBranding(settings: BrandingSettings | undefined): () => void {
  const art = brandingArt(settings);
  return art === undefined ? () => {} : registerDrawingArt(art);
}
