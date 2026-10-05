/**
 * Per-record licence and provenance (`docs/catalog-store.md` §2, §6).
 *
 * Every catalog record keeps its mandatory `src` citation. A record that came
 * from a catalog pack, or that a store will publish, may add three optional
 * fields, all defined here and checked by `validateDb`:
 *
 * - `license`: an SPDX licence expression (`CC0-1.0`, `CC-BY-4.0`,
 *   `CC-BY-SA-4.0 OR CC0-1.0`, `LicenseRef-vendor-terms`); the default is the
 *   licence of the pack the record sits in, else the catalog's (CC0-1.0).
 * - `provenance`: how the values were obtained (`method`), the sources they
 *   came from (a URL, a citation, or both) and who checked them.
 * - `derivedFrom`: the pack record this one was forked from
 *   (`{ pack, id, version }`), so a deployment's copy still says where it began.
 *
 * Pure: strings in, issues out. No IO, no network (a URL is checked for its
 * shape, never fetched).
 */

import { costIssues, type PartCost } from './cost.ts';
import type { Issue } from './model.ts';

/** How a record's values were obtained. */
export const PROVENANCE_METHODS = ['transcribed', 'derived', 'measured', 'generated', 'synthetic'] as const;
export type ProvenanceMethod = (typeof PROVENANCE_METHODS)[number];

/** One source a record's values came from: a citation, a URL, or both. */
export interface ProvenanceSource {
  /** the citation: document, revision, clause */
  title?: string;
  /** where it can be read; `http(s)` */
  url?: string;
  /** ISO date (`2026-09-30`) the source was read */
  retrieved?: string;
}

/** A review of the record against its sources. */
export interface ProvenanceReview {
  by: string;
  /** ISO date */
  on: string;
}

export interface RecordProvenance {
  method: ProvenanceMethod;
  sources: ProvenanceSource[];
  reviewed?: ProvenanceReview[];
}

/** The pack record a local record was forked from. */
export interface DerivedFrom {
  pack: string;
  id: string;
  version: string;
}

/**
 * One of a manufacturer's own documents (a datasheet, a drawing) for a record: a PDF held by
 * content address, in the shared asset library or shipped in a data pack (`docs/` or `assets/`),
 * so it opens in the app and is served by `/api/blobs/<asset>`. A citation, never our document number.
 */
export interface VendorDoc {
  /** the sha256 of the PDF's bytes, hex */
  asset: string;
  /** what it is, in words ("the vendor C146 technical datasheet") */
  label: string;
  src: string;
}

/** The optional fields a catalog record may carry besides `src`. */
export interface RecordMeta {
  license?: string;
  /** the manufacturer's own documents for this record, by content address (`VendorDoc`) */
  vendorDocs?: VendorDoc[];
  provenance?: RecordProvenance;
  derivedFrom?: DerivedFrom;
  /** optional price (`cost.ts`); absent = unpriced */
  cost?: PartCost;
}

const SPDX_ID = /^(?:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*\+?)$/;
const SPDX_OPERATOR = /^(?:AND|OR|WITH)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether `value` looks like an SPDX licence expression: ids joined by
 * `AND`, `OR` or `WITH`, optionally parenthesised. A shape check — it does not
 * know the SPDX list, so a typo that is still shaped like an id passes; a
 * sentence, an empty string or stray punctuation does not.
 */
export function isSpdxLike(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  const tokens = value.replace(/[()]/g, ' $& ').trim().split(/\s+/);
  if (tokens.length === 0 || tokens[0] === '') return false;
  let depth = 0;
  let expectId = true;
  for (const token of tokens) {
    if (token === '(') {
      if (!expectId) return false;
      depth += 1;
    } else if (token === ')') {
      if (expectId) return false;
      depth -= 1;
      if (depth < 0) return false;
    } else if (expectId) {
      if (!SPDX_ID.test(token) || SPDX_OPERATOR.test(token)) return false;
      expectId = false;
    } else {
      if (!SPDX_OPERATOR.test(token)) return false;
      expectId = true;
    }
  }
  return !expectId && depth === 0;
}

