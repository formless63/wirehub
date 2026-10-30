/**
 * Saving preserves work; it does not certify it (SPEC "Saving is not approval").
 *
 * Every validator finding falls in one of three classes:
 *
 *   (a) representation integrity — the document cannot be stored or read back
 *       as what it claims to be (two parts sharing one id, a sub-assembly that
 *       places itself, a field of the wrong shape). These refuse the save.
 *   (b) design findings — everything else: unknown definitions, pins that are
 *       not there, incompatible or open connections, shop rules. They are
 *       saved with the document and shown as findings.
 *   (c) release criteria — a deliberate release or publication still refuses
 *       on any `error` (`versions.ts`, the server's release endpoint).
 *
 * This file names (a). Anything not listed is (b) for a save.
 */

import type { Issue } from './model.ts';

/** Issue codes that make a document unrepresentable: they refuse a save. */
export const INTEGRITY_CODES: ReadonlySet<string> = new Set([
  // designs: ids are the keys joints, notes and BOM lines address parts by
  'duplicate-instance-id',
  // a placement loop can never be expanded
  'subassembly-cycle',
  // fields whose shape every reader relies on
  'invalid-tags',
  'invalid-labour',
  'invalid-processes',
  'invalid-extensions',
  'invalid-electrical',
  'invalid-status',
  // library records: ids and element paths are how everything else names them
  'duplicate-id',
  'duplicate-terminal-id',
  'duplicate-sibling-element-id',
  'missing-element-id',
  // wire stock recipes and parts: a core and a part are addressed by id
  'wire-core-duplicate',
  'wire-part-id',
  // product families and resolver records: addressed by id
  'product-duplicate',
  'product-bad-id',
  'product-variant-duplicate',
  'device-duplicate',
  'device-bad-id',
  'device-port-duplicate',
  'device-extends-cycle',
  'recipe-duplicate',
  'recipe-bad-id',
  'hazard-duplicate',
  'hazard-bad-id',
  // board build files: a build is addressed by its key
  'build-duplicate',
]);

/** True when this finding makes the document unrepresentable (class a). */
export function isIntegrityIssue(issue: Issue): boolean {
  return issue.severity === 'error' && INTEGRITY_CODES.has(issue.code);
}

/** The findings that refuse a save; the rest are saved with the record. */
export function integrityIssues(issues: readonly Issue[]): Issue[] {
  return issues.filter(isIntegrityIssue);
}

/** Counts for a compact "saved with N findings" line. */
export function findingCounts(issues: readonly Issue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === 'error') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings };
}

/** "saved — 2 problems, 1 note to look at" or undefined when there is nothing to say. */
export function savedWithFindings(issues: readonly Issue[]): string | undefined {
  const { errors, warnings } = findingCounts(issues);
  if (errors + warnings === 0) return undefined;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} problem${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
  return `${parts.join(', ')} to look at`;
}
