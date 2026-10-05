/**
 * The file backend's change history (cs-5k1.4): the git log of the catalog
 * directory, when it lives in a git work tree. With the git export on
 * (`WIREHUB_GIT_AUTOCOMMIT=true`, `backup/`) every save is a commit by the
 * person who made it; otherwise the log holds whatever commits people made
 * by hand. Read-only: `git log` and `git show`, never a write.
 *
 * Paths are relative to the catalog's `data/` directory (`git -C <data>`):
 * a design is `designs/<id>.json` and `drawings/<id>.json`, a library record
 * an element of `<kind>.json`, a list `vocab/<list>.json`, a build
 * `builds/<name>.json`.
 */

import { changedFields } from '../../src/history/diff.ts';
import {
  definitionNoun,
  definitionSubject,
  known,
  restorableParts,
  subjectKey,
  subjectLabel,
  UNKNOWN,
  type HistoryCapabilities,
  type HistoryEntry,
  type HistoryKind,
  type HistoryTouch,
  type Known,
  type RecordDiff,
  type Subject,
} from '../../src/history/types.ts';
import { LOCKABLE_DEFINITION_KINDS } from '../../src/locks/records.ts';
import { execGit, type GitRunner } from '../backup/git.ts';
import type { HistoryList, HistoryQuery, HistorySource, SubjectState } from './source.ts';
import { noHistorySource } from './source.ts';

export const GIT_HISTORY: HistoryCapabilities = {
  backend: 'git',
  note: 'History is the git log of the catalog. Saves are recorded as commits only while the git export is on (WIREHUB_GIT_AUTOCOMMIT=true); edits made with it off are not in the log.',
  perRecord: true,
  diff: true,
  restore: true,
  filters: { person: true, date: true, kind: true },
};

const SEP = '\u001f';
const END = '\u001e';
const FORMAT = `--format=${END}%H${SEP}%an${SEP}%ae${SEP}%aI${SEP}%B${SEP}`;
const SHA = /^[0-9a-f]{40}$/;
const DEFINITION_FILES = new Set<string>(LOCKABLE_DEFINITION_KINDS.map((k) => `${k}.json`));

/** The pathspecs of each hub-wide kind, relative to `data/`. */
const KIND_PATHS: Readonly<Record<HistoryKind, readonly string[]>> = {
  design: ['designs', 'drawings'],
  library: [...DEFINITION_FILES, 'wire-parts.json', 'wire-recipes.json', 'models.json'],
  vocab: ['vocab', 'tags/review.json'],
  builds: ['builds'],
  other: [':(exclude)designs', ':(exclude)drawings', ...[...DEFINITION_FILES, 'wire-parts.json', 'wire-recipes.json', 'models.json', 'vocab', 'tags/review.json', 'builds'].map((p) => `:(exclude)${p}`)],
};

interface Commit {
  sha: string;
  name: string;
  email: string;
  at: string;
  message: string;
  files: { status: string; path: string }[];
}

function parseLog(stdout: string): Commit[] {
  const out: Commit[] = [];
  for (const chunk of stdout.split(END)) {
    if (chunk.trim() === '') continue;
    const [sha = '', name = '', email = '', at = '', message = '', rest = ''] = chunk.split(SEP);
    const files = rest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .flatMap((l) => {
        const [status = '', ...paths] = l.split('\t');
        const path = paths[paths.length - 1];
        return path === undefined ? [] : [{ status: status.charAt(0), path }];
      });
    out.push({ sha: sha.trim(), name, email, at: new Date(at).toISOString(), message: message.trim(), files });
  }
  return out;
}

