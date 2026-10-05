/**
 * The editor store.
 *
 * **The CableDesign is the state.** React Flow's graph is never authoritative:
 * every user gesture is turned into a candidate `CableDesign`, handed to
 * `validateDesign`, and either committed whole or rejected whole with the
 * validator's own message. There is no path in this file that mutates the
 * design without passing through `commit`, so the canvas can never hold a fact
 * the model does not.
 *
 * Presentation state (dragged positions, selection) lives beside the design,
 * never inside it — the design document has no coordinates by design.
 *
 * Undo history follows from that same discipline: every accepted commit pushes
 * the design it replaced onto `past`, so the stack is a list of documents the
 * validator has already approved. Nothing else writes it — a rejected candidate
 * leaves no trace. A node drag (presentation, not fact) goes on the same stack
 * as a *move* entry: one per gesture, carrying the
 * arrangement before it and no design change, so Ctrl+Z after a drag puts the
 * parts back rather than undoing the last edit. Coordinates never enter the
 * design snapshots.
 */

import {
  addInstance,
  addJoint,
  describeJointMove,
  designInstances,
  dropUnlandedPigtails,
  errors,
  findInstance,
  moveJointEnds,
  nextInstanceId,
  parseDesignJson,
  removeInstance,
  removeJoint,
  removeJoints,
  terminalKey,
  updateInstance,
  validateDesign,
  warnings,
  type CableDesign,
  type Db,
  type InstanceKind,
  type InstancePatch,
  type Issue,
  type JointEndMove,
  type ParseResult,
  type TerminalRef,
} from '@wirehub/model';
import type { DepictionSource } from '@wirehub/render-svg';

import { autoLayout, mountsOf, vacantPosition, type XY } from './derive.ts';
import { connectTerminals, editPigtails, type PigtailEdit } from './pigtail-edit.ts';

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export type Selection =
  | { kind: 'instance'; id: string }
  | { kind: 'terminal'; ref: TerminalRef }
  | { kind: 'joint'; index: number }
  /**
   * Several joints drawn as one edge — a ground bundle (every shield and drain
   * of one wire end landing on one terminal). Clicking the bundle selects its
   * members; Delete unsolders them all in one undoable step.
   */
  | { kind: 'joints'; indices: number[] };

/**
 * One step on the undo stack: the design as it stood **before** an accepted
 * edit, labelled with what that edit did. Undoing entry `n` therefore restores
 * `n.design` and can honestly say "Undo: {n.description}".
 *
 * Whole documents, not diffs: `commit` already replaces the design wholesale
 * with a validated candidate, so a snapshot is exact by construction and needs
 * no replay machinery. The designs are structurally shared — an edit rebuilds
 * one list, not the tree — so a hundred of them is cheap.
 */
export interface HistoryEntry {
  design: CableDesign;
  /** the `commit` description of the edit this entry undoes */
  description: string;
  /**
   * A move entry (a drag gesture, auto-arrange): the arrangement to restore.
   * Its `design` is the one the move happened on — unchanged by it.
   */
  positions?: Record<string, XY>;
}

/** How many undo steps are kept; the oldest fall off the bottom. */
export const HISTORY_LIMIT = 100;

export interface EditorState {
  /** the definition library; read-only for the editor */
  db: Db;
  /** the single source of truth */
  design: CableDesign;
  /** `validateDesign(design, db)` for the committed design — always in sync */
  issues: Issue[];
  /** presentation only: where the open design's nodes sit */
  positions: Record<string, XY>;
  /**
   * Every arrangement this editor has, keyed by design id — including the open
   * one's, which is `positions`.
   *
   * The arrangement of a cable is work: it is how the person who drew it laid
   * the parts out to read them. It survives a save, a reload of the same
   * document, and a trip to another design and back, because none of those
   * change where the parts belong. A host that wants it to survive the *page*
   * hands the editor an `EditorLayoutStore`; see `layout-store.ts`.
   */
  layouts: Record<string, Record<string, XY>>;
  selection: Selection | undefined;
  /**
   * The artwork board nodes draw from, so auto-arrange reserves the size a
   * board node really draws at. Presentation only, like `positions`.
   */
  depictions?: DepictionSource;
  /** why the last edit was refused; cleared by the next accepted edit */
  rejection: string | undefined;
  /** what the last accepted edit did, for the status line */
  lastAccepted: string | undefined;
  /** accepted designs before the current one, oldest first; `undo` pops the end */
  past: HistoryEntry[];
  /** designs undone away, nearest first; any new edit discards them */
  future: HistoryEntry[];
  /** the arrangement when the current drag gesture began (`begin-move`) */
  moveStart?: Record<string, XY>;
}