/** Whether `value` is an absolute `http(s)` URL. */
export function isSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname !== '';
  } catch {
    return false;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * The problems with a record's `license`, `provenance` and `derivedFrom`
 * (every one an error: a value that is present has to be well formed; absent is
 * fine). `where` is the record's address in `Issue.where` (`connectors/x`).
 */
export function recordMetaIssues(record: object, where: string): Issue[] {
  const r = record as Record<string, unknown>;
  const issues: Issue[] = [];
  const bad = (code: string, message: string): void => {
    issues.push({ code, severity: 'error', message: `record '${where}': ${message}`, where });
  };

  if (r['license'] !== undefined && !isSpdxLike(r['license'])) {
    bad('record-license', `license ${JSON.stringify(r['license'])} is not an SPDX licence expression (like CC0-1.0 or CC-BY-4.0)`);
  }

  const provenance = r['provenance'];
  if (provenance !== undefined) {
    if (!isObject(provenance)) {
      bad('record-provenance', 'provenance must be an object { method, sources }');
    } else {
      if (!(PROVENANCE_METHODS as readonly unknown[]).includes(provenance['method'])) {
        bad('record-provenance', `provenance.method must be one of ${PROVENANCE_METHODS.join(', ')}`);
      }
      const sources = provenance['sources'];
      if (!Array.isArray(sources) || sources.length === 0) {
        bad('record-provenance', 'provenance.sources must list at least one source (a URL or a citation)');
      } else {
        sources.forEach((source, index) => {
          const at = `provenance.sources[${index}]`;
          if (!isObject(source)) return bad('record-provenance', `${at} must be an object { title?, url?, retrieved? }`);
          if (!isText(source['title']) && source['url'] === undefined) bad('record-provenance', `${at} needs a title (a citation) or a url`);
          if (source['title'] !== undefined && !isText(source['title'])) bad('record-provenance', `${at}.title must be text`);
          if (source['url'] !== undefined && !isSourceUrl(source['url'])) bad('record-provenance', `${at}.url must be an http(s) URL`);
          if (source['retrieved'] !== undefined && !(typeof source['retrieved'] === 'string' && ISO_DATE.test(source['retrieved']))) {
            bad('record-provenance', `${at}.retrieved must be an ISO date (2026-09-30)`);
          }
        });
      }
      const reviewed = provenance['reviewed'];
      if (reviewed !== undefined) {
        if (!Array.isArray(reviewed)) bad('record-provenance', 'provenance.reviewed must be a list of { by, on }');
        else {
          reviewed.forEach((review, index) => {
            if (!isObject(review) || !isText(review['by']) || typeof review['on'] !== 'string' || !ISO_DATE.test(review['on'])) {
              bad('record-provenance', `provenance.reviewed[${index}] must be { by, on } with an ISO date`);
            }
          });
        }
      }
    }
  }

  const docs = r['vendorDocs'];
  if (docs !== undefined) {
    if (!Array.isArray(docs) || docs.length > 20) bad('record-vendor-docs', 'vendorDocs must be a list of at most 20 { asset, label, src }');
    else {
      docs.forEach((doc, index) => {
        if (!isObject(doc) || typeof doc['asset'] !== 'string' || !/^[0-9a-f]{64}$/.test(doc['asset']) || !isText(doc['label']) || !isText(doc['src'])) {
          bad('record-vendor-docs', `vendorDocs[${index}] must be { asset (the sha256 of the PDF, 64 hex digits), label, src }`);
        }
      });
    }
  }

  const derived = r['derivedFrom'];
  if (derived !== undefined) {
    if (!isObject(derived) || typeof derived['pack'] !== 'string' || !KEBAB.test(derived['pack']) || !isText(derived['id']) || typeof derived['version'] !== 'string' || !SEMVER.test(derived['version'])) {
      bad('record-derived-from', 'derivedFrom must be { pack (kebab-case), id, version (semver) }');
    }
  }
  issues.push(...costIssues(record, where));
  return issues;
}
