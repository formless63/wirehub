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

import type { CableDesign, Db } from '@wirehub/model';

import { footHtml, headerFrame, headerHtml, headerFrameCss, type SheetHeader } from './bench/header.ts';
import { bomSheetBody, bomSheetMarkdown, deriveBomSheet, sheetHeaderOf } from './bom-sheet.ts';
import { type BuildSheetOptions, type SheetOptions, benchOptions } from './build-sheet.ts';
import { brandSheetCss } from './drawing/brand-font.ts';
import { flowPageCss, type SheetFrameSpec } from './frame/index.ts';
import { SHEET_STYLESHEET } from './styles.ts';
import { resolveTestParameters } from './exports/test-params.ts';
import { deriveTestSpec } from './test-spec.ts';
import { testSpecToHtml } from './test-spec-render.ts';
import { escapeHtml, facts } from './text.ts';

/**
 * The `.cs-root` element for a one-section document: the frame's title block
 * (`header`), the caller's fragment, and the same footer line the build sheet
 * closes with.
 */
export function documentBody(header: SheetHeader, section: string): string {
  return [
    '<div class="cs-root cs-sheet wh-sheet-col">',
    `<style>${SHEET_STYLESHEET}${headerFrameCss(header)}${brandSheetCss()}</style>`,
    headerHtml(header),
    section,
    `<footer class="cs-foot">${escapeHtml(
      facts([header.designId, 'derived from the canonical model — one derivation, however it is printed']),
    )}</footer>`,
    footHtml(header),
    '</div>',
  ].join('');
}

/**
 * Wrap a body in the document shell. `@page` lives here for the same reason it
 * lives in `renderBuildSheet`: a page rule cannot be scoped to a class, so an
 * embeddable fragment must never emit one. Given the sheet's frame, the shell
 * also carries what repeats on every printed page: the border, the strip and
 * the state stamp (`frame/`).
 */
export function standaloneDocument(title: string, body: string, options: SheetOptions = {}, frame?: SheetFrameSpec): string {
  if (options.fragment === true) return body;
  const page = frame === undefined ? '@page{size:A4 portrait;margin:12mm}' : flowPageCss(frame);
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${page}html,body{margin:0;padding:0;background:#ffffff}</style>`,
    '</head>',
    `<body${frame === undefined ? '' : ' class="wh-paged"'}>`,
    body,
    '</body>',
    '</html>',
  ].join('');
}

/**
 * The bill of materials, printable on its own: the product PN in the title
 * block, the lines grouped by section — exactly an ERP export's lines
 * (`deriveBomSheet`).
 */
export function renderBomSheet(design: CableDesign, db: Db, options: BuildSheetOptions = {}): string {
  const bench = benchOptions(options);
  const body = bomSheetBody(deriveBomSheet(design, db, bench));
  const frame = headerFrame(sheetHeaderOf(design, db, bench, 'BILL OF MATERIALS'));
  return standaloneDocument(`${options.title ?? design.label} — bill of materials`, body, options, frame);
}

/** The BOM as markdown, from the same model (Documents › Copy). */
export function renderBomMarkdown(design: CableDesign, db: Db, options: BuildSheetOptions = {}): string {
  return bomSheetMarkdown(deriveBomSheet(design, db, benchOptions(options)));
}

/** The continuity / test spec, printable on its own. */
export function renderTestSpecSheet(design: CableDesign, db: Db, options: BuildSheetOptions = {}): string {
  const parameters = resolveTestParameters(options.testParameters, options.testDefaults);
  const header = sheetHeaderOf(design, db, benchOptions(options), 'CONTINUITY & TEST SPEC');
  const body = documentBody(
    header,
    testSpecToHtml(deriveTestSpec(design, db, { continuityOhmsMax: parameters.continuityOhmsMax }), parameters),
  );
  return standaloneDocument(`${options.title ?? design.label} — continuity & test spec`, body, options, headerFrame(header));
}