export type EditorAction =
  /**
   * Open a design. `positions` is the arrangement the *host* remembers for it
   * (from localStorage, a user record, wherever) and wins over anything this
   * editor has seen; without one, an arrangement already in `layouts` is used,
   * and only a design neither of them knows is auto-arranged. Re-opening the
   * design that is already open — which is what a host does when it echoes an
   * accepted edit back, or hands back what it just saved — never moves a part.
   */
  | { type: 'load-design'; design: CableDesign; positions?: Record<string, XY> }
  /** lay the open design out from scratch: the "Auto-arrange" button */
  | { type: 'auto-arrange' }
  /**
   * A fresh definition library, after the host stored a definition edit.
   *
   * The design is left exactly as it is — it names definitions by id and those
   * ids have not moved — but everything read *through* the library has to be
   * recomputed, `issues` above all: a pin this cable solders to may have just
   * been renamed out from under it, and the editor has to say so.
   */
  | { type: 'load-db'; db: Db }
  | { type: 'select'; selection: Selection | undefined }
  | { type: 'add-instance'; kind: InstanceKind; def: string; position?: XY }
  /**
   * The node picker's insert: a fresh instance, placed
   * beside `anchor`'s own instance (its joint to `anchor` puts it in the next
   * column — see `vacantPosition`), and — only when `wireTerminal` is given —
   * soldered to `anchor` in the same step. One commit, one undo entry, whether
   * or not it wires: "insert" and "insert and wire" are not two edits stacked,
   * they are one candidate design validated once.
   */
  | {
      type: 'add-instance-near';
      kind: InstanceKind;
      def: string;
      anchor?: TerminalRef;
      wireTerminal?: { terminal: string; end?: 'a' | 'b' };
    }
  | { type: 'delete-instance'; id: string }
  /**
   * Several instances in one step — what React Flow hands `onNodesDelete`
   * when a board's docked connector is swept along with it (a child node
   * cascades with its parent). One commit, one undo entry: see
   * `keepDockedConnectors` for what actually gets removed.
   */
  | { type: 'delete-instances'; ids: string[] }
  | { type: 'add-joint'; a: TerminalRef; b: TerminalRef }
  | { type: 'delete-joint'; index: number }
  /**
   * Re-pin: move one end of each of these joints to another terminal.
   * The joints keep their place in the list and their other end; their note
   * is cleared from the builder and kept in the history instead — the edit's
   * description is "moved … from … to … (note was: …)".
   * One commit, one undo step, validated whole like any other edit.
   */
  | { type: 'move-joint-ends'; moves: JointEndMove[] }
  /**
   * Unsolder several joints in one step (a ground bundle) — and/or single
   * braids out of their pigtails (`braids`: a braid's canvas edge carries its
   * pigtail's landing joint, but deleting it takes only that braid out of the
   * twist; a pigtail left with none goes with its landing). One commit.
   */
  | {
      type: 'delete-joints';
      indices: number[];
      braids?: { segment: string; end: 'a' | 'b'; id: string; member: string }[];
    }
  | { type: 'update-instance'; id: string; patch: InstancePatch }
  /** edit a joint's own note — the Connection tab's inline note edit */
  | { type: 'update-joint'; index: number; patch: { note?: string | undefined } }
  /** replace the design-level notes; blank lines are dropped, none left = no `notes` */
  | { type: 'set-notes'; notes: string[] }
  /** the hand labour to build one cable, in minutes (the BOM's cost roll-up); `undefined` removes it */
  | { type: 'set-labour'; minutes: number | undefined }
  | { type: 'set-tags'; tags: string[] }
  /** the Connection tab's pigtail tools: new / split / merge / move / pad (shield bonding) */
  | { type: 'edit-pigtails'; edit: PigtailEdit }
  | { type: 'move-node'; id: string; position: XY }
  /**
   * A drag gesture's ends: `begin-move` remembers the
   * arrangement, `end-move` puts one move entry on the undo stack if anything
   * actually moved — the per-frame `move-node`s between them write none.
   */
  | { type: 'begin-move' }
  | { type: 'end-move'; ids?: string[] }
  | { type: 'import-json'; json: string }
  /**
   * Replace the design in one undoable step: an edit a module computed for
   * the whole body (`record: false` — the module already recorded what
   * changed), or a batch of joints (`record: true`, passed through the
   * host's commit hook like any other edit). Parts it adds are placed; parts
   * it keeps stay put.
   */
  | { type: 'apply-design'; design: CableDesign; description: string; record?: boolean }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'dismiss-rejection' }
  /**
   * The board artwork the canvas draws with changed (the host handed a new
   * source, or an upload landed). Presentation only: no history, no
   * re-arrangement — it only changes what the *next* auto-arrange measures.
   */
  | { type: 'set-depictions'; depictions: DepictionSource | undefined };

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

