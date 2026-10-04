/**
 * Design lifecycle — Save, New, Duplicate, Rename, Delete.
 *
 * These are the operations that change *which designs exist*, as opposed to
 * `store.ts`, which changes what one design says. They are plain async
 * functions over a `PersistenceAdapter` so the whole lifecycle can be driven
 * in a test with a `Map` behind it, and so the React layer above holds nothing
 * but "what is in flight" and "what went wrong".
 *
 * Two rules run through all of them:
 *
 * - **Every failure is a sentence plus a next step.** An `Outcome` from the
 *   host is turned into a `LifecycleProblem` with `message`, `hint`, and — when
 *   the validator refused the document — one plain line per blocking issue.
 *   No JSON, no codes, no stack traces reach the screen.
 * - **The caller is told what changed**, as a `CatalogChange`, so the host can
 *   refresh its list, drop its unsaved buffer and open the right document
 *   without guessing from the id it happened to pass in.
 */

import type { CableDesign } from '@cable-studio/model';

import {
  blankDesign,
  isDesignId,
  type Outcome,
  type PersistenceAdapter,
} from './persistence.ts';
import { explainIssues } from './store.ts';

/** What happened to the catalog, for the host that has to react to it. */
export type CatalogChange =
  | { kind: 'saved'; design: CableDesign }
  | { kind: 'created'; design: CableDesign }
  | { kind: 'duplicated'; design: CableDesign; from: string }
  | { kind: 'renamed'; design: CableDesign; from: string }
  | { kind: 'deleted'; id: string };

/** A failure, written for the person who has to do something about it. */
export interface LifecycleProblem {
  /** what happened, in one sentence */
  message: string;
  /** what to do next */
  hint?: string;
  /** one line per blocking issue, when the document itself was refused */
  details: string[];
}

export type LifecycleResult =
  | { ok: true; change: CatalogChange; status: string }
  | { ok: false; problem: LifecycleProblem };

const ID_RULE =
  'Ids are lowercase words joined by hyphens, like `rj45-patch-t568b`.';

/** Anything an adapter can answer with when it says no. */
export type Refusal = Extract<Outcome<unknown>, { ok: false }>;

/** An adapter failure, rendered for a person. */
export function problemOf(outcome: Refusal): LifecycleProblem {
  return {
    message: outcome.message,
    ...(outcome.hint === undefined ? {} : { hint: outcome.hint }),
    details: explainIssues(outcome.issues ?? []),
  };
}

function refuse(message: string, hint?: string): LifecycleResult {
  return { ok: false, problem: { message, ...(hint === undefined ? {} : { hint }), details: [] } };
}

/** Guard the two things the GUI can check without a round trip. */
function checkName(id: string, label: string): LifecycleResult | undefined {
  const blank = id.trim() === '';
  if (!isDesignId(id)) {
    return refuse(
      blank ? 'This design needs an id.' : `'${id}' cannot be used as an id.`,
      `${ID_RULE} The name field can suggest one for you.`,
    );
  }
  if (label.trim() === '') {
    return refuse(
      'This design needs a name.',
      'Give it the sentence a builder would read at the top of the build sheet.',
    );
  }
  return undefined;
}

function settle<T>(outcome: Outcome<T>, done: (value: T) => LifecycleResult): LifecycleResult {
  return outcome.ok ? done(outcome.value) : { ok: false, problem: problemOf(outcome) };
}

/* ------------------------------------------------------------------ *
 * The operations
 * ------------------------------------------------------------------ */

/**
 * Write the draft back over the design it came from.
 *
 * The host validates before it writes, so a refusal here means the design is
 * not buildable yet, not that the save machinery broke — and the issue list
 * says exactly which facts are in the way.
 */
export async function saveDesign(
  adapter: PersistenceAdapter,
  draft: CableDesign,
): Promise<LifecycleResult> {
  return settle(await adapter.save(draft), (design) => ({
    ok: true,
    change: { kind: 'saved', design },
    status: `saved ${design.id}`,
  }));
}

/** A new, empty design. `src` answers "where does this information come from?". */
export async function createDesign(
  adapter: PersistenceAdapter,
  fields: { id: string; label: string; src: string },
): Promise<LifecycleResult> {
  const bad = checkName(fields.id, fields.label);
  if (bad !== undefined) return bad;
  if (fields.src.trim() === '') {
    return refuse(
      'This design needs to say where its information comes from.',
      'Name the document, the measurement or the board you are working from — or say that the values are inferred.',
    );
  }
  return settle(
    await adapter.create(blankDesign(fields.id, fields.label.trim(), fields.src.trim())),
    (design) => ({
      ok: true,
      change: { kind: 'created', design },
      status: `created ${design.id}`,
    }),
  );
}

/**
 * Create a design the wizard has already wired.
 *
 * `createDesign` above builds a blank document from three fields; this one is
 * handed a whole `CableDesign` that a guided flow assembled — instances,
 * joints, the drain note — and only checks the two things the GUI can check
 * without a round trip before asking the host to store it. The host still
 * validates and is still the gate.
 */
export async function createWiredDesign(
  adapter: PersistenceAdapter,
  design: CableDesign,
): Promise<LifecycleResult> {
  const bad = checkName(design.id, design.label);
  if (bad !== undefined) return bad;
  if (design.src.trim() === '') {
    return refuse(
      'This design needs to say where its information comes from.',
      'Name the document, the measurement or the board you are working from — or say that the values are inferred.',
    );
  }
  return settle(await adapter.create(design), (stored) => ({
    ok: true,
    change: { kind: 'created', design: stored },
    status: `created ${stored.id}`,
  }));
}

/** Save As: the same cable under a new id, with its descent recorded by the host. */
export async function duplicateDesign(
  adapter: PersistenceAdapter,
  from: string,
  fields: { id: string; label: string },
): Promise<LifecycleResult> {
  const bad = checkName(fields.id, fields.label);
  if (bad !== undefined) return bad;
  return settle(await adapter.duplicate(from, fields.id, fields.label.trim()), (design) => ({
    ok: true,
    change: { kind: 'duplicated', design, from },
    status: `copied ${from} to ${design.id}`,
  }));
}

export async function renameDesign(
  adapter: PersistenceAdapter,
  from: string,
  fields: { id: string; label: string },
): Promise<LifecycleResult> {
  const bad = checkName(fields.id, fields.label);
  if (bad !== undefined) return bad;
  return settle(await adapter.rename(from, fields.id, fields.label.trim()), (design) => ({
    ok: true,
    change: { kind: 'renamed', design, from },
    status: from === design.id ? `renamed ${design.id}` : `renamed ${from} to ${design.id}`,
  }));
}

/**
 * Delete, confirmed.
 *
 * `confirmation` is what the user typed (or the id the confirm button carried);
 * it has to be the design's own id. The check runs here as well as at the host
 * so the dialog can refuse without a round trip, and the host's copy is what
 * actually protects the file.
 */
export async function deleteDesign(
  adapter: PersistenceAdapter,
  id: string,
  confirmation: string,
): Promise<LifecycleResult> {
  if (confirmation !== id) {
    return refuse(
      `Nothing was deleted — '${id}' was not confirmed.`,
      `To delete this design, confirm its id exactly: ${id}`,
    );
  }
  return settle(await adapter.remove(id, confirmation), () => ({
    ok: true,
    change: { kind: 'deleted', id },
    status: `deleted ${id}`,
  }));
}