/** What a catalog path is, as a touch. */
function touchOfPath(path: string, status: string): HistoryTouch {
  const op: HistoryTouch['op'] = status === 'D' ? 'delete' : 'put';
  let m = /^designs\/([^/]+)\.json$/.exec(path);
  if (m !== null) return { subject: `design:${m[1]}`, label: `design ${m[1]}`, kind: 'design', op, part: 'design' };
  m = /^drawings\/([^/.]+)\.json$/.exec(path);
  if (m !== null) return { subject: `design:${m[1]}`, label: `design ${m[1]} (drawing details)`, kind: 'design', op, part: 'drawing' };
  m = /^drawings\/([^/.]+)\./.exec(path);
  if (m !== null) return { subject: `design:${m[1]}`, label: `design ${m[1]} (drawing photo)`, kind: 'design', op, part: 'photo' };
  m = /^designs\/_versions\/([^/]+)\//.exec(path);
  if (m !== null) return { subject: `design:${m[1]}`, label: `design ${m[1]} (saved versions)`, kind: 'design', op, part: 'versions' };
  if (DEFINITION_FILES.has(path)) return { subject: `other:definitions:${path.slice(0, -5)}`, label: `${path.slice(0, -5)} list`, kind: 'library', op, part: 'record' };
  m = /^vocab\/([^/]+)\.json$/.exec(path);
  if (m !== null) return { subject: `vocab:${m[1]}`, label: `list ${m[1]}`, kind: 'vocab', op, part: 'record' };
  m = /^builds\/([^/]+)\.json$/.exec(path);
  if (m !== null) return { subject: `build:${m[1]}`, label: `build ${m[1]}`, kind: 'builds', op, part: 'record' };
  if (['wire-parts.json', 'wire-recipes.json', 'models.json'].includes(path)) return { subject: `other:${path}`, label: path, kind: 'library', op };
  return { subject: `other:${path}`, label: path, kind: 'other', op };
}

/** The files a subject's parts live in. */
function subjectPaths(subject: Subject): { part: string; path: string; element?: string }[] {
  switch (subject.type) {
    case 'design':
      return [
        { part: 'design', path: `designs/${subject.id}.json` },
        { part: 'drawing', path: `drawings/${subject.id}.json` },
      ];
    case 'definition':
      return [{ part: 'record', path: `${subject.kind}.json`, element: subject.id }];
    case 'vocab':
      return [{ part: 'record', path: `vocab/${subject.list}.json` }];
    case 'build':
      return [{ part: 'record', path: `builds/${subject.name}.json` }];
  }
}

function elementOf(list: unknown, id: string): unknown {
  return Array.isArray(list) ? list.find((r) => typeof r === 'object' && r !== null && (r as { id?: unknown }).id === id) : undefined;
}

const PART_LABEL: Readonly<Record<string, string>> = { design: 'design', drawing: 'drawing details', record: 'record' };

export interface GitHistoryOptions {
  /** the catalog's `data/` directory */
  dataDir: string;
  git?: GitRunner;
}

