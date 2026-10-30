/**
 * Draft-work grants (`docs/mcp.md`): a personal API token with scope
 * `drafts:write` instead of `catalog:write` creates and edits working designs
 * and library items, and nothing else. Pure, so the gate and the batch route
 * share it without pulling in the token store.
 */

export const DRAFT_SCOPE = 'drafts:write';

const DESIGN_ID = '[^/]+';
/** The writes a draft-work grant (`drafts:write`) may make: working designs and library items, created or edited. */
const DRAFT_WRITES: readonly [string, RegExp][] = [
  ['POST', /^\/api\/designs$/],
  ['PUT', new RegExp(`^/api/designs/${DESIGN_ID}$`)],
  ['POST', new RegExp(`^/api/designs/${DESIGN_ID}/duplicate$`)],
  // tags added to or removed from many working designs at once (design-tags.ts)
  ['POST', /^\/api\/design-tags$/],
  ['PUT', new RegExp(`^/api/drawings/${DESIGN_ID}$`)],
  ['POST', /^\/api\/definitions\/[^/]+$/],
  ['PUT', /^\/api\/definitions\/[^/]+\/[^/]+$/],
  ['POST', /^\/api\/definitions\/[^/]+\/[^/]+\/fork$/],
  // an explored combination made a draft (a design or a shell part), the pick kept with the exploration
  ['POST', /^\/api\/explore\/pick$/],
  // the batch's own requests are checked one by one (api.ts `runBatch`)
  ['POST', /^\/api\/batch$/],
  // running a job, and stopping one
  ['POST', /^\/api\/jobs$/],
  ['POST', /^\/api\/jobs\/[^/]+\/cancel$/],
  // a lease on what it edits, so a person's open editor is never overwritten
  ['POST', /^\/api\/locks\/(acquire|heartbeat|release)$/],
];

/**
 * Whether a draft-work grant may make this write: create and edit drafts —
 * never delete, rename, save or release a version, publish an import, or
 * change settings, packs or modules.
 */
export function isDraftWrite(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const p = path.split('?')[0] ?? '';
  return DRAFT_WRITES.some(([dm, re]) => dm === m && re.test(p));
}

/** Writes that never spend a token's budget: dry runs and edit-lock leases. */
export function isFreeWrite(method: string, path: string): boolean {
  const p = path.split('?')[0] ?? '';
  const query = new URLSearchParams(path.split('?')[1] ?? '');
  return query.get('dryRun') === '1' || (method.toUpperCase() === 'POST' && /^\/api\/locks\//.test(p));
}
