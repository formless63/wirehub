/**
 * `renderBuildSheet(design, db, opts?)` — the bench build sheet, as one
 * self-contained, print-first HTML document.
 *
 * It is the bench flow, one page per stage (`bench/`): kit & cut (the parts
 * to pull — the BOM's own lines — the cut list per stock and variation, the
 * standard-work prep); each end (the strip plan, then the board's real faces
 * or the connector's solder side with every landing numbered in soldering
 * order, jumpers and fitted/omitted parts called out); assembly (shells,
 * hardware, strain relief per standard work); test (continuity, commoned by
 * design, isolation matrices, deliberate opens, ground twists, picture and
 * sound). The title block carries the product part number, the revision and
 * whether it is released.
 *
 * Three constraints the implementation exists to satisfy:
 *
 * 1. **No external resources of any kind.** No webfont, no CDN, no `<img
 *    src>`, no script. Every drawing is inlined as SVG.
 * 2. **Deterministic.** Byte-identical output for identical input. There is no
 *    clock in here: `generatedAt` is printed only if the caller passes one.
 * 3. **Embeddable.** Everything is `cs-`-prefixed and lives under `.cs-root`
 *    in an `@layer`; an inline drawing's own stylesheet is scoped under
 *    `.cs-svg` so dropping a build sheet into an ERP never restyles the ERP.
 */

import type { CableDesign, Db, KnownPartNumber, PartNumberScheme } from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import { headerFrame, type DocumentFacts } from './bench/header.ts';
import type { PaperId, TitleBlockStandard } from './frame/index.ts';
import { sheetHeaderOf } from './bom-sheet.ts';
import { standaloneDocument } from './standalone.ts';
import type { TestParameters } from './exports/test-params.ts';
import { benchSheetBody, type BenchSheetOptions } from './bench/render.ts';
import type { DrawingMeta } from './drawing/model.ts';
import type { GroundLanding } from './landings.ts';

/* ------------------------------------------------------------------ *
 * Options
 * ------------------------------------------------------------------ */

/** Document identity. The host allocates numbers; this package prints them. */
export interface DocumentIdentity {
  number?: string;
  revision?: string;
  status?: string;
}

/**
 * What every document in this package shares: the page it prints on, its
 * title, its identity block and whether the caller wants the whole document or
 * just the embeddable `.cs-root` element.
 */
export interface SheetOptions {
  /** the paper (`frame/paper.ts`): A4 by default, or the organisation's setting — the `@page` size and the frame */
  paper?: PaperId;
  /** the title-block layout (`ansi` or `iso`); default: the organisation's setting, else the paper's convention */
  titleBlock?: TitleBlockStandard;
  /** who checked the document, for the title block (the approver, when approvals are on) */
  checked?: string;
  /** override the sheet title (defaults to `design.label`) */
  title?: string;
  /**
   * Printed in the title block verbatim. Absent by default **and that is the
   * point**: this package owns no clock, so two runs of the same design
   * produce the same bytes.
   */
  generatedAt?: string;
  document?: DocumentIdentity;
  /** the design's test parameters, printed on the continuity spec (`exports/test-params.ts`) */
  testParameters?: TestParameters;
  /** the organisation's defaults under them */
  testDefaults?: TestParameters;
  /** emit only the `.cs-root` element, for embedding in a host page */
  fragment?: boolean;
}

export interface BuildSheetOptions extends SheetOptions {
  /**
   * Where the board artwork comes from. Absent or `true` reads the catalog's
   * committed tree (Node only); a **browser** host passes its own
   * `DepictionSource`, or `false` for a sheet with no board drawings.
   */
  depictions?: boolean | DepictionSource;
  /** the drawing sidecar: part number, length variations, designer, revision */
  drawing?: DrawingMeta;
  /** a length family's suffix (`-36`): print the sheet for that one variation */
  variation?: string;
  /** the host's short names (destination, sync, stock) — derived when absent */
  facts?: DocumentFacts;
  /** the numbering scheme and every number in use: unmapped parts carry a proposal */
  partNumbers?: { scheme: PartNumberScheme; known: readonly KnownPartNumber[] };
  /** the saved revision being printed */
  revisionNumber?: number;
  /** the BOM lists each sub-assembly's parts instead of one line for it (`BomOptions.explode`) */
  explode?: boolean;
  /** cables in the build: the BOM's quantity breaks are read at this (default 1) */
  buildQty?: number;
}