/** The git source when `dataDir` is in a git work tree with commits, else the no-history source. */
export function gitHistorySource(options: GitHistoryOptions): HistorySource {
  const git = options.git ?? execGit;
  const cwd = options.dataDir;
  const run = async (args: string[]): Promise<{ code: number; stdout: string }> => {
    const out = await git(args, { cwd, timeoutMs: 30_000 });
    return { code: out.code, stdout: out.stdout };
  };
  let available: Promise<boolean> | undefined;
  const isAvailable = (): Promise<boolean> =>
    (available ??= (async () => {
      const inside = await run(['rev-parse', '--is-inside-work-tree']);
      if (inside.code !== 0 || inside.stdout.trim() !== 'true') return false;
      return (await run(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    })());
  const none = noHistorySource();

  /** The JSON at `rev:path`: known absent when the file is not there, unknown when it is not JSON. */
  async function show(rev: string, path: string): Promise<Known> {
    const out = await run(['show', `${rev}:./${path}`]);
    if (out.code !== 0) return known(undefined);
    try {
      return known(JSON.parse(out.stdout) as unknown);
    } catch {
      return UNKNOWN;
    }
  }

  async function parentOf(sha: string): Promise<string | undefined> {
    const out = await run(['rev-parse', '--verify', '-q', `${sha}^`]);
    return out.code === 0 ? out.stdout.trim() : undefined;
  }

  async function stepsOf(subject: Subject, sha: string): Promise<{ part: string; before: Known; after: Known }[]> {
    const parent = await parentOf(sha);
    const out: { part: string; before: Known; after: Known }[] = [];
    for (const p of subjectPaths(subject)) {
      let before = parent === undefined ? known(undefined) : await show(parent, p.path);
      let after = await show(sha, p.path);
      if (p.element !== undefined) {
        before = before.known ? known(elementOf(before.value, p.element)) : before;
        after = after.known ? known(elementOf(after.value, p.element)) : after;
      }
      if (before.known && after.known && JSON.stringify(before.value) === JSON.stringify(after.value)) continue;
      out.push({ part: p.part, before, after });
    }
    return out;
  }

  const entryOf = (c: Commit, touches: HistoryTouch[], more = 0): HistoryEntry => {
    const [first = '', ...rest] = c.message.split('\n');
    const body = rest.join('\n').trim();
    return {
      id: c.sha,
      at: c.at,
      by: { name: c.name, ...(c.email === '' ? {} : { email: c.email }) },
      source: 'git',
      message: first,
      ...(body === '' ? {} : { body }),
      touches,
      ...(more > 0 ? { more } : {}),
    };
  };

  const diffsOf = (subject: Subject, steps: { part: string; before: Known; after: Known }[]): RecordDiff[] => {
    const restorable = new Set(restorableParts(subject));
    return steps.map((s) => ({
      subject: subjectKey(subject),
      label: `${subjectLabel(subject)} — ${PART_LABEL[s.part] ?? s.part}`,
      part: s.part,
      op: !s.before.known || !s.after.known ? 'unknown' : s.before.value === undefined ? 'added' : s.after.value === undefined ? 'removed' : 'changed',
      before: s.before,
      after: s.after,
      restorable: restorable.has(s.part),
    }));
  };

  const touchesOfSteps = (subject: Subject, steps: { part: string; before: Known; after: Known }[]): HistoryTouch[] =>
    steps.map((s) => {
      const fields = s.before.known && s.after.known ? changedFields(s.before.value, s.after.value) : undefined;
      return {
        subject: subjectKey(subject),
        label: `${subjectLabel(subject)} — ${PART_LABEL[s.part] ?? s.part}`,
        kind: subject.type === 'design' ? 'design' : subject.type === 'definition' ? 'library' : subject.type === 'vocab' ? 'vocab' : 'builds',
        op: s.after.known && s.after.value === undefined ? 'delete' : 'put',
        part: s.part,
        ...(fields === undefined ? {} : { fields }),
      };
    });

  return {
    capabilities: async () => ((await isAvailable()) ? GIT_HISTORY : none.capabilities()),

    async list(query: HistoryQuery): Promise<HistoryList> {
      if (!(await isAvailable())) return none.list(query);
      const start = query.before !== undefined && SHA.test(query.before) ? `${query.before}^` : 'HEAD';
      const args = ['log', FORMAT, '--name-status', '--no-renames', '--relative', `-n${query.limit + 1}`];
      if (query.person !== undefined && query.person.trim() !== '') args.push('--fixed-strings', '--regexp-ignore-case', `--author=${query.person.trim()}`);
      if (query.from !== undefined) args.push(`--since=${query.from}T00:00:00`);
      if (query.to !== undefined) args.push(`--until=${query.to}T23:59:59`);
      args.push(start, '--', ...(query.kind === undefined ? ['.'] : query.kind === 'other' ? ['.', ...KIND_PATHS.other] : KIND_PATHS[query.kind]));
      const out = await run(args);
      // a start past the root (`<first commit>^`) is simply the end of the list
      if (out.code !== 0) return { entries: [] };
      const commits = parseLog(out.stdout);
      const page = commits.slice(0, query.limit);
      const entries = page.map((c) => {
        const touches: HistoryTouch[] = [];
        for (const f of c.files) {
          const t = touchOfPath(f.path, f.status);
          if (!touches.some((x) => x.subject === t.subject && x.part === t.part)) touches.push(t);
        }
        return entryOf(c, touches.slice(0, 25), Math.max(0, touches.length - 25));
      });
      return { entries, ...(commits.length > query.limit && page.length > 0 ? { next: page[page.length - 1]!.sha } : {}) };
    },

    async record(subject, query): Promise<HistoryList> {
      if (!(await isAvailable())) return none.record(subject, query);
      const paths = subjectPaths(subject).map((p) => p.path);
      let start = query.before !== undefined && SHA.test(query.before) ? `${query.before}^` : 'HEAD';
      const entries: HistoryEntry[] = [];
      let next: string | undefined;
      // a list file changes for many records: read commits in batches until the page is full (at most 400)
      for (let scanned = 0; scanned < 400 && next === undefined; ) {
        const out = await run(['log', FORMAT, '--no-renames', '-n50', start, '--', ...paths]);
        if (out.code !== 0) break;
        const commits = parseLog(out.stdout);
        if (commits.length === 0) break;
        for (const c of commits) {
          const steps = await stepsOf(subject, c.sha);
          if (steps.length === 0) continue;
          if (entries.length === query.limit) {
            next = entries[entries.length - 1]!.id;
            break;
          }
          entries.push(entryOf(c, touchesOfSteps(subject, steps)));
        }
        scanned += commits.length;
        if (commits.length < 50) break;
        start = `${commits[commits.length - 1]!.sha}^`;
      }
      return { entries, ...(next === undefined ? {} : { next }) };
    },

    async detail(id, subject) {
      if (!SHA.test(id) || !(await isAvailable())) return undefined;
      const out = await run(['log', FORMAT, '--name-status', '--no-renames', '--relative', '-n1', id, '--']);
      if (out.code !== 0) return undefined;
      const commit = parseLog(out.stdout)[0];
      if (commit === undefined || commit.sha !== id) return undefined;
      if (subject !== undefined) {
        const steps = await stepsOf(subject, id);
        return { entry: entryOf(commit, touchesOfSteps(subject, steps)), records: diffsOf(subject, steps) };
      }
      const parent = await parentOf(id);
      const records: RecordDiff[] = [];
      const touches: HistoryTouch[] = [];
      for (const f of commit.files.slice(0, 200)) {
        const t = touchOfPath(f.path, f.status);
        if (!touches.some((x) => x.subject === t.subject && x.part === t.part)) touches.push(t);
        if (!f.path.endsWith('.json') || t.part === 'versions') {
          records.push({ subject: t.subject, label: t.label, part: t.part ?? 'file', op: 'binary', before: UNKNOWN, after: UNKNOWN, restorable: false });
          continue;
        }
        const before = parent === undefined ? known(undefined) : await show(parent, f.path);
        const after = await show(id, f.path);
        if (DEFINITION_FILES.has(f.path) && before.known && after.known) {
          const defKind = f.path.slice(0, -5);
          const index = (list: unknown): Map<string, unknown> => new Map((Array.isArray(list) ? list : []).flatMap((r) => (typeof r === 'object' && r !== null && typeof (r as { id?: unknown }).id === 'string' ? [[(r as { id: string }).id, r] as const] : [])));
          const a = index(before.value);
          const b = index(after.value);
          for (const rid of [...new Set([...a.keys(), ...b.keys()])].sort()) {
            const was = a.get(rid);
            const now = b.get(rid);
            if (JSON.stringify(was) === JSON.stringify(now)) continue;
            records.push({ subject: definitionSubject(defKind, rid), label: `${definitionNoun(defKind)} ${rid} — record`, part: 'record', op: was === undefined ? 'added' : now === undefined ? 'removed' : 'changed', before: known(was), after: known(now), restorable: true });
          }
          continue;
        }
        const restorable = (t.subject.startsWith('design:') && (t.part === 'design' || t.part === 'drawing'));
        records.push({
          subject: t.subject,
          label: t.label,
          part: t.part ?? 'file',
          op: !before.known || !after.known ? 'unknown' : before.value === undefined ? 'added' : after.value === undefined ? 'removed' : 'changed',
          before,
          after,
          restorable,
        });
      }
      return { entry: entryOf(commit, touches.slice(0, 25), Math.max(0, touches.length - 25)), records };
    },

    async stateAt(subject, id) {
      if (!SHA.test(id) || !(await isAvailable())) return undefined;
      if ((await run(['cat-file', '-e', `${id}^{commit}`])).code !== 0) return undefined;
      const parts: SubjectState = {};
      const restorable = new Set(restorableParts(subject));
      for (const p of subjectPaths(subject)) {
        if (!restorable.has(p.part)) continue;
        const state = await show(id, p.path);
        parts[p.part] = p.element === undefined || !state.known ? state : known(elementOf(state.value, p.element));
      }
      // a git catalog keeps connectors as body + interface; the definition routes take them composed
      return { parts, stored: subject.type === 'definition' && subject.kind === 'connectors' };
    },
  };
}
