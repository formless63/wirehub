/**
 * The build editor:
 * one board's `data/builds/<board>.json`, edited as a form.
 *
 * - **Builds** are tabs; "New build from…" duplicates one (or starts blank).
 * - **Settings** are the board's jumpers by the owner's function names (CS,
 *   TTL, CV…), set per build with a segmented control; the exclusive groups
 *   are checked as they change and a broken group is shown on the spot. A
 *   jumper's population follows its setting (`withSettingState`), so the two
 *   can never drift apart.
 * - **Population**: every part on the board, fitted / 0 Ω / omitted, drawn on
 *   the board art — click a part there to step its state.
 * - **Paths**: what the build does to each signal; the definition's own link
 *   is walked and shown, and its `via` suggests conditioning.
 * - **Board**: the settings themselves, exclusive groups, power, hazards.
 *
 * Every change runs core's `validateBoardBuilds`, and its findings sit next to
 * what they are about. The host saves through its `BuildsAdapter`, which runs
 * the same checks again before it writes.
 */

import {
  buildPopulation,
  conditioningFromVia,
  definitionsOfBuild,
  exclusiveGroups,
  partPopulation,
  validateBoardBuilds,
  withPartState,
  withSettingState,
  type BoardBuild,
  type BoardBuilds,
  type BuildHazard,
  type BuildSetting,
  type CapabilityPath,
  type Db,
  type Issue,
  type PartBuildState,
  type PcbaDefinition,
  type SignalRef,
} from '@wirehub/model';
import { IconAlertTriangle, IconCheck, IconCopy, IconPlus, IconTrash, IconX } from '@tabler/icons-react';
import { Popover } from 'radix-ui';
import { useMemo, useState, type JSX, type ReactNode } from 'react';

import type { DepictionMeta } from '../artwork.ts';
import { allTerminals } from '../board-journey.ts';
import { partsOnSide } from '../board-art.ts';
import { classes } from '../context.ts';
import { signalRefOf, signalText, type PickOption } from '../vocab.ts';
import { BoardComponentsSection } from './BoardComponentsSection.tsx';
import { PadMapArt, type ArtPad } from './PadMapArt.tsx';
import { Pick } from './Pick.tsx';

type Part = NonNullable<DepictionMeta['components']>['parts'][number];

export interface BuildEditorProps {
  db: Db;
  /** the board revision's definitions, one per build */
  defs: readonly PcbaDefinition[];
  file: BoardBuilds;
  onChange: (next: BoardBuilds) => void;
  /** the build tab open */
  selected: string;
  onSelect: (key: string) => void;
  /** a save's refusal, the server's own list */
  serverIssues?: readonly Issue[];
  /** the board art: a depiction manifest and the two faces' image hrefs */
  meta?: DepictionMeta;
  top?: string;
  bottom?: string;
  /** every part the board's builds mount, with its position (the union of the builds' manifests) */
  parts?: readonly Part[];
  disabled?: boolean;
}

/* ------------------------------------------------------------------ *
 * Small controls
 * ------------------------------------------------------------------ */

