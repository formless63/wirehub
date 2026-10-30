/**
 * The device workspace (`/cables/:id?view=device`): one scene of the design's board occurrences,
 * generated enclosure (base and lid), hardware and schematic cable routes, beside its tree,
 * external ports and BOM. Selecting in any of the four highlights the same things in the others.
 *
 * Explode and section are view state only: the layout (`design.device`) changes only through the
 * placement editor below, as an ordinary undoable edit saved with the design.
 */

import { useEffect, useMemo, useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Badge, Button, Callout, DeviceViewer, NumberInput, SegmentedControl, Select, cx, type DeviceSection, EmptyState, FindingsList } from '@wirehub/editor-react';
import { deriveBom, wireDisplayName, type BomLine } from '@wirehub/docs';
import {
  DEVICE_ANCHORS, deviceScene, nodesOfInstances, openPlaced,
  type CableDesign, type Db, type DeviceLayout, type DevicePlacement, type DeviceRoute, type DeviceSceneNode, type DeviceVec3,
} from '@wirehub/model';

import { readEnclosure } from '../enclosures/enclosures.browser.ts';
import { enclosureResult, loadDeviceInputs, modelKeyOf } from './device.browser.ts';
import { enclosureShells, setupReasons, sideBySide, withEnclosure } from './enclosure-pick.ts';
import { suggestLayout } from './suggest.ts';
import { DeviceExports } from './DeviceExports.tsx';
import { useVersionFile } from '../versions/shared.tsx';
import { useStudio } from '../studio-context.tsx';
import { DesignFirmware } from '../FirmwareLinks.tsx';
import { newEnclosureRecord } from '../enclosures/BoardEnclosures.tsx';

