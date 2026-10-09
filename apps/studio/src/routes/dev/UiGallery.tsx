/**
 * `/dev/ui`: every ui/ primitive, light and dark side by side. Dev builds only (`router.tsx`
 * registers the route under `import.meta.env.DEV`, so a production bundle neither routes to it nor
 * contains it). Each panel scopes `data-theme`, and overlays portal into that panel, so a popover
 * opened in the light column is light.
 */

import { IconBolt, IconCopy, IconPlus, IconSearch, IconTrash } from '@tabler/icons-react';
import {
  Badge, BeamArt, Button, Callout, Checkbox, Chip, Combobox, ConfirmDialog, DataTable, Dialog, Drawer, EmptyState, Field, FileDrop, FilterMenu, HelpTip, IconButton, Input, Kbd, KeyValues, Menu, NumberInput,
  PageHeader, Popover, PortalContainerContext, RadioGroup, SegmentedControl, Select, SidePanel, Skeleton, StatusDot, Switch, Tab, TabList, TabPanel, Tabs, Textarea, Toolbar, Tooltip, notify,
  type ControlSize, type DataColumn,
} from '@wirehub/editor-react';
import { useState, type JSX, type ReactNode } from 'react';

const GAUGES = [
  { value: '22', label: '22 AWG' },
  { value: '24', label: '24 AWG' },
  { value: '26', label: '26 AWG', group: 'Fine' },
  { value: '28', label: '28 AWG', group: 'Fine' },
];
const PARTS = [
  { value: 'db9-m', label: 'DB-9 male', hint: 'D-sub' },
  { value: 'db9-f', label: 'DB-9 female', hint: 'D-sub' },
  { value: 'rj45', label: 'RJ45 plug', hint: 'modular' },
  { value: 'xlr3', label: 'XLR-3 male', hint: 'audio' },
];

function Row({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section style={{ display: 'grid', gridTemplateColumns: '112px 1fr', gap: 12, alignItems: 'start', padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
      <h3 style={{ margin: 0, fontSize: 'var(--fs-xs)', fontWeight: 500, color: 'var(--dim)', paddingTop: 5 }}>{title}</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, minWidth: 0 }}>{children}</div>
    </section>
  );
}

interface DemoRow {
  id: string;
  name: string;
  gauge: string;
  length: number;
  status: 'active' | 'draft';
}
const DEMO_ROWS: DemoRow[] = [
  { id: 'xlr-mic-5m', name: 'XLR mic cable, 5 m', gauge: '24 AWG', length: 5000, status: 'active' },
  { id: 'db9-crossover', name: 'DB-9 null-modem', gauge: '26 AWG', length: 1800, status: 'active' },
  { id: 'jst-led-lead', name: 'JST XH LED lead', gauge: '28 AWG', length: 300, status: 'draft' },
  { id: 'rj45-patch', name: 'RJ45 patch lead', gauge: '24 AWG', length: 2000, status: 'active' },
];
const DEMO_COLUMNS: DataColumn<DemoRow>[] = [
  { id: 'name', header: 'Name', fixed: true, sortValue: (r) => r.name, cell: (r) => r.name, width: 180 },
  { id: 'id', header: 'Id', mono: true, cell: (r) => r.id, width: 120 },
  { id: 'gauge', header: 'Wire', sortValue: (r) => r.gauge, cell: (r) => r.gauge },
  { id: 'length', header: 'Length (mm)', numeric: true, sortValue: (r) => r.length, cell: (r) => r.length },
  { id: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <Chip tone={r.status === 'active' ? 'ok' : 'neutral'}>{r.status}</Chip> },
];