function Seg(props: {
  value: string;
  options: readonly { value: string; label: string; title?: string }[];
  onChange: (next: string) => void;
  label: string;
  disabled?: boolean;
  bad?: boolean;
}): JSX.Element {
  return (
    <span className={classes('cs-bj-seg', props.bad === true && 'is-bad')} role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={props.value === o.value}
          className={classes(props.value === o.value && 'is-on')}
          disabled={props.disabled}
          {...(o.title === undefined ? {} : { title: o.title })}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function IssueList(props: { issues: readonly Issue[] }): JSX.Element | null {
  if (props.issues.length === 0) return null;
  return (
    <ul className="cs-bj-issues" role="status">
      {props.issues.map((issue, i) => (
        <li key={i} className={issue.severity === 'error' ? 'is-err' : 'is-warn'} title={issue.where}>
          <IconAlertTriangle size={12} stroke={1.75} aria-hidden="true" />
          <span className="cs-mono">{issue.code}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

function Section(props: { title: string; say?: string; right?: ReactNode; children: ReactNode }): JSX.Element {
  return (
    <section className="cs-bj-section">
      <header>
        <h4 {...(props.say === undefined ? {} : { title: props.say })}>{props.title}</h4>
        {props.right}
      </header>
      {props.children}
    </section>
  );
}

function Text(props: { value: string; onChange: (next: string) => void; label: string; mono?: boolean; wide?: boolean; placeholder?: string; say?: string; bad?: boolean }): JSX.Element {
  return (
    <label className={classes('cs-bj-text', props.wide === true && 'is-wide', props.bad === true && 'is-bad')} {...(props.say === undefined ? {} : { title: props.say })}>
      <span>{props.label}</span>
      <input
        className={classes(props.mono === true && 'cs-mono')}
        value={props.value}
        {...(props.placeholder === undefined ? {} : { placeholder: props.placeholder })}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const STATE_LABEL: Record<PartBuildState, string> = { fitted: 'fitted', bridged: '0 Ω', omitted: 'omitted' };
const NEXT_STATE: Record<PartBuildState, PartBuildState> = { fitted: 'omitted', omitted: 'bridged', bridged: 'fitted' };

/** A key no build of the file uses yet. */
function freeKey(file: BoardBuilds, base: string): string {
  const taken = new Set(file.builds.map((b) => b.key));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The copy "New build from…" makes: same population and paths, its own key and id suffix. */
export function duplicateBuild(file: BoardBuilds, from: BoardBuild | undefined, key: string): BoardBuild {
  if (from === undefined) {
    return { key, idSuffix: `-${key}`, build: '', settings: Object.fromEntries((file.settings ?? []).map((s) => [s.function, s.states[0] ?? ''])), src: '' };
  }
  const copy = structuredClone(from) as BoardBuild;
  return {
    ...copy,
    key,
    idSuffix: `-${key}`,
    build: `${from.build} (copy)`,
    src: `${from.src} — duplicated from build '${from.key}' in WireHub; restate what differs.`,
  };
}

function replaceBuild(file: BoardBuilds, key: string, next: BoardBuild): BoardBuilds {
  return { ...file, builds: file.builds.map((b) => (b.key === key ? next : b)) };
}

function levelOf(spec: { level?: string } | undefined): string {
  return spec?.level ?? '';
}

function specWith(signal: string, level: string): { signal: SignalRef; level?: string } | undefined {
  const ref = signalRefOf(signal);
  if (ref === undefined) return undefined;
  return level === '' ? { signal: ref } : { signal: ref, level };
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

export function BuildEditor(props: BuildEditorProps): JSX.Element {
  const { db, file, onChange } = props;
  const build = file.builds.find((b) => b.key === props.selected) ?? file.builds[0];
  const [newKey, setNewKey] = useState('');
  const [newFrom, setNewFrom] = useState<string | undefined>(undefined);
  const [pickedPath, setPickedPath] = useState<number | undefined>(undefined);

  const issues = useMemo(
    () =>
      validateBoardBuilds([file], {
        pcbas: db.pcbas,
        ...(db.interfaces === undefined ? {} : { interfaces: db.interfaces }),
        ...(db.vocab === undefined ? {} : { vocab: db.vocab }),
      }),
    [file, db],
  );
  const fileKey = file.revision === undefined ? file.board : `${file.board} ${file.revision}`;
  const at = (buildKey: string): string => `builds/${fileKey}/${buildKey}`;
  const issuesOf = (buildKey: string): Issue[] => issues.filter((i) => i.where === at(buildKey) || (i.where ?? '').startsWith(`${at(buildKey)}/`));
  const boardIssues = issues.filter((i) => i.where === `builds/${fileKey}`);

  const terminals = useMemo(() => [...new Set(props.defs.flatMap((d) => allTerminals(d)))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })), [props.defs]);
  const terminalOptions: PickOption[] = terminals.map((t) => ({ value: t, label: t }));

  if (build === undefined) {
    return <p className="cs-empty">This file has no builds.</p>;
  }
  const setBuild = (next: BoardBuild): void => onChange(replaceBuild(file, build.key, next));
  const own = issuesOf(build.key);
  const groups = exclusiveGroups(file, build);
  const refs = (props.parts ?? []).map((p) => p.ref);
  const population = partPopulation(file, build, refs);
  const stateOf = new Map(population.map((p) => [p.ref, p]));
  const defsOfBuild = definitionsOfBuild(file, build, props.defs);
  const linkDefs = defsOfBuild.length > 0 ? defsOfBuild : props.defs;

  const addBuild = (): void => {
    const key = freeKey(file, newKey.trim() === '' ? 'build' : newKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
    const from = file.builds.find((b) => b.key === newFrom);
    onChange({ ...file, builds: [...file.builds, duplicateBuild(file, from, key)] });
    props.onSelect(key);
    setNewKey('');
  };

  /* the art: parts coloured by this build's population, the picked path's ends lit */
  const art = props.meta === undefined ? undefined : props.meta.views['board-top'];
  const frame = art?.widthUnits === undefined || art.heightUnits === undefined ? undefined : { width: art.widthUnits, height: art.heightUnits };
  const path = pickedPath === undefined ? undefined : build.capability?.paths[pickedPath];
  const artPads: ArtPad[] =
    props.meta === undefined
      ? []
      : Object.entries(props.meta.pinAnchors).flatMap(([terminal, anchor]) =>
          (anchor.pads ?? [{ ref: terminal, pad: '1', x: anchor.x, y: anchor.y, side: anchor.side ?? 'top' }]).map((pad) => ({
            key: `${terminal}:${pad.ref}#${pad.pad}`,
            x: pad.x,
            y: pad.y,
            side: pad.side,
            // only the picked path's ends are named: the parts are what this view is about
            ...(path !== undefined && (path.from === terminal || path.to === terminal) ? { label: terminal, tone: 'accent' as const } : { tone: 'dim' as const }),
            group: terminal,
          })),
        );
  const cycle = (ref: string): void => {
    const now = stateOf.get(ref);
    if (now === undefined || now.setting !== undefined || props.disabled === true) return;
    setBuild(withPartState(build, ref, NEXT_STATE[now.state]));
  };
  const overlay = (side: 'top' | 'bottom', scale: number): ReactNode => {
    if (props.meta === undefined || frame === undefined || props.parts === undefined) return null;
    const meta: DepictionMeta = { ...props.meta, components: { build: build.build, basis: 'as-designed', parts: [...props.parts], src: '' } };
    return (
      <g className="cs-bj-parts">
        {partsOnSide(meta, side, frame, 0, scale).map((p) => {
          const s = stateOf.get(p.ref);
          const state = s?.state ?? 'fitted';
          return (
            <g
              key={p.ref}
              className={classes('cs-bj-part', `is-${state}`, s?.setting !== undefined && 'is-set')}
              data-part={p.ref}
              onClick={(event) => {
                event.stopPropagation();
                cycle(p.ref);
              }}
            >
              <title>{`${p.title} — ${STATE_LABEL[state]}${s?.setting === undefined ? ' · click to change' : ` · set by ${s.setting.function}`}`}</title>
              <polygon points={p.points} />
              <text x={p.x} y={p.y + 3}>
                {p.ref}
              </text>
            </g>
          );
        })}
      </g>
    );
  };

  return (
    <div className="cs-bj-builds">
      <nav className="cs-bj-buildtabs" aria-label="builds">
        {file.builds.map((b) => {
          const n = issuesOf(b.key).filter((i) => i.severity === 'error').length;
          return (
            <button
              key={b.key}
              type="button"
              aria-pressed={b.key === build.key}
              className={classes(b.key === build.key && 'is-on')}
              title={b.build}
              onClick={() => props.onSelect(b.key)}
            >
              <span className="cs-mono">{b.key}</span>
              {n > 0 ? <span className="cs-bj-count is-err">{n}</span> : <IconCheck size={12} stroke={2} className="cs-bj-ok" aria-hidden="true" />}
            </button>
          );
        })}
        <Popover.Root>
          <Popover.Trigger asChild>
            <button type="button" className="cs-bj-new" disabled={props.disabled} title="New build from an existing one (or blank)">
              <IconPlus size={13} stroke={2} aria-hidden="true" />
              New build from…
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content className="cs-popover cs-bj-newpop" sideOffset={4} align="start">
              <label className="cs-bj-text">
                <span>From</span>
                <select value={newFrom ?? ''} onChange={(e) => setNewFrom(e.target.value === '' ? undefined : e.target.value)}>
                  <option value="">blank</option>
                  {file.builds.map((b) => (
                    <option key={b.key} value={b.key}>
                      {b.key}
                    </option>
                  ))}
                </select>
              </label>
              <Text label="Key" mono value={newKey} placeholder="hd15" onChange={setNewKey} say="Short, lowercase: it becomes the definition id's suffix" />
              <Popover.Close asChild>
                <button type="button" className="cs-primary" onClick={addBuild}>
                  <IconCopy size={13} stroke={1.75} aria-hidden="true" /> Add
                </button>
              </Popover.Close>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </nav>

      <div className="cs-bj-buildgrid">
        <fieldset className="cs-bj-form" disabled={props.disabled}>
          <Section
            title="Build"
            right={
              <button
                type="button"
                className="cs-icon-btn cs-danger-quiet"
                disabled={file.builds.length < 2}
                title={file.builds.length < 2 ? 'A board keeps at least one build' : `Remove build '${build.key}'`}
                aria-label={`remove build ${build.key}`}
                onClick={() => {
                  const rest = file.builds.filter((b) => b.key !== build.key);
                  onChange({ ...file, builds: rest });
                  props.onSelect(rest[0]?.key ?? '');
                }}
              >
                <IconTrash size={13} stroke={1.75} />
              </button>
            }
          >
            <div className="cs-bj-row">
              <Text
                label="Key"
                mono
                value={build.key}
                onChange={(v) => {
                  setBuild({ ...build, key: v });
                  props.onSelect(v);
                }}
                say="Short key; the definition id's suffix unless Id suffix says otherwise"
              />
              <Text label="Id suffix" mono value={build.idSuffix ?? ''} onChange={(v) => setBuild({ ...build, idSuffix: v })} say="Appended to <part>-<rev> for the definition id; blank keeps the bare id" />
              <Text label="Build line" wide value={build.build} onChange={(v) => setBuild({ ...build, build: v })} say="The definition's `build`: what a builder reads" />
              <Text label="Label suffix" wide value={build.labelSuffix ?? ''} onChange={(v) => setBuild({ ...build, ...(v === '' ? { labelSuffix: undefined } : { labelSuffix: v }) } as BoardBuild)} />
            </div>
            {defsOfBuild.length === 0 ? (
              <p className="cs-bj-hint" title="Definitions come from the import: re-run it after saving">
                <IconAlertTriangle size={12} stroke={1.75} aria-hidden="true" /> no definition yet · re-run the import
              </p>
            ) : (
              <p className="cs-bj-hint is-ok">
                {defsOfBuild.map((d) => (
                  <span key={d.id} className="cs-mono">
                    {d.id}
                  </span>
                ))}
              </p>
            )}
          </Section>

          <Section title="Settings" say="The board's jumpers and switches by the function the board's documentation calls them; set per build">
            {(file.settings ?? []).length === 0 ? <p className="cs-empty">No jumpers on this board.</p> : null}
            <table className="cs-bj-table">
              <tbody>
                {(file.settings ?? []).map((s) => {
                  const state = build.settings?.[s.function] ?? '';
                  const inBad = groups.some((g) => !g.ok && g.group.includes(s.function));
                  const settingIssue = own.find((i) => i.message.includes(`'${s.function}'`));
                  return (
                    <tr key={s.function} className={classes((inBad || settingIssue !== undefined) && 'is-bad')}>
                      <th
                        scope="row"
                        title={[s.label ?? s.src, ...(s.rules ?? []).map((r) => `${[...(r.when.destination ?? []), ...(r.when.sync ?? [])].join(' / ')} → ${r.state}`)].join('\n')}
                      >
                        <strong>{s.function}</strong> <span className="cs-mono cs-dim">{s.ref}</span>
                      </th>
                      <td>
                        <Seg
                          label={`${s.function} on ${build.key}`}
                          value={state}
                          bad={inBad && state === 'closed'}
                          options={s.states.map((st) => ({ value: st, label: st }))}
                          onChange={(v) => setBuild(withSettingState(file, build, s.function, v))}
                        />
                      </td>
                      <td className="cs-bj-rules">
                        {(s.rules ?? []).map((r, i) => (
                          <span key={i} className="cs-chip" title={r.src ?? s.src}>
                            {[...(r.when.destination ?? []), ...(r.when.sync ?? []), ...Object.entries(r.when.settings ?? {}).map(([k, v]) => `${k}=${v}`)].join(' / ')} → {r.state}
                          </span>
                        ))}
                        {settingIssue === undefined ? null : <span className="cs-bj-bad">{settingIssue.message}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {groups.map((g) => (
              <p key={g.group.join('/')} className={classes('cs-bj-rule', g.ok ? 'is-ok' : 'is-bad')} role={g.ok ? undefined : 'alert'}>
                {g.ok ? <IconCheck size={12} stroke={2} aria-hidden="true" /> : <IconX size={12} stroke={2} aria-hidden="true" />}
                exactly one of {g.group.join(' / ')} closed
                {g.ok ? null : <strong> · {g.closed.length === 0 ? 'none is' : `${g.closed.join(' + ')} are`}</strong>}
              </p>
            ))}
          </Section>

          <Section title="Population" say="Every part the board carries, as this build fits it. Click a part on the art to step it: fitted → omitted → 0 Ω." right={<span className="cs-count">{population.length}</span>}>
            <div className="cs-bj-parts-list">
              {population.map((p) => (
                <span key={p.ref} className={classes('cs-bj-partrow', `is-${p.state}`)}>
                  <span className="cs-mono">{p.ref}</span>
                  <Seg
                    label={`${p.ref} on ${build.key}`}
                    value={p.state}
                    disabled={p.setting !== undefined}
                    options={(['fitted', 'bridged', 'omitted'] as const).map((st) => ({
                      value: st,
                      label: STATE_LABEL[st],
                      ...(p.setting === undefined ? {} : { title: `Set by ${p.setting.function}` }),
                    }))}
                    onChange={(v) => setBuild(withPartState(build, p.ref, v as PartBuildState))}
                  />
                </span>
              ))}
            </div>
          </Section>

          <BoardComponentsSection
            db={db}
            board={file.board}
            {...((file.revision ?? props.defs[0]?.revision) === undefined ? {} : { revision: (file.revision ?? props.defs[0]?.revision) as string })}
            population={{ build: build.build, ...buildPopulation(file, build) }}
          />

          <Section
            title="Paths"
            say="What this build does to each signal on its way through. The definition's copper is walked and its parts suggest the conditioning."
            right={
              <button
                type="button"
                className="cs-bj-add"
                onClick={() =>
                  setBuild({
                    ...build,
                    capability: { paths: [...(build.capability?.paths ?? []), { from: '', to: '', in: { signal: '' }, conditioning: [] }], src: build.capability?.src ?? 'Set in WireHub build editor.' },
                  })
                }
              >
                <IconPlus size={12} stroke={2} aria-hidden="true" /> path
              </button>
            }
          >
            <PathRows
              build={build}
              file={file}
              db={db}
              linkDefs={linkDefs}
              terminalOptions={terminalOptions}
              issues={own}
              issueAt={at(build.key)}
              picked={pickedPath}
              onPick={setPickedPath}
              onChange={(paths) => setBuild({ ...build, capability: { paths, src: build.capability?.src ?? 'Set in WireHub build editor.' } })}
            />
          </Section>

          <Section title="Hazards" say="Guards the resolver checks for this build">
            <HazardRows hazards={build.hazards ?? []} onChange={(h) => setBuild({ ...build, ...(h.length === 0 ? { hazards: undefined } : { hazards: h }) } as BoardBuild)} />
          </Section>

          <Section title="Source">
            <label className="cs-bj-text is-wide">
              <span>src</span>
              <textarea rows={2} value={build.src} onChange={(e) => setBuild({ ...build, src: e.target.value })} />
            </label>
            <label className="cs-bj-text is-wide">
              <span>note</span>
              <textarea rows={2} value={build.note ?? ''} onChange={(e) => setBuild({ ...build, ...(e.target.value === '' ? { note: undefined } : { note: e.target.value }) } as BoardBuild)} />
            </label>
          </Section>

          <BoardSection file={file} onChange={onChange} db={db} terminalOptions={terminalOptions} refs={refs} />
        </fieldset>

        <aside className="cs-bj-side">
          {frame === undefined ? (
            <p className="cs-empty">No board art yet.</p>
          ) : (
            <PadMapArt
              frame={frame}
              {...(props.top === undefined ? {} : { top: props.top })}
              {...(props.bottom === undefined ? {} : { bottom: props.bottom })}
              pads={artPads}
              onSelect={() => undefined}
              overlay={overlay}
              label="board parts"
            />
          )}
          <p className="cs-bj-legend">
            <span className="is-fitted">fitted</span>
            <span className="is-bridged">0 Ω</span>
            <span className="is-omitted">omitted</span>
          </p>
          <IssueList issues={[...boardIssues, ...own, ...(props.serverIssues ?? []).filter((i) => !own.some((o) => o.message === i.message))]} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

function PathRows(props: {
  build: BoardBuild;
  file: BoardBuilds;
  db: Db;
  linkDefs: readonly PcbaDefinition[];
  terminalOptions: PickOption[];
  issues: readonly Issue[];
  issueAt: string;
  picked: number | undefined;
  onPick: (n: number | undefined) => void;
  onChange: (paths: CapabilityPath[]) => void;
}): JSX.Element {
  const paths = props.build.capability?.paths ?? [];
  const set = (n: number, next: CapabilityPath): void => props.onChange(paths.map((p, i) => (i === n ? next : p)));
  const whenOptions: PickOption[] = (props.file.settings ?? []).flatMap((s) => s.states.map((st) => ({ value: `${s.ref}=${st}`, label: `${s.function} ${st}`, hint: s.ref })));
  if (paths.length === 0) return <p className="cs-empty">No paths stated.</p>;
  return (
    <div className="cs-bj-paths">
      {paths.map((p, n) => {
        const link = props.linkDefs
          .flatMap((d) => d.internalLinks)
          .find((l) => (l.from === p.from && l.to === p.to) || (l.from === p.to && l.to === p.from));
        const suggested = conditioningFromVia(link?.via, p.in.signal).filter((c) => !p.conditioning.includes(c));
        const mine = props.issues.filter((i) => i.where === `${props.issueAt}/capability/${n}`);
        return (
          <div
            key={n}
            className={classes('cs-bj-path', props.picked === n && 'is-picked', mine.length > 0 && 'is-bad')}
            onFocusCapture={() => props.onPick(n)}
            onMouseEnter={() => props.onPick(n)}
          >
            <div className="cs-bj-path-ends">
              <Pick ariaLabel={`path ${n + 1} from`} options={props.terminalOptions} value={p.from} mono allowCustom onChange={(v) => set(n, { ...p, from: v })} />
              <span aria-hidden="true">→</span>
              <Pick ariaLabel={`path ${n + 1} to`} options={props.terminalOptions} value={p.to} mono allowCustom onChange={(v) => set(n, { ...p, to: v })} />
              <span className={classes('cs-bj-walk', link === undefined && p.linked !== false && 'is-bad')} title={link === undefined ? 'No internal link joins these terminals' : 'The copper the definition declares'}>
                {link === undefined ? (p.linked === false ? 'not traced' : 'no link') : (link.via ?? 'copper')}
              </span>
              <button
                type="button"
                className="cs-icon-btn cs-danger-quiet"
                aria-label={`remove path ${n + 1}`}
                title="Remove"
                onClick={() => props.onChange(paths.filter((_, i) => i !== n))}
              >
                <IconTrash size={13} stroke={1.75} />
              </button>
            </div>
            <div className="cs-bj-path-sig">
              <span className="cs-bj-lbl">in</span>
              <Pick list="signals" ariaLabel={`path ${n + 1} in signal`} value={signalText(p.in.signal)} onChange={(v) => set(n, { ...p, in: specWith(v, levelOf(p.in)) ?? { signal: v } })} />
              <Pick list="levels" ariaLabel={`path ${n + 1} in level`} value={levelOf(p.in)} clearable noneLabel="level ?" placeholder="level" onChange={(v) => set(n, { ...p, in: specWith(signalText(p.in.signal), v) ?? p.in })} />
              <span className="cs-bj-lbl">out</span>
              <Pick
                list="signals"
                ariaLabel={`path ${n + 1} out signal`}
                value={p.out === undefined ? '' : signalText(p.out.signal)}
                clearable
                noneLabel="as in"
                placeholder="as in"
                onChange={(v) => {
                  const out = specWith(v, levelOf(p.out));
                  const { out: _drop, ...rest } = p;
                  set(n, out === undefined ? rest : { ...rest, out });
                }}
              />
              {p.out === undefined ? null : (
                <Pick list="levels" ariaLabel={`path ${n + 1} out level`} value={levelOf(p.out)} clearable noneLabel="level ?" placeholder="level" onChange={(v) => set(n, { ...p, out: specWith(signalText(p.out!.signal), v) ?? p.out! })} />
              )}
            </div>
            <div className="cs-bj-path-cond">
              {p.conditioning.map((c) => (
                <span key={c} className="cs-chip cs-bj-cond">
                  {props.db.vocab?.['conditioning']?.entries.find((e) => e.id === c)?.label ?? c}
                  <button type="button" aria-label={`remove ${c}`} onClick={() => set(n, { ...p, conditioning: p.conditioning.filter((x) => x !== c) })}>
                    <IconX size={10} stroke={2} />
                  </button>
                </span>
              ))}
              {suggested.map((c) => (
                <button key={c} type="button" className="cs-chip cs-bj-suggest" title={`Suggested by '${link?.via ?? ''}' — click to confirm`} onClick={() => set(n, { ...p, conditioning: [...p.conditioning, c] })}>
                  <IconPlus size={10} stroke={2} aria-hidden="true" /> {props.db.vocab?.['conditioning']?.entries.find((e) => e.id === c)?.label ?? c}?
                </button>
              ))}
              <Pick list="conditioning" ariaLabel={`add conditioning to path ${n + 1}`} value="" placeholder="+ conditioning" onChange={(v) => v !== '' && !p.conditioning.includes(v) && set(n, { ...p, conditioning: [...p.conditioning, v] })} />
              {Object.entries(p.when ?? {}).map(([k, v]) => (
                <span key={k} className="cs-chip">
                  when {k}={v}
                  <button
                    type="button"
                    aria-label={`remove when ${k}`}
                    onClick={() => {
                      const when = { ...(p.when ?? {}) };
                      delete when[k];
                      const { when: _w, ...rest } = p;
                      set(n, Object.keys(when).length === 0 ? rest : { ...rest, when });
                    }}
                  >
                    <IconX size={10} stroke={2} />
                  </button>
                </span>
              ))}
              {whenOptions.length === 0 ? null : (
                <Pick
                  ariaLabel={`path ${n + 1} selected when`}
                  options={whenOptions}
                  value=""
                  placeholder="+ when"
                  onChange={(v) => {
                    const [k, s] = v.split('=');
                    if (k !== undefined && s !== undefined) set(n, { ...p, when: { ...(p.when ?? {}), [k]: s } });
                  }}
                />
              )}
            </div>
            {mine.map((i, k) => (
              <p key={k} className="cs-bj-bad">
                {i.message}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function HazardRows(props: { hazards: readonly BuildHazard[]; onChange: (next: BuildHazard[]) => void }): JSX.Element {
  const set = (n: number, next: BuildHazard): void => props.onChange(props.hazards.map((h, i) => (i === n ? next : h)));
  return (
    <div className="cs-bj-hazards">
      {props.hazards.map((h, n) => (
        <div key={n} className="cs-bj-row">
          <Text label="Code" mono value={h.code} onChange={(v) => set(n, { ...h, code: v })} placeholder="ttl-into-strict" />
          <Text label="What" wide value={h.text} onChange={(v) => set(n, { ...h, text: v })} />
          <Text label="src" wide value={h.src} bad={h.src.trim() === ''} onChange={(v) => set(n, { ...h, src: v })} />
          <button type="button" className="cs-icon-btn cs-danger-quiet" aria-label={`remove hazard ${n + 1}`} onClick={() => props.onChange(props.hazards.filter((_, i) => i !== n))}>
            <IconTrash size={13} stroke={1.75} />
          </button>
        </div>
      ))}
      <button type="button" className="cs-bj-add" onClick={() => props.onChange([...props.hazards, { code: '', text: '', src: '' }])}>
        <IconPlus size={12} stroke={2} aria-hidden="true" /> hazard
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The board's own part of the file
 * ------------------------------------------------------------------ */

function BoardSection(props: { file: BoardBuilds; onChange: (next: BoardBuilds) => void; db: Db; terminalOptions: PickOption[]; refs: readonly string[] }): JSX.Element {
  const { file, onChange } = props;
  const settings = file.settings ?? [];
  const setSetting = (n: number, next: BuildSetting): void => onChange({ ...file, settings: settings.map((s, i) => (i === n ? next : s)) });
  const refOptions: PickOption[] = [...new Set([...props.refs, ...settings.map((s) => s.ref)])]
    .filter((r) => /^(JP|SW|R|J)\d/i.test(r))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((r) => ({ value: r, label: r }));
  const fnOptions: PickOption[] = settings.map((s) => ({ value: s.function, label: s.function, hint: s.ref }));
  return (
    <details className="cs-bj-board">
      <summary title="What every build of this board shares: the jumpers themselves, the exclusive groups, power, hazards">Board</summary>
      <div className="cs-bj-row">
        <Text label="Label" wide value={file.label} onChange={(v) => onChange({ ...file, label: v })} />
        <label className="cs-bj-text">
          <span>End</span>
          <Seg label="board end" value={file.end} options={['source', 'destination', 'inline'].map((v) => ({ value: v, label: v }))} onChange={(v) => onChange({ ...file, end: v as BoardBuilds['end'] })} />
        </label>
      </div>
      <Section
        title="Jumpers"
        right={
          <button type="button" className="cs-bj-add" onClick={() => onChange({ ...file, settings: [...settings, { function: '', ref: '', kind: 'jumper', states: ['open', 'closed'], src: '' }] })}>
            <IconPlus size={12} stroke={2} aria-hidden="true" /> jumper
          </button>
        }
      >
        {settings.map((s, n) => (
          <div key={n} className="cs-bj-row">
            <Text label="Function" value={s.function} onChange={(v) => setSetting(n, { ...s, function: v })} placeholder="TERM" say="The name on the silkscreen / the owner's legend" />
            <label className="cs-bj-text">
              <span>Ref</span>
              <Pick ariaLabel={`jumper ${n + 1} ref`} options={refOptions} value={s.ref} mono allowCustom onChange={(v) => setSetting(n, { ...s, ref: v })} />
            </label>
            <label className="cs-bj-text">
              <span>Kind</span>
              <Seg
                label={`jumper ${n + 1} kind`}
                value={s.kind}
                options={[
                  { value: 'jumper', label: 'jumper', title: 'Solder jumper: closed = bridged' },
                  { value: 'link', label: 'link', title: 'A placed-or-not 0 Ω part' },
                  { value: 'switch', label: 'switch', title: 'A user control; positions are passages' },
                ]}
                onChange={(v) => setSetting(n, { ...s, kind: v as BuildSetting['kind'] })}
              />
            </label>
            <Text label="States" mono value={s.states.join(' / ')} onChange={(v) => setSetting(n, { ...s, states: v.split('/').map((x) => x.trim()).filter((x) => x !== '') })} />
            <Text label="What it does" wide value={s.label ?? ''} onChange={(v) => setSetting(n, { ...s, ...(v === '' ? {} : { label: v }) })} />
            <Text label="src" wide value={s.src} bad={s.src.trim() === ''} onChange={(v) => setSetting(n, { ...s, src: v })} />
            <button type="button" className="cs-icon-btn cs-danger-quiet" aria-label={`remove jumper ${n + 1}`} onClick={() => onChange({ ...file, settings: settings.filter((_, i) => i !== n) })}>
              <IconTrash size={13} stroke={1.75} />
            </button>
          </div>
        ))}
      </Section>
      <Section
        title="Exclusive groups"
        say="Groups of which exactly one is closed on every build (e.g. CV / Y / CS)"
        right={
          fnOptions.length < 2 ? null : (
            <button type="button" className="cs-bj-add" onClick={() => onChange({ ...file, exclusive: [...(file.exclusive ?? []), []] })}>
              <IconPlus size={12} stroke={2} aria-hidden="true" /> group
            </button>
          )
        }
      >
        {(file.exclusive ?? []).map((g, n) => (
          <div key={n} className="cs-bj-row">
            {g.map((fn) => (
              <span key={fn} className="cs-chip">
                {fn}
                <button
                  type="button"
                  aria-label={`remove ${fn} from group ${n + 1}`}
                  onClick={() => onChange({ ...file, exclusive: (file.exclusive ?? []).map((x, i) => (i === n ? x.filter((f) => f !== fn) : x)) })}
                >
                  <IconX size={10} stroke={2} />
                </button>
              </span>
            ))}
            <Pick
              ariaLabel={`add to group ${n + 1}`}
              options={fnOptions.filter((o) => !g.includes(o.value))}
              value=""
              placeholder="+ function"
              onChange={(v) => onChange({ ...file, exclusive: (file.exclusive ?? []).map((x, i) => (i === n ? [...x, v] : x)) })}
            />
            <button type="button" className="cs-icon-btn cs-danger-quiet" aria-label={`remove group ${n + 1}`} onClick={() => onChange({ ...file, exclusive: (file.exclusive ?? []).filter((_, i) => i !== n) })}>
              <IconTrash size={13} stroke={1.75} />
            </button>
          </div>
        ))}
      </Section>
      <Section title="Power" say="The rail the board is sized for and the terminals it feeds">
        <div className="cs-bj-row">
          <label className="cs-bj-text">
            <span>Rail</span>
            <Pick
              list="signals"
              ariaLabel="power rail"
              value={file.power?.rail ?? ''}
              clearable
              noneLabel="none"
              onChange={(v) => {
                const { power: _p, ...rest } = file;
                onChange(v === '' ? rest : { ...file, power: { rail: v, feeds: file.power?.feeds ?? [], ...(file.power?.note === undefined ? {} : { note: file.power.note }) } });
              }}
            />
          </label>
          {file.power === undefined ? null : (
            <>
              <span className="cs-bj-feeds">
                {file.power.feeds.map((t) => (
                  <span key={t} className="cs-chip cs-mono">
                    {t}
                    <button type="button" aria-label={`remove feed ${t}`} onClick={() => onChange({ ...file, power: { ...file.power!, feeds: file.power!.feeds.filter((f) => f !== t) } })}>
                      <IconX size={10} stroke={2} />
                    </button>
                  </span>
                ))}
                <Pick ariaLabel="add a fed terminal" options={props.terminalOptions} value="" placeholder="+ feeds" mono onChange={(v) => onChange({ ...file, power: { ...file.power!, feeds: [...file.power!.feeds, v] } })} />
              </span>
              <Text label="Note" wide value={file.power.note ?? ''} onChange={(v) => onChange({ ...file, power: { ...file.power!, ...(v === '' ? {} : { note: v }) } })} />
            </>
          )}
        </div>
      </Section>
      <Section title="Board hazards">
        <HazardRows hazards={file.hazards ?? []} onChange={(h) => onChange({ ...file, ...(h.length === 0 ? { hazards: undefined } : { hazards: h }) } as BoardBuilds)} />
      </Section>
    </details>
  );
}