/**
 * @param positions the arrangement the host remembers for this design, if any;
 *   without one the design is auto-arranged, which is what "first open" means.
 */
export function initialEditorState(
  design: CableDesign,
  db: Db,
  positions?: Record<string, XY>,
  depictions?: DepictionSource,
): EditorState {
  const placed = positions ?? autoLayout(design, db, depictions).positions;
  return {
    ...(depictions === undefined ? {} : { depictions }),
    db,
    design,
    issues: validateDesign(design, db),
    positions: placed,
    layouts: { [design.id]: placed },
    selection: undefined,
    rejection: undefined,
    lastAccepted: undefined,
    past: [],
    future: [],
  };
}

/* ------------------------------------------------------------------ *
 * The invariant
 * ------------------------------------------------------------------ */

/**
 * One issue as a sentence: the validator's own words, plus where it found the
 * problem. The `code` is deliberately left out — `unknown-def` means nothing to
 * the person holding the soldering iron, and the message already says it.
 */
export function describeIssue(issue: Issue): string {
  return issue.where === undefined ? issue.message : `${issue.message} (${issue.where})`;
}

/** One sentence per blocking issue — what a "this cannot be saved" list shows. */
export function explainIssues(issues: Issue[]): string[] {
  return errors(issues).map(describeIssue);
}

/**
 * One sentence per warning — the things that do not stop a save but ought to
 * be said out loud at the moment it happens.
 *
 * A cable being built up is legitimately incomplete, so warnings never block;
 * that is exactly why they are easy to miss. `DesignActions` reads this list
 * before writing and makes the user say "save anyway" to it.
 */
export function explainWarnings(issues: Issue[]): string[] {
  return warnings(issues).map(describeIssue);
}

/** The validator's own words, joined — never a message the editor invented. */
export function describeErrors(issues: Issue[]): string {
  return explainIssues(issues).join('; ');
}