function PageSampler(): JSX.Element {
  const [selected, setSelected] = useState<string | undefined>('db9-crossover');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string[]>([]);
  const [wire, setWire] = useState<string[]>([]);
  const row = DEMO_ROWS.find((r) => r.id === selected);
  const shown = DEMO_ROWS.filter((r) => (status.length === 0 || status.includes(r.status)) && (wire.length === 0 || wire.includes(r.gauge)));
  return (
    <div style={{ width: '100%', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', overflow: 'hidden', background: 'var(--bg)' }}>
      <PageHeader
        title="Designs"
        count={`${shown.length} designs`}
        help={<HelpTip label="About designs">A design is one buildable assembly.</HelpTip>}
        secondary={<Button size="sm" onClick={() => { setLoading(true); setTimeout(() => setLoading(false), 1500); }}>Show loading</Button>}
        primary={<Button size="sm" variant="primary" icon={<IconPlus size={14} aria-hidden />}>New design</Button>}
      />
      <Toolbar label="Design filters">
        <FilterMenu
          groups={[
            { label: 'Status', options: ['active', 'draft'], selected: status, onChange: setStatus },
            { label: 'Wire', options: ['24 AWG', '26 AWG', '28 AWG'], selected: wire, onChange: setWire },
          ]}
        />
      </Toolbar>
      <div style={{ display: 'flex', minHeight: 260 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <DataTable
            label="Demo designs"
            loading={loading}
            rows={shown}
            columns={DEMO_COLUMNS}
            getRowId={(r) => r.id}
            selectedId={selected}
            onSelect={(r) => setSelected(r.id)}
            empty={<EmptyState action={<Button size="xs" onClick={() => { setStatus([]); setWire([]); }}>Clear filters</Button>}>No design matches these filters.</EmptyState>}
          />
        </div>
        {row === undefined ? null : (
          <SidePanel title={row.name} subtitle={row.id} chips={<Chip tone={row.status === 'active' ? 'ok' : 'neutral'}>{row.status}</Chip>} onClose={() => setSelected(undefined)} label="Design details" footer={<Button size="sm" variant="primary">Open</Button>}>
            <KeyValues items={[['Wire', row.gauge], ['Length', `${row.length} mm`]]} />
          </SidePanel>
        )}
      </div>
    </div>
  );
}

function Sampler(): JSX.Element {
  const [gauge, setGauge] = useState('24');
  const [part, setPart] = useState<string | null>('db9-m');
  const [len, setLen] = useState<number | null>(1500);
  const [shield, setShield] = useState<boolean | 'indeterminate'>(true);
  const [side, setSide] = useState('a');
  const [auto, setAuto] = useState(true);
  const [view, setView] = useState('build');
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [tags, setTags] = useState(['shielded', 'twisted']);
  const [picked, setPicked] = useState<string>('');
  const sizes: ControlSize[] = ['xs', 'sm', 'md'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <Row title="Button">
        {sizes.map((s) => (
          <Button key={s} size={s} variant="primary">Primary {s}</Button>
        ))}
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
        <Button disabled>Disabled</Button>
        <Button loading>Saving</Button>
        <Button icon={<IconPlus size={14} aria-hidden />}>With icon</Button>
      </Row>
      <Row title="IconButton">
        <IconButton label="Copy" shortcut="Ctrl+C" icon={<IconCopy size={16} aria-hidden />} />
        <IconButton label="Search" size="xs" icon={<IconSearch size={14} aria-hidden />} />
        <IconButton label="Pinned" pressed icon={<IconBolt size={16} aria-hidden />} />
        <IconButton label="Delete" size="md" icon={<IconTrash size={16} aria-hidden />} />
        <span style={{ color: 'var(--dim)', fontSize: 'var(--fs-xs)' }}>Open with <Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </Row>
      <Row title="Field, Input">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: '100%' }}>
          <Field label="Part number" hint="Mono: an identifier" help="Assigned by the numbering scheme"><Input mono defaultValue="WH-0042" /></Field>
          <Field label="Name" required error="A name is required"><Input defaultValue="" placeholder="Name" /></Field>
          <Field label="Length"><NumberInput value={len} onChange={setLen} unit="mm" min={0} step={10} /></Field>
          <Field label="Notes"><Textarea defaultValue="Twisted pair, foil shield." /></Field>
          <Field label="Disabled"><Input disabled defaultValue="Locked by Sam" /></Field>
          <Field label="Small"><Input size="xs" defaultValue="22 px control" /></Field>
        </div>
      </Row>
      <Row title="Select, Combobox">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: '100%' }}>
          <Field label="Gauge"><Select value={gauge} onValueChange={setGauge} options={GAUGES} /></Field>
          <Field label="Connector" hint="Search, or create"><Combobox options={PARTS} value={part} onValueChange={setPart} onCreate={(t) => notify.info(`Create ${t}`)} /></Field>
        </div>
      </Row>
      <Row title="Choices">
        <Checkbox checked={shield} onCheckedChange={setShield} label="Shielded" />
        <Checkbox checked="indeterminate" onCheckedChange={() => setShield('indeterminate')} label="Mixed" />
        <Checkbox checked={false} onCheckedChange={() => undefined} label="Off" disabled />
        <RadioGroup aria-label="Side" orientation="horizontal" value={side} onValueChange={setSide} options={[{ value: 'a', label: 'Source' }, { value: 'b', label: 'Destination' }]} />
        <Switch checked={auto} onCheckedChange={setAuto} label="Autosave" />
      </Row>
      <Row title="SegmentedControl">
        <SegmentedControl aria-label="View" value={view} onValueChange={setView} options={[{ value: 'build', label: 'Build' }, { value: 'schematic', label: 'Schematic' }, { value: 'documents', label: 'Documents' }]} />
        <SegmentedControl aria-label="Density" size="xs" value="a" onValueChange={() => undefined} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />
      </Row>
      <Row title="Tabs">
        <Tabs defaultValue="parts" style={{ width: '100%' }}>
          <TabList aria-label="Sections">
            <Tab value="parts">Parts</Tab>
            <Tab value="wires">Wires <Badge>4</Badge></Tab>
            <Tab value="docs" disabled>Documents</Tab>
          </TabList>
          <TabPanel value="parts" style={{ padding: '8px 0', fontSize: 'var(--fs-sm)', color: 'var(--dim)' }}>Connectors, boards and components.</TabPanel>
          <TabPanel value="wires" style={{ padding: '8px 0', fontSize: 'var(--fs-sm)', color: 'var(--dim)' }}>Four wires.</TabPanel>
        </Tabs>
      </Row>
      <Row title="Chip, Badge, StatusDot">
        <Chip>connector</Chip>
        <Chip tone="ok">released</Chip>
        <Chip tone="warn">draft</Chip>
        <Chip tone="err">locked</Chip>
        <Chip tone="info">imported</Chip>
        <Chip tone="selected">current</Chip>
        <Chip mono>WH-0042</Chip>
        {tags.map((t) => <Chip key={t} onRemove={() => setTags(tags.filter((x) => x !== t))}>{t}</Chip>)}
        <Badge>12</Badge>
        <Badge tone="err">3</Badge>
        <StatusDot tone="ok" label="Synced" />
        <StatusDot tone="warn" label="Pending" pulse />
        <StatusDot tone="err" label="Failed" />
        <StatusDot label="Idle" />
      </Row>
      <Row title="Tooltip, Popover, Menu">
        <Tooltip content="Explains the control" shortcut="?"><Button variant="ghost">Hover or focus me</Button></Tooltip>
        <Popover trigger={<Button>Filter</Button>} aria-label="Filter options">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, width: 220 }}>
            <Field label="Contains"><Input /></Field>
            <Checkbox checked={false} onCheckedChange={() => undefined} label="Only released" />
          </div>
        </Popover>
        <Menu
          trigger={<Button>Actions</Button>}
          items={[
            { label: 'Rename', shortcut: 'F2', onSelect: () => notify.info('Rename') },
            { label: 'Duplicate', icon: <IconCopy size={14} aria-hidden />, onSelect: () => notify.info('Duplicate') },
            { type: 'separator' },
            { label: 'Delete', danger: true, icon: <IconTrash size={14} aria-hidden />, onSelect: () => notify.undoable('Deleted design', () => notify.success('Restored')) },
          ]}
        />
        <span style={{ color: 'var(--faint)', fontSize: 'var(--fs-xs)' }}>{picked}</span>
      </Row>
      <Row title="Dialog, Drawer">
        <Button onClick={() => setDialog(true)}>Dialog</Button>
        <Button onClick={() => setConfirm(true)}>ConfirmDialog</Button>
        <Button onClick={() => setDrawer(true)}>Drawer</Button>
        <Dialog open={dialog} onOpenChange={setDialog} title="Rename design" description="Shown in lists and on documents." footer={<><Button onClick={() => setDialog(false)}>Cancel</Button><Button variant="primary" onClick={() => { setDialog(false); setPicked('renamed'); }}>Rename</Button></>}>
          <Field label="Name"><Input defaultValue="Console to breakout" /></Field>
        </Dialog>
        <ConfirmDialog open={confirm} title="Delete design?" destructive confirmLabel="Delete" onConfirm={() => setConfirm(false)} onCancel={() => setConfirm(false)}>It stays in History for 30 days.</ConfirmDialog>
        <Drawer open={drawer} title="Details" modal onClose={() => setDrawer(false)} footer={<Button onClick={() => setDrawer(false)}>Done</Button>}>Anything that belongs beside the page.</Drawer>
      </Row>
      <Row title="Callout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
          <Callout>3 parts were imported from the pack.</Callout>
          <Callout tone="ok">Saved.</Callout>
          <Callout tone="warn" details="Pin 3 on both ends carries a different signal.">Pinout does not match.</Callout>
          <Callout tone="err" action={<Button size="xs">Retry</Button>}>Could not reach the server.</Callout>
        </div>
      </Row>
      <Row title="Toast">
        <Button onClick={() => notify.success('Saved')}>Success</Button>
        <Button onClick={() => notify.info('Imported', { description: '12 parts' })}>Info</Button>
        <Button onClick={() => notify.warn('Check the pinout')}>Warn</Button>
        <Button onClick={() => notify.error('Could not save', { description: 'The design is locked.' })}>Error</Button>
        <Button onClick={() => notify.undoable('Deleted 3 wires', () => notify.success('Restored'))}>Undoable</Button>
      </Row>
      <Row title="Skeleton">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
          <Skeleton width="60%" />
          <Skeleton width="85%" />
          <Skeleton width="40%" />
        </div>
      </Row>
      <Row title="FileDrop">
        <div style={{ width: '100%' }}><FileDrop accept=".step,.stp,.glb" hint=".step, .stp or .glb" onFiles={(f) => notify.info(`Got ${f[0]?.name ?? ''}`)} onReject={() => notify.warn('That file type is not accepted')} aria-label="Upload a model" /></div>
      </Row>
      <Row title="Empty state">
        <EmptyState icon={<BeamArt />} action={<Button variant="primary" icon={<IconPlus size={14} aria-hidden />}>New design</Button>}>No designs yet. A design is one buildable assembly.</EmptyState>
      </Row>
      <Row title="Page anatomy">
        <PageSampler />
      </Row>
    </div>
  );
}

function Panel({ theme }: { theme: 'light' | 'dark' }): JSX.Element {
  const [host, setHost] = useState<HTMLElement | null>(null);
  return (
    <div ref={setHost} data-theme={theme} data-testid={`gallery-${theme}`} style={{ background: 'var(--bg)', color: 'var(--ink)', padding: '8px 16px 24px', border: '1px solid var(--line2)', borderRadius: 'var(--r-lg)', minWidth: 0 }}>
      <h2 style={{ margin: '8px 0 0', fontSize: 'var(--fs-lg)', fontWeight: 600 }}>{theme === 'light' ? 'Light' : 'Dark'}</h2>
      <PortalContainerContext.Provider value={host}>
        <Sampler />
      </PortalContainerContext.Provider>
    </div>
  );
}

export function UiGallery(): JSX.Element {
  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box' }} data-testid="ui-gallery">
      <h1 style={{ margin: '0 0 12px', fontSize: 'var(--fs-lg)', fontWeight: 600 }}>UI primitives <span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 'var(--fs-xs)' }}>dev build only</span></h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(560px, 1fr))', gap: 16 }}>
        <Panel theme="light" />
        <Panel theme="dark" />
      </div>
    </div>
  );
}