/* ------------------------------------------------------------------ *
 * Inlining a drawing safely
 * ------------------------------------------------------------------ */

const STYLE_BLOCK = /<style>([\s\S]*?)<\/style>/g;

/**
 * Prefix every selector inside an inline SVG's own `<style>` with `.cs-svg`.
 *
 * The renderer's stylesheet is flat, comma-free and `@`-free by construction,
 * which is what makes this safe as a string transform. An `@`-rule is left
 * exactly as it was rather than mangled — better an unscoped media query than
 * a broken one — and the root element gains the `cs-svg` class either way.
 */
export function scopeSvgStyles(svg: string, scope = 'cs-svg'): string {
  const scoped = svg.replace(STYLE_BLOCK, (_match, css: string) => {
    const rules = css
      .split('}')
      .map((rule) => rule.trim())
      .filter((rule) => rule !== '')
      .map((rule) => {
        const brace = rule.indexOf('{');
        if (brace < 0) return `${rule}}`;
        const selector = rule.slice(0, brace).trim();
        const body = rule.slice(brace + 1);
        if (selector.startsWith('@')) return `${selector}{${body}}`;
        const prefixed = selector
          .split(',')
          .map((part) => `.${scope} ${part.trim()}`)
          .join(',');
        return `${prefixed}{${body}}`;
      })
      .join('');
    return `<style>${rules}</style>`;
  });
  return scoped.replace(/^<svg\b/, `<svg class="${scope}"`);
}


/* ------------------------------------------------------------------ *
 * Terminations — one line per pigtail per end
 * ------------------------------------------------------------------ */

/** "End b — pigtail rgb: twist the red, green, blue shields → u2 GND, pad GND2 (bottom)." */
export function terminationLine(row: GroundLanding): string {
  const what = row.mass
    ? `a ground connection from the ${row.membersText}`
    : `twist the ${row.membersText}`;
  const where =
    row.landing === ''
      ? 'NOT LANDED'
      : `${row.landing}${row.pad === undefined ? '' : `, pad ${row.pad}${row.padSide === undefined ? '' : ` (${row.padSide})`}`}`;
  return `End ${row.end} — ${row.segment} pigtail ${row.pigtail}: ${what} → ${where}.`;
}

/* ------------------------------------------------------------------ *
 * The sheet
 * ------------------------------------------------------------------ */

/** The options as the bench renderer takes them. */
export function benchOptions(options: BuildSheetOptions): BenchSheetOptions {
  return {
    ...(options.title === undefined ? {} : { title: options.title }),
    depictions: options.depictions ?? true,
    ...(options.drawing === undefined ? {} : { drawing: options.drawing }),
    ...(options.variation === undefined ? {} : { variation: options.variation }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
    ...(options.partNumbers === undefined ? {} : { partNumbers: options.partNumbers }),
    ...(options.revisionNumber === undefined ? {} : { revision: options.revisionNumber }),
    ...(options.document === undefined ? {} : { document: options.document }),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
    ...(options.paper === undefined ? {} : { paper: options.paper }),
    ...(options.titleBlock === undefined ? {} : { titleBlock: options.titleBlock }),
    ...(options.checked === undefined ? {} : { checked: options.checked }),
    ...(options.testDefaults === undefined ? {} : { testDefaults: options.testDefaults }),
    ...(options.explode === undefined ? {} : { explode: options.explode }),
    ...(options.buildQty === undefined ? {} : { buildQty: options.buildQty }),
  };
}

/**
 * The `.cs-root` element on its own, stylesheet included. Embeddable. One
 * page per bench stage (`bench/render.ts`): kit & cut, each end, assembly, test.
 */
export function buildSheetBody(
  design: CableDesign,
  db: Db,
  options: BuildSheetOptions = {},
): string {
  return benchSheetBody(design, db, benchOptions(options));
}

/**
 * The whole document. `@page` lives here rather than in `SHEET_STYLESHEET`
 * because a page rule cannot be scoped to a class, and a package that emits
 * an unscopable rule from an embeddable fragment would be reformatting its
 * host's printer.
 */
export function renderBuildSheet(
  design: CableDesign,
  db: Db,
  options: BuildSheetOptions = {},
): string {
  const body = buildSheetBody(design, db, options);
  if (options.fragment === true) return body;
  const title = options.title ?? design.label;
  const frame = headerFrame(sheetHeaderOf(design, db, benchOptions(options), 'BENCH BUILD SHEET'));
  return standaloneDocument(`${title} — bench build sheet`, body, options, frame);
}