/** `past` with one more entry, oldest dropped once the cap is reached. */
function pushHistory(past: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  const next = [...past, entry];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * The one door into `state.design`.
 *
 * A candidate design that validates without errors replaces the old one, and
 * `issues` is refreshed in the same step so the two can never disagree. A
 * candidate that introduces an error is dropped whole — the previous design,
 * issues and positions survive untouched — and the validator's message is
 * surfaced verbatim.
 *
 * Because this is the only door, it is also the only writer of undo history:
 * the design being replaced is pushed onto `past` with this edit's description,
 * and `future` is discarded — a rejected candidate never reaches either, so the
 * stack holds none but validated states.
 */
/**
 * `design` with these design-level notes, keys in file order — `notes` sits
 * after `joints`, before `src` (and `extensions` stays the last member); an
 * empty list removes the key.
 */
export function withNotes(design: CableDesign, notes: string[]): CableDesign {
  const out: Record<string, unknown> = {};
  let placed = false;
  for (const [key, value] of Object.entries(design)) {
    if (key === 'notes') {
      if (notes.length > 0) out['notes'] = notes;
      placed = true;
      continue;
    }
    if (!placed && (key === 'src' || key === 'extensions')) {
      if (notes.length > 0) out['notes'] = notes;
      placed = true;
    }
    out[key] = value;
  }
  if (!placed && notes.length > 0) out['notes'] = notes;
  return out as unknown as CableDesign;
}

/**
 * A module's say in every committed edit: given the design before, the
 * proposed design and the edit's description, it returns the design to
 * commit (a recipe module records the physical change as overrides). Set
 * once at start-up by the host (`setCommitHook`); none by default.
 */
export type CommitHook = (before: CableDesign, proposed: CableDesign, description: string) => CableDesign;

let commitHook: CommitHook | undefined;

/** Install (or with `undefined`, remove) the commit hook. */
export function setCommitHook(hook: CommitHook | undefined): void {
  commitHook = hook;
}

export function commit(
  state: EditorState,
  proposed: CableDesign,
  description: string,
  positions?: Record<string, XY>,
  capture = true,
): EditorState {
  // a module that derives designs records hand edits on its own data through
  // the commit hook (`docs/modules.md`); the base commits the body as proposed
  const hook = capture ? commitHook : undefined;
  const candidate = hook === undefined ? proposed : hook(state.design, proposed, description);
  const issues = validateDesign(candidate, state.db);
  const failures = errors(issues);
  if (failures.length > 0) {
    return {
      ...state,
      rejection: `${description} rejected — ${describeErrors(issues)}`,
    };
  }
  return {
    ...state,
    design: candidate,
    issues,
    ...(positions === undefined
      ? {}
      : { positions, layouts: { ...state.layouts, [candidate.id]: positions } }),
    rejection: undefined,
    lastAccepted: description,
    past: pushHistory(state.past, { design: state.design, description }),
    future: [],
  };
}

/**
 * Step back to the design before the last accepted edit.
 *
 * The restored document was validated when it was committed, but `issues` is
 * recomputed rather than remembered so the invariant "`issues` describes
 * `design`" holds by construction and not by bookkeeping. Positions are left
 * alone: they are presentation, they live beside the design, and an undo that
 * also moved the parts back would be a second, surprising edit.
 */
function undo(state: EditorState): EditorState {
  const entry = state.past[state.past.length - 1];
  if (entry === undefined) return state;
  if (entry.positions !== undefined) return restoreMove(state, entry, 'undo');
  return {
    ...state,
    design: entry.design,
    issues: validateDesign(entry.design, state.db),
    // a selected joint index or instance may not exist in the restored design
    selection: undefined,
    rejection: undefined,
    lastAccepted: `undo ${entry.description}`,
    past: state.past.slice(0, -1),
    future: [{ design: state.design, description: entry.description }, ...state.future],
  };
}

function redo(state: EditorState): EditorState {
  const [entry, ...rest] = state.future;
  if (entry === undefined) return state;
  if (entry.positions !== undefined) return restoreMove(state, entry, 'redo');
  return {
    ...state,
    design: entry.design,
    issues: validateDesign(entry.design, state.db),
    selection: undefined,
    rejection: undefined,
    lastAccepted: `redo ${entry.description}`,
    past: pushHistory(state.past, { design: state.design, description: entry.description }),
    future: rest,
  };
}

/** Undo or redo a move entry: the arrangement swaps, the design stays. */
function restoreMove(state: EditorState, entry: HistoryEntry, way: 'undo' | 'redo'): EditorState {
  const positions = entry.positions!;
  const back: HistoryEntry = { design: state.design, description: entry.description, positions: state.positions };
  return {
    ...state,
    positions,
    layouts: { ...state.layouts, [state.design.id]: positions },
    rejection: undefined,
    lastAccepted: `${way} ${entry.description}`,
    past: way === 'undo' ? state.past.slice(0, -1) : pushHistory(state.past, back),
    future: way === 'undo' ? [back, ...state.future] : state.future.slice(1),
  };
}

/** A move entry for the gesture that turned `before` into `after`, or nothing if nothing moved. */
function moveEntry(state: EditorState, before: Record<string, XY>, after: Record<string, XY>, description: string): EditorState {
  const moved = Object.keys({ ...before, ...after }).filter((id) => before[id]?.x !== after[id]?.x || before[id]?.y !== after[id]?.y);
  if (moved.length === 0) return state;
  const text = description !== '' ? description : moved.length === 1 ? `move ${moved[0]}` : `move ${moved.length} parts`;
  return { ...state, past: pushHistory(state.past, { design: state.design, description: text, positions: before }), future: [] };
}

/** What `undo` would reverse, for a button label. `undefined` when there is nothing. */
export function undoDescription(state: EditorState): string | undefined {
  return state.past[state.past.length - 1]?.description;
}

/** What `redo` would reapply, for a button label. */
export function redoDescription(state: EditorState): string | undefined {
  return state.future[0]?.description;
}

function reject(state: EditorState, message: string): EditorState {
  return { ...state, rejection: message };
}

/* ------------------------------------------------------------------ *
 * Design edits — pure `CableDesign → CableDesign`
 *
 * `addInstance`/`removeInstance`/`addJoint`/`removeJoint`/`removeJoints`/
 * `updateInstance`, `nextInstanceId`'s shop naming, and `dropUnlandedPigtails`
 * live in `@wirehub/model` — every writer of a
 * design document needs the same semantics, not just this editor. Re-exported
 * here so existing imports from this module (and from this package's index)
 * keep working unchanged.
 * ------------------------------------------------------------------ */

export {
  addInstance,
  addJoint,
  dropUnlandedPigtails,
  nextInstanceId,
  parseDesignJson,
  removeInstance,
  removeJoint,
  removeJoints,
  updateInstance,
};
export type { InstancePatch, ParseResult };

/**
 * Of a batch of instances slated for deletion, the ones that should actually
 * go: a connector docked on a board in the same batch survives — it is a
 * separately purchased part, not part of the board, so deleting the board
 * only desolders it (its joints to the board go with the board; any other
 * joint it carries, and its own place on the canvas, are untouched).
 *
 * This is what makes "delete a docked board" one undo step instead of two:
 * React Flow's `onNodesDelete` hands the whole cascade (the board and the
 * child connector node it swept along) to one `delete-instances` dispatch,
 * and this decides which of those ids the design actually loses.
 */
export function keepDockedConnectors(design: CableDesign, ids: readonly string[]): string[] {
  const batch = new Set(ids);
  const mounts = mountsOf(design);
  return ids.filter((id) => {
    const mount = mounts.get(id);
    return mount === undefined || !batch.has(mount.board);
  });
}

/** A joint with its note added, changed or cleared — nothing else about it moves. */
export function updateJointNote(
  design: CableDesign,
  index: number,
  note: string | undefined,
): CableDesign {
  return {
    ...design,
    joints: design.joints.map((joint, at) => {
      if (at !== index) return joint;
      if (note === undefined || note === '') {
        const { note: _dropped, ...rest } = joint;
        return rest;
      }
      return { ...joint, note };
    }),
  };
}

/** Both orderings of a pair, as the joint list would key them. */
export function jointIndexFor(design: CableDesign, a: TerminalRef, b: TerminalRef): number {
  const keyA = terminalKey(a);
  const keyB = terminalKey(b);
  return design.joints.findIndex((joint) => {
    const x = terminalKey(joint.a);
    const y = terminalKey(joint.b);
    return (x === keyA && y === keyB) || (x === keyB && y === keyA);
  });
}

/* ------------------------------------------------------------------ *
 * Serialization
 *
 * `parseDesignJson`/`ParseResult` moved to `@wirehub/model`
 * and are re-exported above; `exportDesignJson` stays
 * here — trivial and not part of that move.
 * ------------------------------------------------------------------ */

export function exportDesignJson(design: CableDesign): string {
  return `${JSON.stringify(design, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'load-design': {
      const issues = validateDesign(action.design, state.db);
      // the arrangement, in order of authority: what the host remembers, what
      // this editor already had for this design, and — only for a document
      // neither has ever placed — a fresh auto-layout. Re-opening the design
      // that is already open keeps exactly what is on screen.
      const remembered =
        action.design.id === state.design.id
          ? state.positions
          : (action.positions ?? state.layouts[action.design.id]);
      const positions = remembered ?? autoLayout(action.design, state.db, state.depictions).positions;
      return {
        ...state,
        design: action.design,
        issues,
        positions,
        layouts: {
          ...state.layouts,
          // the design being closed keeps its arrangement for the way back
          [state.design.id]: state.positions,
          [action.design.id]: positions,
        },
        selection: undefined,
        rejection:
          errors(issues).length === 0
            ? undefined
            : `loaded design has errors — ${describeErrors(issues)}`,
        lastAccepted: `loaded ${action.design.id}`,
        // history is per-design: the steps that led here belong to the document
        // being closed, and undoing across the swap would resurrect it
        past: [],
        future: [],
      };
    }

    case 'load-db': {
      // the design is not an edit and does not go on the undo stack: nothing
      // the user did changed, the ground under it did
      const issues = validateDesign(state.design, action.db);
      return { ...state, db: action.db, issues };
    }

    case 'undo':
      return undo(state);

    case 'redo':
      return redo(state);

    case 'select':
      return { ...state, selection: action.selection };

    case 'begin-move':
      return { ...state, moveStart: state.positions };

    case 'end-move': {
      const { moveStart, ...rest } = state;
      if (moveStart === undefined) return state;
      return moveEntry(rest, moveStart, state.positions, '');
    }

    case 'move-node': {
      // no history per frame: a drag writes one move entry, at `end-move`
      const positions = { ...state.positions, [action.id]: action.position };
      return {
        ...state,
        positions,
        layouts: { ...state.layouts, [state.design.id]: positions },
      };
    }

    case 'auto-arrange': {
      // the one gesture that is allowed to move parts the user placed, because
      // the user asked for it by name
      const positions = autoLayout(state.design, state.db, state.depictions).positions;
      return {
        ...moveEntry(state, state.positions, positions, 'auto-arrange'),
        positions,
        layouts: { ...state.layouts, [state.design.id]: positions },
        lastAccepted: 'auto-arranged the canvas',
      };
    }

    case 'dismiss-rejection':
      return { ...state, rejection: undefined };

    case 'set-depictions': {
      if (state.depictions === action.depictions) return state;
      const { depictions: _previous, ...rest } = state;
      return action.depictions === undefined ? rest : { ...rest, depictions: action.depictions };
    }

    case 'add-instance': {
      const id = nextInstanceId(state.design, action.kind, action.def);
      const next = addInstance(state.design, action.kind, action.def, id);
      // dropped: exactly where it was dropped. Added from the palette's button:
      // its auto-layout column, dropped down past whatever is already there —
      // a new part must never land on top of an existing one.
      const spot = action.position ?? vacantPosition(next, state.db, id, state.positions, state.depictions);
      const positions = { ...state.positions, [id]: spot };
      const committed = commit(state, next, `add ${action.kind} ${action.def} as ${id}`, positions);
      return committed.design !== state.design
        ? { ...committed, selection: { kind: 'instance', id } }
        : committed;
    }

    case 'add-instance-near': {
      const id = nextInstanceId(state.design, action.kind, action.def);
      let next = addInstance(state.design, action.kind, action.def, id);
      let description = `add ${action.kind} ${action.def} as ${id}`;
      if (action.anchor !== undefined && action.wireTerminal !== undefined) {
        const b: TerminalRef = {
          instance: id,
          terminal: action.wireTerminal.terminal,
          ...(action.wireTerminal.end === undefined ? {} : { end: action.wireTerminal.end }),
        };
        next = addJoint(next, action.anchor, b);
        description = `${description}, wired to ${terminalKey(action.anchor)}`;
      }
      // the new instance's own joint to `anchor` (when there is one) already
      // puts it in the right column — see `vacantPosition`'s module note
      const spot = vacantPosition(next, state.db, id, state.positions, state.depictions);
      const positions = { ...state.positions, [id]: spot };
      const committed = commit(state, next, description, positions);
      return committed.design !== state.design
        ? { ...committed, selection: { kind: 'instance', id } }
        : committed;
    }

    case 'delete-instance': {
      if (findInstance(state.design, action.id) === undefined) {
        return reject(state, `delete rejected — no instance '${action.id}'`);
      }
      const next = removeInstance(state.design, action.id);
      const committed = commit(state, next, `delete instance ${action.id}`);
      return committed.design !== state.design ? { ...committed, selection: undefined } : committed;
    }

    case 'delete-instances': {
      const ids = [...new Set(action.ids)];
      if (ids.length === 0) return state;
      if (ids.length === 1) {
        const only = ids[0];
        return only === undefined ? state : editorReducer(state, { type: 'delete-instance', id: only });
      }
      const missing = ids.find((id) => findInstance(state.design, id) === undefined);
      if (missing !== undefined) {
        return reject(state, `delete rejected — no instance '${missing}'`);
      }
      const toDelete = keepDockedConnectors(state.design, ids);
      const next = toDelete.reduce((design, id) => removeInstance(design, id), state.design);
      const description =
        toDelete.length === 1 ? `delete instance ${toDelete[0]}` : `delete ${toDelete.length} instances`;
      const committed = commit(state, next, description);
      return committed.design !== state.design ? { ...committed, selection: undefined } : committed;
    }

    case 'add-joint': {
      const keyA = terminalKey(action.a);
      const keyB = terminalKey(action.b);
      if (keyA === keyB) {
        return reject(state, `joint rejected — '${keyA}' cannot be soldered to itself`);
      }
      // a braid dragged onto a pad, or a pigtail onto another pad: one whole,
      // physically coherent edit, never a half-way state
      // the validator refuses
      const coherent = connectTerminals(state.design, state.db, action.a, action.b);
      if (coherent !== undefined) {
        if (!coherent.ok) return reject(state, `joint rejected — ${coherent.reason}`);
        return commit(state, coherent.design, coherent.description);
      }
      if (jointIndexFor(state.design, action.a, action.b) !== -1) {
        return reject(state, `joint rejected — '${keyA}' and '${keyB}' are already jointed`);
      }
      const next = addJoint(state.design, action.a, action.b);
      const committed = commit(state, next, `joint ${keyA} ↔ ${keyB}`);
      return committed.design !== state.design
        ? {
            ...committed,
            selection: { kind: 'joint', index: next.joints.length - 1 },
          }
        : committed;
    }

    case 'delete-joint': {
      const joint = state.design.joints[action.index];
      if (joint === undefined) {
        return reject(state, `delete rejected — no joint at index ${action.index}`);
      }
      const next = removeJoint(state.design, action.index);
      const committed = commit(
        state,
        next,
        `unsolder ${terminalKey(joint.a)} ↔ ${terminalKey(joint.b)}`,
      );
      return committed.design !== state.design ? { ...committed, selection: undefined } : committed;
    }

    case 'move-joint-ends': {
      const moves: JointEndMove[] = [];
      const described: string[] = [];
      for (const move of action.moves) {
        const joint = state.design.joints[move.index];
        if (joint === undefined) return reject(state, `re-pin rejected — no joint at index ${move.index}`);
        const from = joint[move.side];
        const other = joint[move.side === 'a' ? 'b' : 'a'];
        // dropped back where it was: nothing to do, nothing to undo
        if (terminalKey(from) === terminalKey(move.to) && from.pad === move.to.pad) continue;
        if (terminalKey(other) === terminalKey(move.to)) {
          return reject(state, `re-pin rejected — '${terminalKey(move.to)}' cannot be soldered to itself`);
        }
        moves.push(move);
        // the change log carries the note the move clears
        described.push(describeJointMove(state.design, move) ?? `moved ${terminalKey(other)}`);
      }
      if (moves.length === 0) return state;
      const next = moveJointEnds(state.design, moves);
      // the moved joint must not now duplicate another one
      const moved = new Set(moves.map((move) => move.index));
      for (const index of moved) {
        const joint = next.joints[index];
        if (joint === undefined) continue;
        const twin = next.joints.findIndex(
          (other, at) =>
            at !== index &&
            ((terminalKey(other.a) === terminalKey(joint.a) && terminalKey(other.b) === terminalKey(joint.b)) ||
              (terminalKey(other.a) === terminalKey(joint.b) && terminalKey(other.b) === terminalKey(joint.a))),
        );
        if (twin !== -1) {
          return reject(
            state,
            `re-pin rejected — '${terminalKey(joint.a)}' and '${terminalKey(joint.b)}' are already jointed`,
          );
        }
      }
      return commit(state, next, described.join('; '));
    }

    case 'delete-joints': {
      if (action.braids !== undefined && action.braids.length > 0) {
        // braids first (by pigtail), then the plain joints — one candidate
        let next = state.design;
        const byPigtail = new Map<string, { segment: string; end: 'a' | 'b'; id: string; members: string[] }>();
        const landings: number[] = [];
        for (const braid of action.braids) {
          // a bonded-mass pigtail (no member list: every screen of the stock)
          // is drawn as one braid; unsoldering it unsolders the landing, and
          // the pigtail goes with it
          const pigtail = state.design.instances.segments
            .find((segment) => segment.id === braid.segment)
            ?.pigtails?.find((p) => p.id === braid.id && p.end === braid.end);
          if (pigtail !== undefined && pigtail.members === undefined) {
            const key = terminalKey({ instance: braid.segment, terminal: `pigtail:${braid.id}`, end: braid.end });
            state.design.joints.forEach((joint, index) => {
              if (terminalKey(joint.a) === key || terminalKey(joint.b) === key) landings.push(index);
            });
            continue;
          }
          const key = `${braid.segment}|${braid.end}|${braid.id}`;
          const entry = byPigtail.get(key) ?? { segment: braid.segment, end: braid.end, id: braid.id, members: [] };
          if (!entry.members.includes(braid.member)) entry.members.push(braid.member);
          byPigtail.set(key, entry);
        }
        const plain = new Set(
          [...action.indices, ...landings].map((index) => state.design.joints[index]).filter((joint) => joint !== undefined),
        );
        const described: string[] = [];
        for (const entry of byPigtail.values()) {
          const result = editPigtails(next, state.db, { op: 'drop', ...entry });
          if (!result.ok) return reject(state, `delete rejected — ${result.reason}`);
          next = result.design;
          described.push(result.description);
        }
        const survivors = next.joints.filter((joint) => !plain.has(joint));
        if (survivors.length !== next.joints.length) {
          described.push(`unsolder ${next.joints.length - survivors.length} joint(s)`);
          next = dropUnlandedPigtails({ ...next, joints: survivors });
        }
        const committed = commit(state, next, described.join('; '));
        return committed.design !== state.design ? { ...committed, selection: undefined } : committed;
      }
      const indices = [...new Set(action.indices)].sort((p, q) => p - q);
      if (indices.length === 0) return state;
      const missing = indices.find((index) => state.design.joints[index] === undefined);
      if (missing !== undefined) {
        return reject(state, `delete rejected — no joint at index ${missing}`);
      }
      if (indices.length === 1) {
        return editorReducer(state, { type: 'delete-joint', index: indices[0] ?? 0 });
      }
      const next = removeJoints(state.design, indices);
      const committed = commit(state, next, `unsolder ${indices.length} joints`);
      return committed.design !== state.design ? { ...committed, selection: undefined } : committed;
    }

    case 'update-instance': {
      if (findInstance(state.design, action.id) === undefined) {
        return reject(state, `edit rejected — no instance '${action.id}'`);
      }
      const next = updateInstance(state.design, action.id, action.patch);
      return commit(state, next, `edit ${action.id}`);
    }

    case 'update-joint': {
      const joint = state.design.joints[action.index];
      if (joint === undefined) {
        return reject(state, `edit rejected — no joint at index ${action.index}`);
      }
      const next = updateJointNote(state.design, action.index, action.patch.note);
      return commit(state, next, `edit joint ${terminalKey(joint.a)} ↔ ${terminalKey(joint.b)}`);
    }

    case 'set-notes': {
      const notes = action.notes.map((note) => note.trim()).filter((note) => note !== '');
      const before = state.design.notes ?? [];
      if (notes.length === before.length && notes.every((note, i) => note === before[i])) return state;
      const next = withNotes(state.design, notes);
      const verb = notes.length > before.length ? 'add a design note' : notes.length < before.length ? 'remove a design note' : 'edit design notes';
      return commit(state, next, verb);
    }

    case 'set-labour': {
      const minutes = action.minutes;
      if (minutes !== undefined && !(Number.isFinite(minutes) && minutes >= 0)) return reject(state, 'labour minutes must be zero or more');
      if (state.design.labourMinutes === minutes) return state;
      const { labourMinutes: _old, ...rest } = state.design;
      const next: CableDesign =
        minutes === undefined
          ? (rest as CableDesign)
          : (Object.fromEntries(Object.entries(rest).flatMap(([key, value]) => (key === 'src' ? [['labourMinutes', minutes], [key, value]] : [[key, value]]))) as unknown as CableDesign);
      return commit(state, next, minutes === undefined ? 'remove the labour time' : 'set the labour time');
    }

    case 'set-tags': {
      const tags = [...new Set(action.tags.map((t) => t.trim()).filter((t) => t !== ''))];
      const before = state.design.tags ?? [];
      if (tags.length === before.length && tags.every((t, i) => t === before[i])) return state;
      if (tags.some((t) => !/^[A-Za-z0-9][A-Za-z0-9 _.\-/]{0,39}$/.test(t)) || tags.length > 50) return reject(state, 'a tag is a short word: letters, digits, spaces, dash, dot or slash, up to 40 characters');
      const { tags: _old, ...rest } = state.design;
      const next: CableDesign =
        tags.length === 0
          ? (rest as CableDesign)
          : (Object.fromEntries(Object.entries(rest).flatMap(([key, value]) => (key === 'src' ? [['tags', tags], [key, value]] : [[key, value]]))) as unknown as CableDesign);
      return commit(state, next, tags.length === 0 ? 'remove the design tags' : 'set the design tags');
    }

    case 'edit-pigtails': {
      const result = editPigtails(state.design, state.db, action.edit);
      if (!result.ok) return reject(state, `pigtail edit rejected — ${result.reason}`);
      return commit(state, result.design, result.description);
    }

    case 'apply-design': {
      // breakout moulds are drawn nodes too
      const moulds = (action.design.instances.breakouts ?? []).map((b) => b.id);
      const ids = [...designInstances(action.design).map((i) => i.id), ...moulds];
      const missing = ids.filter((id) => state.positions[id] === undefined);
      let positions: Record<string, XY> | undefined;
      if (missing.length > 0) {
        const fresh = autoLayout(action.design, state.db, state.depictions).positions;
        positions = Object.fromEntries(ids.map((id) => [id, state.positions[id] ?? fresh[id] ?? { x: 0, y: 0 }]));
        // a part a breakout edit adds drops clear of what is already placed
        if (moulds.some((id) => missing.includes(id)) && Object.keys(state.positions).length > 0) {
          for (const id of missing) positions[id] = vacantPosition(action.design, state.db, id, positions, state.depictions);
        }
      }
      return commit(state, action.design, action.description, positions, action.record === true);
    }

    case 'import-json': {
      const parsed = parseDesignJson(action.json);
      if (!parsed.ok) return reject(state, `import rejected — ${parsed.message}`);
      const issues = validateDesign(parsed.design, state.db);
      if (errors(issues).length > 0) {
        return reject(state, `import rejected — ${describeErrors(issues)}`);
      }
      const description = `imported ${parsed.design.id}`;
      // an imported document is a document nobody has arranged yet, even when
      // it carries a familiar id: its parts may be different parts
      const positions = autoLayout(parsed.design, state.db, state.depictions).positions;
      return {
        ...state,
        design: parsed.design,
        issues,
        positions,
        layouts: {
          ...state.layouts,
          [state.design.id]: state.positions,
          [parsed.design.id]: positions,
        },
        selection: undefined,
        rejection: undefined,
        lastAccepted: description,
        // an import replaces the document in one gesture, so it is one step:
        // undo puts the design the user was editing back
        past: pushHistory(state.past, { design: state.design, description }),
        future: [],
      };
    }
  }
}
