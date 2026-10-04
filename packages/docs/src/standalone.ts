/**
 * The BOM and the continuity spec as **documents of their own**.
 *
 * `bomToHtml` and `testSpecToHtml` deliberately return fragments: the build
 * sheet embeds them, and so does a host page. But a BOM handed to purchasing,
 * or a continuity spec pinned next to a meter, is a sheet someone prints on its
 * own — and a bare fragment prints without a stylesheet, without a `@page` and
 * without saying which design it belongs to.
 *
 * So this file adds the missing wrapper and nothing else. It computes no fact:
 * the tables come from `deriveBom` / `deriveTestSpec` exactly as the build
 * sheet gets them, so a line item can never differ between a standalone BOM and
 * the BOM section of the build sheet. Same stylesheet, same class prefix, same
 * self-containment rule (no font, no script, no external reference of any
 * kind), same determinism — no clock unless the caller passes one.
 */

import { designStatus, type CableDesign, type Db } from '@wirehub/model';

import { bomSheetBody, bomSheetMarkdown, deriveBomSheet } from './bom-sheet.ts';
import { benchOptions, type BuildSheetOptions, type SheetOptions } from './build-sheet.ts';
import { SHEET_STYLESHEET } from './styles.ts';
import { deriveTestSpec } from './test-spec.ts';
import { testSpecToHtml } from './test-spec-render.ts';
import { escapeHtml, facts } from './text.ts';

function fact(key: string, value: string): string {
  return (
    '<div class="cs-fact">' +
    `<span class="cs-fact__k">${escapeHtml(key)}</span>` +
    `<span class="cs-fact__v">${escapeHtml(value)}</span>` +
    '</div>'
  );
}

/**
 * The `.cs-root` element for a one-section document: title block, the caller's
 * fragment, and the same footer line the build sheet closes with.
 */
export function documentBody(
  kind: string,
  design: CableDesign,
  section: string,
  options: SheetOptions = {},
): string {
  const identity = options.document ?? {};
  const title = options.title ?? design.label;
  return [
    '<div class="cs-root cs-sheet">',
    `<style>${SHEET_STYLESHEET}</style>`,
    '<header class="cs-titleblock">',
    '<div class="cs-titleblock__bar">',
    `<span class="cs-titleblock__kind">${escapeHtml(kind)}</span>`,
    `<span class="cs-titleblock__doc">${escapeHtml(
      facts([identity.number, identity.revision, identity.status]) || design.id,
    )}</span>`,
    '</div>',
    `<div class="cs-titleblock__title">${escapeHtml(title)}</div>`,
    '<div class="cs-titleblock__facts">',
    fact('Design', design.id),
    ...(design.productRef === undefined ? [] : [fact('Product ref', design.productRef)]),
    // a development or legacy design says so on its title block; active stays quiet
    ...(designStatus(design) === 'active' ? [] : [fact('Design status', designStatus(design).toUpperCase())]),
    ...(options.generatedAt === undefined ? [] : [fact('Generated', options.generatedAt)]),
    '</div>',
    '</header>',
    section,
    `<footer class="cs-foot">${escapeHtml(
      facts([design.id, 'derived from the canonical model — one derivation, however it is printed']),
    )}</footer>`,
    '</div>',
  ].join('');
}

/**
 * Wrap a body in the document shell. `@page` lives here for the same reason it
 * lives in `renderBuildSheet`: a page rule cannot be scoped to a class, so an
 * embeddable fragment must never emit one.
 */
export function standaloneDocument(title: string, body: string, options: SheetOptions = {}): string {
  if (options.fragment === true) return body;
  const paper = options.paper ?? 'A4';
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>@page{size:${paper} portrait;margin:12mm}html,body{margin:0;padding:0;background:#ffffff}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('');
}

/**
 * The bill of materials, printable on its own: the
 * product PN in the header, the lines grouped by section — exactly an ERP
 * export's lines (`deriveBomSheet`).
 */
export function renderBomSheet(design: CableDesign, db: Db, options: BuildSheetOptions = {}): string {
  const bench = benchOptions(options);
  const body = bomSheetBody(deriveBomSheet(design, db, bench));
  return standaloneDocument(`${options.title ?? design.label} — bill of materials`, body, options);
}

/** The BOM as markdown, from the same model (Documents › Copy). */
export function renderBomMarkdown(design: CableDesign, db: Db, options: BuildSheetOptions = {}): string {
  return bomSheetMarkdown(deriveBomSheet(design, db, benchOptions(options)));
}

/** The continuity / test spec, printable on its own. */
export function renderTestSpecSheet(
  design: CableDesign,
  db: Db,
  options: SheetOptions = {},
): string {
  const body = documentBody(
    'CONTINUITY & TEST SPEC',
    design,
    testSpecToHtml(deriveTestSpec(design, db)),
    options,
  );
  return standaloneDocument(
    `${options.title ?? design.label} — continuity & test spec`,
    body,
    options,
  );
}