export interface DevicePaneProps {
  design: CableDesign;
  db: Db;
  readOnly: boolean;
  onChange?: (design: CableDesign, description?: string) => void;
  /** a shell to offer in the enclosure picker (the shell record's "Use in design…") */
  enclosureHint?: string;
  /** the saved version shown (`/cables/:id?rev=N&view=device`); absent: the working copy */
  rev?: number;
  /** unsaved edits, and how to save them (an export saves first: it is made from the stored design) */
  dirty?: boolean;
  save?: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

/** JSON with object keys sorted, for comparing values that went through a store. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
}

const KIND_LABEL: Record<DeviceSceneNode['kind'], string> = {
  enclosure: 'enclosure', lid: 'lid', board: 'board', hardware: 'hardware', assembly: 'sub-device', cable: 'cable', part: 'part',
};
const LEVEL_TONE = { error: 'err', warning: 'warn', info: 'info' } as const;

interface TreeRow { key: string; depth: number; label: string; kind: string; paths: string[]; note?: string; placed: boolean; group?: string; copies?: number }

export function DevicePane(props: DevicePaneProps): JSX.Element {
  const { design, db } = props;
  const layout = design.device;
  const studio = useStudio();
  const canExport = studio.me?.role !== 'viewer';
  // a saved version draws the enclosure generations and board exports it was saved with
  const version = useVersionFile(design.id, props.rev);
  const pins = version.file?.device;
  const inputsQuery = useQuery({
    // the placed designs arrive with the library: their parts are inputs too
    queryKey: ['device-inputs', design.id, props.rev ?? null, JSON.stringify(design.instances), JSON.stringify(layout?.enclosure ?? null), (db.assemblies?.working ?? []).map((d) => `${d.id}:${JSON.stringify(d.instances)}`).join('|')],
    queryFn: () => loadDeviceInputs(design, db, pins),
    enabled: props.rev === undefined || version.file !== undefined || version.error !== undefined,
    staleTime: 30_000,
  });
  const inputs = inputsQuery.data;
  const [selected, setSelected] = useState<string[]>([]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [explode, setExplode] = useState(0);
  const [sectionAxis, setSectionAxis] = useState<'off' | 'x' | 'y' | 'z'>('off');
  const [sectionAt, setSectionAt] = useState(0.5);

  const enclosure = useMemo(() => (id: string, path?: string) => enclosureResult(inputs?.enclosures.get((path === undefined ? undefined : inputs.at.get(path)) ?? id)), [inputs]);
  const modelKey = useMemo(() => (node: DeviceSceneNode) => modelKeyOf(node, inputs?.at), [inputs]);
  const scene = useMemo(
    () => deviceScene({ design, db, enclosure, boardSize: (id) => inputs?.boardSizes.get(id) }),
    [design, db, enclosure, inputs],
  );
  const bom = useMemo(() => {
    try { return deriveBom(design, db); } catch { return undefined; }
  }, [design, db]);
  const selectedBom = useMemo(() => {
    const inst = new Set(scene.nodes.filter((n) => selected.includes(n.path)).map((n) => n.bomInstance));
    return new Set((bom?.lines ?? []).filter((l) => l.provenance.some((p) => inst.has(p))).map((l) => l.key));
  }, [scene, selected, bom]);

  // tree: every top-level instance that can be placed, its placed nodes nested under it
  const tree = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    const nodesUnder = (prefix: string): DeviceSceneNode[] => scene.nodes.filter((n) => n.path === prefix || n.path.startsWith(`${prefix}#`) || n.path.startsWith(`${prefix}/`));
    const add = (id: string, label: string, kind: string): void => {
      const under = nodesUnder(id);
      const children = under.filter((n) => n.path !== id);
      rows.push({ key: id, depth: 0, label, kind, paths: under.map((n) => n.path), placed: under.length > 0, ...(children.length > 0 ? { copies: children.length } : {}) });
      for (const n of children) {
        rows.push({ key: n.path, depth: n.path.split('/').length - (n.path.includes('#') ? 0 : 1) || 1, label: n.label, kind: KIND_LABEL[n.kind], paths: [n.path], placed: true, group: id, ...(n.provisional === undefined ? {} : { note: n.provisional }) });
      }
    };
    const mech = (id: string): string => (db.mechanicals ?? []).find((m) => m.id === id)?.label ?? 'Hardware';
    for (const m of design.instances.mechanical ?? []) add(m.id, `${m.id} · ${mech(m.def)}${m.qty > 1 ? ` × ${m.qty}` : ''}`, m.id === layout?.enclosure ? 'enclosure' : 'hardware');
    for (const b of design.instances.pcbas) add(b.id, `${b.id} · ${db.pcbas.find((p) => p.id === b.def)?.label ?? 'Board'}`, 'board');
    for (const s of design.instances.subassemblies ?? []) {
      const placed = openPlaced(db, s)?.design;
      add(s.id, `${s.id} · ${placed?.label ?? 'Sub-assembly'}`, placed?.device === undefined ? 'cable' : 'sub-device');
    }
    for (const s of design.instances.segments) add(s.id, `${s.id} · ${wireDisplayName(db, s.def)}`, 'cable');
    return rows;
  }, [scene, design, db, layout?.enclosure]);

  const change = (next: DeviceLayout, what: string): void => props.onChange?.({ ...design, device: next }, what);
  const editable = !props.readOnly && props.onChange !== undefined;

  // after "Set up": what it could not place, and why — kept current as the user fixes each one
  const [setupRan, setSetupRan] = useState(false);
  const setUp = (): void => {
    if (inputs === undefined) return;
    const next = suggestLayout(design, db, enclosure, inputs.hardwareShapes);
    // what the suggestion does not decide keeps its current placement or route
    const keep = (layout?.placements ?? []).filter((p) => !next.placements.some((q) => q.instance === p.instance));
    const routes = [...(next.routes ?? []), ...(layout?.routes ?? []).filter((r) => !(next.routes ?? []).some((q) => q.instance === r.instance))];
    let merged: DeviceLayout = { ...next, placements: [...next.placements, ...keep], ...(routes.length === 0 ? {} : { routes }) };
    // without an enclosure the boards still go somewhere visible: side by side, never stacked
    if (merged.enclosure === undefined) merged = { ...merged, placements: [...merged.placements, ...sideBySide(design, merged, (id) => inputs.boardSizes.get(id))] };
    setSetupRan(true);
    change(merged, 'set up the device layout');
  };

  // the enclosure picker: every shell with an enclosure spec, and whether it has a generation
  const shells = useMemo(() => enclosureShells(db), [db]);
  const shellStatus = useQuery({
    queryKey: ['device-shells', shells.map((s) => s.id).join(',')],
    queryFn: async () => new Map(await Promise.all(shells.map(async (s) => {
      const status = await readEnclosure(s.id).then((v) => (v.run?.status === 'ok' ? 'generated' : v.run === null ? 'not generated' : 'last generation failed'), () => 'unreadable');
      return [s.id, status] as const;
    }))),
    staleTime: 30_000,
  });
  const shellInstance = layout?.enclosure === undefined ? undefined : (design.instances.mechanical ?? []).find((m) => m.id === layout.enclosure);
  const [pick, setPick] = useState<string | undefined>(props.enclosureHint ?? shellInstance?.def);
  useEffect(() => {
    if (pick === undefined && shellInstance?.def !== undefined) setPick(shellInstance.def);
  }, [pick, shellInstance?.def]);
  const boardLabel = (pcba: string): string => db.pcbas.find((p) => p.id === pcba)?.label ?? pcba;
  const designBoards = new Set(design.instances.pcbas.map((b) => b.def));
  const shellOptions = [...shells]
    .sort((a, b) => Number((b.enclosure?.occurrences ?? []).some((o) => designBoards.has(o.pcba))) - Number((a.enclosure?.occurrences ?? []).some((o) => designBoards.has(o.pcba))))
    .map((s) => {
      const fits = (s.enclosure?.occurrences ?? []).some((o) => designBoards.has(o.pcba));
      const status = shellStatus.data?.get(s.id);
      return { value: s.id, label: `${s.label}${status === undefined ? '' : ` · ${status}`}`, group: fits ? 'Holds this design\'s boards' : 'Other enclosures' };
    });
  const picked = shells.find((s) => s.id === pick);
  const adoptEnclosure = (): void => {
    if (picked === undefined || props.onChange === undefined) return;
    props.onChange(withEnclosure(design, db, picked.id), `use enclosure ${picked.label}`);
  };
  const pickedHolds = picked === undefined ? undefined : (() => {
    const counts = new Map<string, number>();
    for (const o of picked.enclosure?.occurrences ?? []) counts.set(o.pcba, (counts.get(o.pcba) ?? 0) + 1);
    return [...counts].map(([pcba, n]) => `${n} × ${boardLabel(pcba)}`).join(', ');
  })();
  // no enclosure holds this design's boards yet: offer a new one holding all of them (opened on its record to generate)
  const navigate = useNavigate();
  const [creating, setCreating] = useState<string | undefined>();
  const designPcbas = design.instances.pcbas.map((b) => db.pcbas.find((p) => p.id === b.def)).filter((p): p is NonNullable<typeof p> => p !== undefined);
  const holdsAny = shells.some((s) => (s.enclosure?.occurrences ?? []).some((o) => designBoards.has(o.pcba)));
  const newEnclosure = async (): Promise<void> => {
    if (studio.definitions === undefined || designPcbas.length === 0) return;
    const record = newEnclosureRecord(db, designPcbas);
    setCreating('…');
    const out = await studio.definitions.create('mechanicals', record);
    setCreating(out.ok ? undefined : `${out.message}${out.hint === undefined ? '' : ` ${out.hint}`}`);
    if (!out.ok) return;
    studio.onDefinitionsChange();
    void navigate({ to: '/library/$kind/$id', params: { kind: 'mechanicals', id: record.id }, search: {} });
  };
  const newEnclosureButton = holdsAny || designPcbas.length === 0 || !editable || studio.definitions === undefined ? null : (
    <Button size="sm" variant={shells.length === 0 ? 'primary' : 'secondary'} loading={creating === '…'} disabled={creating === '…'} onClick={() => void newEnclosure()}
      className="max-w-96" title={`New enclosure for ${[...new Set(designPcbas.map((p) => p.label))].join(' + ')}`}>
      <span className="min-w-0 truncate">New enclosure for {[...new Set(designPcbas.map((p) => p.label))].join(' + ')}</span>
    </Button>
  );
  const enclosureRow = (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="device-enclosure-picker">
      <span className="text-dim">Enclosure</span>
      {creating !== undefined && creating !== '…' ? <span role="alert" className="text-xs text-err">{creating}</span> : null}
      {shells.length === 0 ? (newEnclosureButton ?? <span className="text-xs text-faint">none yet</span>) : (
        <>
          <Select size="xs" className="w-80" aria-label="Enclosure for this design" value={pick} placeholder="Pick an enclosure…" options={shellOptions} disabled={!editable} onValueChange={setPick} />
          <Button size="sm" variant={layout === undefined || shellInstance === undefined ? 'primary' : 'secondary'} disabled={!editable || picked === undefined || picked.id === shellInstance?.def} onClick={adoptEnclosure}>
            {shellInstance === undefined ? 'Use this enclosure' : picked?.id === shellInstance.def ? 'In use' : 'Switch to this enclosure'}
          </Button>
          {pickedHolds === undefined ? null : <span className="text-xs text-faint">holds {pickedHolds === '' ? 'no boards' : pickedHolds}</span>}
          {picked !== undefined && shellStatus.data?.get(picked.id) !== undefined && shellStatus.data.get(picked.id) !== 'generated'
            ? <Badge tone="warn">{shellStatus.data.get(picked.id)}: generate it on its record first</Badge> : null}
          {newEnclosureButton}
        </>
      )}
    </div>
  );
  const setupNote = useMemo(() => {
    if (!setupRan || layout === undefined) return [];
    const shellDef = shellInstance?.def;
    const reasons = setupReasons({
      design, db, layout, generated: shellDef === undefined ? undefined : enclosure(shellDef) !== undefined,
      placed: new Set(scene.nodes.map((n) => n.instance)),
    });
    if (scene.nodes.length === 0 && reasons.length === 0) reasons.push('Nothing could be placed; the findings below say why for each part.');
    for (const i of scene.issues) if (i.level !== 'info') reasons.push(i.message);
    return reasons;
  }, [setupRan, layout, shellInstance?.def, design, db, enclosure, scene]);
  const note = setupNote.length === 0 ? null : (
    <div data-testid="device-setup-note">
      <Callout tone="warn">
        <p className="font-semibold">Set up placed less than everything:</p>
        <ul className="list-disc pl-4">{setupNote.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </Callout>
    </div>
  );

  const placementOptions = (kind: string, instance: string): { value: string; label: string }[] => {
    const shellId = shellInstance?.def;
    const occs = shellId === undefined ? [] : (db.mechanicals ?? []).find((m) => m.id === shellId)?.enclosure?.occurrences ?? [];
    const own = design.instances.pcbas.find((b) => b.id === instance)?.def;
    const holder = (occ: string): string | undefined => layout?.placements.find((p) => p.occurrence === occ && p.instance !== instance)?.instance;
    return [
      { value: '-', label: 'not placed' },
      ...(kind === 'board' ? occs.map((o, i) => {
        const by = holder(o.id);
        return { value: `occurrence:${o.id}`, label: `slot ${i + 1}${o.pcba === own ? '' : ` (holds ${boardLabel(o.pcba)})`}${by === undefined ? '' : ` · now ${by}`}` };
      }) : []),
      ...(kind === 'hardware' ? DEVICE_ANCHORS.map((a) => ({ value: `anchor:${a}`, label: a.replace('-', ' ') })) : []),
      { value: 'at', label: 'position' },
    ];
  };
  const placementValue = (p: DevicePlacement | undefined): string =>
    p === undefined ? '-' : p.occurrence !== undefined ? `occurrence:${p.occurrence}` : p.anchor !== undefined ? `anchor:${p.anchor}` : 'at';
  const setPlacement = (instance: string, value: string): void => {
    const base: DeviceLayout = layout ?? { placements: [] };
    const rest = base.placements.filter((p) => p.instance !== instance);
    const [how, arg] = value.split(':');
    const next: DevicePlacement | undefined = how === 'occurrence' ? { instance, occurrence: arg! } : how === 'anchor' ? { instance, anchor: arg as DevicePlacement['anchor'] & string } : how === 'at' ? { instance, at: seedAt(instance, base) } : undefined;
    // a slot holds one board: the board that had it gives it up
    const freed = how === 'occurrence' ? rest.filter((p) => p.occurrence !== arg) : rest;
    change({ ...base, placements: next === undefined ? freed : [...freed, next] }, `place ${instance}`);
  };
  /** A hand position starts where the part is drawn now, or beside everything else; never stacked at the origin. */
  const seedAt = (instance: string, base: DeviceLayout): DeviceVec3 => {
    const node = scene.nodes.find((n) => n.path === instance);
    if (node?.matrix !== undefined) return [0, 1, 2].map((i) => Math.round(node.matrix![i]![3]! * 10) / 10) as DeviceVec3;
    let x = 0;
    for (const n of scene.nodes) if (n.matrix !== undefined) x = Math.max(x, n.matrix[0]![3]! + (n.size?.[0] ?? 50) + 15);
    for (const p of base.placements) if (p.at !== undefined) x = Math.max(x, p.at[0] + 65);
    return [Math.round(x), 0, 0];
  };
  const setVec = (instance: string, key: 'at' | 'rotDeg', axis: number, v: number | null): void => {
    if (layout === undefined) return;
    const p = layout.placements.find((q) => q.instance === instance);
    if (p === undefined) return;
    const vec = [...(p[key] ?? [0, 0, 0])] as DeviceVec3;
    if (vec[axis] === (v ?? 0)) return;
    vec[axis] = v ?? 0;
    change({ ...layout, placements: layout.placements.map((q) => (q.instance === instance ? { ...q, [key]: vec } : q)) }, key === 'at' ? `move ${instance}` : `turn ${instance}`);
  };
  const setVia = (instance: string, via: DeviceVec3[]): void => {
    if (layout === undefined) return;
    change({ ...layout, routes: (layout.routes ?? []).map((r) => (r.instance === instance ? (via.length === 0 ? { instance: r.instance, a: r.a, b: r.b } : { ...r, via }) : r)) }, `bend ${instance}`);
  };
  const vecInputs = (label: string, vec: DeviceVec3, unit: string, onAxis: (axis: number, v: number | null) => void): JSX.Element => (
    <span className="flex items-center gap-1" role="group" aria-label={label}>
      <span className="w-6 text-faint">{unit === '°' ? 'rot' : 'at'}</span>
      {(['x', 'y', 'z'] as const).map((a, i) => (
        <NumberInput key={a} size="xs" className="w-20" aria-label={`${label} ${a}`} value={vec[i]!} unit={unit} step={unit === '°' ? 15 : 1} precision={2} disabled={!editable} onChange={(v) => onAxis(i, v)} />
      ))}
    </span>
  );
  const openingOptions = [{ value: '-', label: 'none' }, ...scene.ports.filter((p) => !p.opening.includes('/')).map((p) => ({ value: p.opening, label: `${p.label} (${p.face})` }))];
  // the first end of a new route waits here until the second is chosen (a saved route has both)
  const [pendingEnds, setPendingEnds] = useState<Record<string, Partial<Pick<DeviceRoute, 'a' | 'b'>>>>({});
  const setRouteEnd = (instance: string, end: 'a' | 'b', opening: string): void => {
    const base: DeviceLayout = layout ?? { placements: [] };
    const routes = [...(base.routes ?? [])];
    const i = routes.findIndex((r) => r.instance === instance);
    const current: Partial<DeviceRoute> = i < 0 ? { instance, ...pendingEnds[instance] } : routes[i]!;
    const half = { ...current, [end]: opening === '-' ? undefined : { opening } };
    if (i < 0 && (half.a === undefined || half.b === undefined)) {
      setPendingEnds((cur) => ({ ...cur, [instance]: { ...(half.a === undefined ? {} : { a: half.a }), ...(half.b === undefined ? {} : { b: half.b }) } }));
      return;
    }
    setPendingEnds((cur) => { const next = { ...cur }; delete next[instance]; return next; });
    const updated = { ...current, instance, [end]: opening === '-' ? undefined : { opening } } as Partial<DeviceRoute>;
    const complete = updated.a !== undefined && updated.b !== undefined;
    if (i >= 0) routes.splice(i, 1);
    // an incomplete route is kept only once both ends name an opening
    change({ ...base, routes: complete ? [...routes, updated as DeviceRoute] : routes }, `route ${instance}`);
  };

  const section: DeviceSection | undefined = sectionAxis === 'off' ? undefined : { axis: sectionAxis, at: sectionAt };
  const selectPaths = (paths: string[]): void => setSelected((cur) => (cur.length === paths.length && cur.every((p) => paths.includes(p)) ? [] : paths));
  const selectBom = (line: BomLine): void => selectPaths(nodesOfInstances(scene, line.provenance));

  if (layout === undefined) {
    return (
      <div className="flex flex-col gap-3 p-4" data-testid="device-pane">
        <h2 className="cs-ui-sr">Device</h2>
        {enclosureRow}
        <EmptyState action={<Button variant="primary" disabled={!editable || inputs === undefined} onClick={setUp}
          title="Places the boards in the picked enclosure's slots, adds screws and feet with parametric models, and routes the cables joined to the boards">
          {inputs === undefined ? 'Reading the enclosure…' : 'Set up as a device'}</Button>}>
          Boards, enclosure, hardware and cables in one 3D scene
        </EmptyState>
        {note}
      </div>
    );
  }

  // a version saved before pins draws with each shell's current generation: say when that was made from other parameters
  const staleShells = props.rev === undefined || inputs === undefined ? [] : [...inputs.enclosures].filter(([id, view]) => {
    if (pins?.enclosures[id] !== undefined || [...inputs.at.values()].includes(id)) return false;
    const frozen = (db.mechanicals ?? []).find((m) => m.id === id)?.enclosure;
    return view.run !== null && frozen !== undefined && canonical(view.run.inputs.spec) !== canonical(frozen);
  }).map(([id]) => (db.mechanicals ?? []).find((m) => m.id === id)?.label ?? 'Unavailable enclosure');

  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of scene.issues) counts[i.level]++;

  return (
    <div className="flex min-h-0 flex-col gap-2 p-3" data-testid="device-pane">
      <div className="flex flex-wrap items-center gap-3 text-sm" role="toolbar" aria-label="Device view">
        <h2 className="text-md font-semibold">Device</h2>
        <span className="text-faint">{scene.nodes.length} placed · {scene.ports.length} ports</span>
        {counts.warning > 0 ? <Badge tone="warn">{counts.warning} warning{counts.warning === 1 ? '' : 's'}</Badge> : null}
        {counts.info > 0 ? <Badge tone="info">{counts.info} note{counts.info === 1 ? '' : 's'}</Badge> : null}
        <label className="flex items-center gap-2" title="View only: the layout is unchanged">
          <span className="text-dim">Explode</span>
          <input type="range" min={0} max={100} value={Math.round(explode * 100)} onChange={(e) => setExplode(Number(e.target.value) / 100)} aria-label="Explode" className="w-32 accent-[var(--accent)]" />
        </label>
        <span className="flex items-center gap-2" title="View only: the layout is unchanged">
          <span className="text-dim">Section</span>
          <SegmentedControl size="xs" aria-label="Section plane" value={sectionAxis} onValueChange={(v) => setSectionAxis(v as typeof sectionAxis)}
            options={[{ value: 'off', label: 'Off' }, { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }]} />
          {sectionAxis === 'off' ? null : <input type="range" min={0} max={100} value={Math.round(sectionAt * 100)} onChange={(e) => setSectionAt(Number(e.target.value) / 100)} aria-label="Section position" className="w-28 accent-[var(--accent)]" />}
        </span>
        <span className="ml-auto flex gap-2">
          {editable ? <Button size="sm" onClick={setUp} disabled={inputs === undefined}>Re-suggest layout</Button> : null}
          <Button size="sm" onClick={() => void inputsQuery.refetch()}>Reload models</Button>
        </span>
      </div>

      {enclosureRow}
      {note}
      {staleShells.length === 0 ? null : (
        <Callout tone="warn"><span title="This version was saved before device versions kept their enclosure generation. Its parameters differ from the ones the current generation was made from.">Drawn with today's generation of {staleShells.join(', ')}</span></Callout>
      )}

      <div className="grid min-h-0 gap-3" style={{ gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr) minmax(260px, 360px)' }}>
        <nav aria-label="Device tree" className="min-h-0 overflow-auto rounded-md border border-line bg-panel py-1 text-sm" data-testid="device-tree">
          {tree.map((row) => {
            const on = row.paths.length > 0 && row.paths.every((p) => selected.includes(p));
            // copies of one instance (screws, a sub-device's parts) fold under it unless opened or selected
            if (row.group !== undefined && !open.has(row.group) && !selected.includes(row.key)) return null;
            return (
              <button key={row.key} type="button" disabled={!row.placed}
                className={cx('flex w-full items-baseline gap-2 px-2 py-1 text-left hover:bg-hover disabled:text-faint', on && 'bg-selected')}
                style={{ paddingLeft: 8 + row.depth * 14 }} onClick={() => selectPaths(row.paths)} aria-pressed={on} title={row.note}
                data-path={row.key}>
                {row.copies === undefined ? null : (
                  <span role="button" tabIndex={-1} aria-label={open.has(row.key) ? 'Fold copies' : 'Show copies'} className="text-faint"
                    onClick={(e) => { e.stopPropagation(); setOpen((cur) => { const next = new Set(cur); if (next.has(row.key)) next.delete(row.key); else next.add(row.key); return next; }); }}>
                    {open.has(row.key) ? '▾' : '▸'}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="shrink-0 text-xs text-faint">{row.placed ? row.kind : 'not placed'}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0" title="Cables are schematic routes between the ports they join. Boards without a model are outlined placeholders.">
          {inputs === undefined ? <div className="flex h-[460px] items-center justify-center text-sm text-faint">Loading models…</div> : (
            <DeviceViewer nodes={scene.nodes} models={inputs.models} modelKey={modelKey} selected={selected}
              onSelect={(p) => setSelected(p === undefined ? [] : [p])} explode={explode} {...(section === undefined ? {} : { section })} label={design.label} height={480} />
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-auto">
          <section aria-label="External ports">
            <h3 className="mb-1 text-sm font-semibold">External ports</h3>
            {scene.ports.length === 0 ? <p className="text-xs text-faint">No openings yet: generate the enclosure with board ports.</p> : (
              <table className="w-full text-xs" data-testid="device-ports">
                <thead className="text-faint"><tr><th className="text-left font-normal">Opening</th><th className="text-left font-normal">Board pins</th><th className="text-left font-normal">Plugs in</th></tr></thead>
                <tbody>
                  {scene.ports.map((p) => {
                    const cables = p.cables ?? (p.cable === undefined ? [] : [{ ...p.cable, terminals: p.cable.terminal === undefined ? [] : [p.cable.terminal] }]);
                    const paths = [p.board?.path, ...cables.map((c) => c.path)].filter((x): x is string => x !== undefined);
                    const on = paths.length > 0 && paths.every((x) => selected.includes(x));
                    return (
                      <tr key={p.opening} className={cx('cursor-pointer hover:bg-hover', on && 'bg-selected')} onClick={() => selectPaths(paths)}>
                        <td className="py-0.5 pr-2" title={p.detail}>{p.label} <span className="text-faint">{p.face}</span></td>
                        <td className="pr-2">{p.board === undefined ? <span className="text-faint">manual opening</span> : <>{p.board.terminals.length === 0 ? <span className="text-faint">no pins matched</span> : p.board.terminals.join(', ')}</>}</td>
                        <td>{cables.length === 0 ? <span className="text-faint">nothing</span> : cables.map((c) => <div key={c.instance}>{c.instance}{c.terminals.length === 0 ? '' : <span className="text-faint"> ({c.terminals.join(', ')})</span>}</div>)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
          <section aria-label="Device BOM">
            <h3 className="mb-1 text-sm font-semibold" title="An assembled board and a placed design are one line each; their contents are their own BOMs.">BOM</h3>
            <table className="w-full text-xs" data-testid="device-bom">
              <tbody>
                {(bom?.lines ?? []).map((l) => (
                  <tr key={l.key} className={cx('cursor-pointer hover:bg-hover', selectedBom.has(l.key) && 'bg-selected')} onClick={() => selectBom(l)} data-bom={l.key}>
                    <td className="py-0.5 pr-2 tabular-nums">{l.qty}×</td>
                    <td className="pr-2">{l.label}{l.value === undefined ? '' : <span className="text-faint"> · {l.value}</span>}</td>
                    <td className="whitespace-nowrap text-faint">{l.partNumber ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {props.rev === undefined ? <DesignFirmware design={design} className="" /> : null}
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)' }}>
        <section aria-label="Placements">
          <h3 className="mb-1 text-sm font-semibold">Placements</h3>
          <table className="w-full text-xs">
            <tbody>
              {tree.filter((r) => r.depth === 0 && r.kind !== 'cable').map((r) => {
                const p = layout.placements.find((x) => x.instance === r.key);
                return (
                  <tr key={r.key} data-placement={r.key}>
                    <td className="py-0.5 pr-2 align-top">{r.label}</td>
                    <td className="w-64 align-top">
                      {r.kind === 'enclosure' ? <span className="text-faint">the device frame</span> : (
                        <Select size="xs" aria-label={`Placement of ${r.key}`} value={placementValue(p)} disabled={!editable} options={placementOptions(r.kind, r.key)} onValueChange={(v) => setPlacement(r.key, v)} />
                      )}
                      {p?.at === undefined ? null : (
                        <span className="mt-1 flex flex-col gap-1">
                          {vecInputs(`${r.key} position`, p.at, 'mm', (i, v) => setVec(r.key, 'at', i, v))}
                          {vecInputs(`${r.key} rotation`, p.rotDeg ?? [0, 0, 0], '°', (i, v) => setVec(r.key, 'rotDeg', i, v))}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {tree.filter((r) => r.depth === 0 && r.kind === 'cable').map((r) => {
                const route = layout.routes?.find((x) => x.instance === r.key);
                const val = (e: DeviceRoute['a'] | undefined): string => (e !== undefined && 'opening' in e ? e.opening : '-');
                const pending = route === undefined ? pendingEnds[r.key] : undefined;
                return (
                  <tr key={r.key} data-route={r.key}>
                    <td className="py-0.5 pr-2 align-top">{r.label} <span className="text-faint">route</span></td>
                    <td className="w-64 align-top">
                      <span className="flex gap-1">
                        <Select size="xs" aria-label={`${r.key} end a`} value={val(route?.a ?? pending?.a)} disabled={!editable} options={openingOptions} onValueChange={(v) => setRouteEnd(r.key, 'a', v)} />
                        <Select size="xs" aria-label={`${r.key} end b`} value={val(route?.b ?? pending?.b)} disabled={!editable} options={openingOptions} onValueChange={(v) => setRouteEnd(r.key, 'b', v)} />
                      </span>
                      {route === undefined ? null : (
                        <span className="mt-1 flex flex-col gap-1">
                          {(route.via ?? []).map((v, k) => (
                            <span key={k} className="flex items-center gap-1">
                              <span className="w-10 text-faint">bend {k + 1}</span>
                              {vecInputs(`${r.key} bend ${k + 1}`, v, 'mm', (i, n) => { const via = (route.via ?? []).map((x) => [...x] as DeviceVec3); via[k]![i] = n ?? 0; setVia(r.key, via); })}
                              <Button size="xs" variant="ghost" aria-label={`Remove bend ${k + 1} of ${r.key}`} disabled={!editable} onClick={() => setVia(r.key, (route.via ?? []).filter((_, j) => j !== k))}>×</Button>
                            </span>
                          ))}
                          {editable ? (
                            <span><Button size="xs" variant="ghost" onClick={() => {
                              // a new bend starts at the middle of the drawn route
                              const pts = scene.nodes.find((n) => n.path === r.key)?.points ?? [];
                              const mid = pts[Math.floor(pts.length / 2)] ?? [0, 0, 0];
                              setVia(r.key, [...(route.via ?? []), mid.map((c) => Math.round(c)) as DeviceVec3]);
                            }}>Add bend point</Button></span>
                          ) : null}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {scene.nodes.filter((n) => n.kind === 'cable').map((n) => (
            <p key={n.path} className="text-xs text-dim">{n.path}: route ≈ {Math.round(n.lengthMm?.route ?? 0)} mm{n.lengthMm?.declared === undefined ? ', no declared length' : `, declared ${n.lengthMm.declared} mm`}</p>
          ))}
        </section>
        <section aria-label="Findings">
          <h3 className="mb-1 text-sm font-semibold">Findings</h3>
          {scene.issues.length === 0 ? <p className="text-xs text-faint">None.</p> : (
            <FindingsList findings={scene.issues.map((i) => ({ level: i.level === 'warning' ? 'warn' : i.level, message: i.message }))}
              onSelect={(_f, k) => { const where = scene.issues[k]?.where; if (where !== undefined) selectPaths(scene.nodes.filter((n) => n.path === where || n.path.startsWith(`${where}#`)).map((n) => n.path)); }} />
          )}
          {inputs !== undefined && inputs.missing.size > 0 ? (
            <Callout tone="info" className="mt-2">Shown as placeholders: {[...inputs.missing].map(([k, why]) => `${k.replace(/^[a-z]+:/, '')} (${why})`).join('; ')}.</Callout>
          ) : null}
          {inputs !== undefined && inputs.standIns.size > 0 ? (
            <Callout tone="info" className="mt-2">Drawn from the board's native model (its linked model is not built on this hub): {[...inputs.standIns].map(([k, file]) => `${db.pcbas.find((b) => b.id === k.replace(/^[a-z]+:/, ''))?.label ?? 'Board'} (${file})`).join('; ')}.</Callout>
          ) : null}
        </section>
      </div>
      <DeviceExports design={design.id} {...(props.rev === undefined ? {} : { rev: props.rev })} canExport={canExport}
        dirty={props.rev === undefined && props.dirty === true} {...(props.save === undefined ? {} : { save: props.save })} />
    </div>
  );
}
