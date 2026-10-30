/**
 * Where firmware shows up from other records: a board's Library page lists the projects for that
 * board; a design's inspector and its device view list each board placement (occurrence) with its
 * firmware, a one-click Link for the board's other projects, and Compile with the newest build.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { JSX } from 'react';
import { toast } from 'sonner';
import { Button, Chip, Section, type EditorExtensions, type Tone } from '@wirehub/editor-react';
import type { CableDesign } from '@wirehub/model';

import type { FirmwareBuild, FirmwareProject } from './firmware.ts';
import { fetchFirmware, fetchFirmwareProject, firmwareKey, firmwareProjectKey, saveFirmware, startCompile } from './firmware.browser.ts';
import { unwrap } from './products.browser.ts';
import { useOptionalStudio } from './studio-context.tsx';
import { useSectionAdd } from './shell/RecordSections.tsx';

function useFirmware() {
  return useQuery({ queryKey: firmwareKey, queryFn: () => unwrap(fetchFirmware()), retry: false, staleTime: 10_000 });
}

/** The Library board record's "Firmware" section. */
export function BoardFirmware({ board }: { board: string }): JSX.Element | null {
  const list = useFirmware();
  const navigate = useNavigate();
  const projects = (list.data?.projects ?? []).filter((p) => p.board === board);
  const empty = list.data !== undefined && projects.length === 0;
  const hosted = useSectionAdd('firmware', 'Firmware…', empty, () => void navigate({ to: '/firmware', search: { board } }));
  if (hosted && (empty || list.data === undefined)) return null;
  return (
    <Section id="firmware" title="Firmware" testId="board-firmware" summary={list.data === undefined ? '…' : projects.length === 0 ? 'none' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
      actions={<Link to="/firmware" search={{ board }} className="cs-ui-btn no-underline" data-size="xs">{projects.length === 0 ? 'Add firmware' : 'Manage'}</Link>}>
      {projects.length === 0 ? null : <ul className="flex flex-col gap-0.5">
        {projects.map((p) => (
          <li key={p.id}>
            <Link to="/firmware/$id" params={{ id: p.id }} className="underline">{p.label}</Link>
            <span className="text-dim"> · {list.data?.targets.find((t) => t.id === p.toolchain.target)?.label ?? 'Custom target'}{p.occurrences.length === 0 ? '' : ` · ${p.occurrences.length} placement${p.occurrences.length === 1 ? '' : 's'}`}</span>
          </li>
        ))}
      </ul>}
    </Section>
  );
}

/** A linked project on one placement: its newest build for that placement, and Compile. */
function LinkedFirmware({ project, occurrence, canEdit }: { project: FirmwareProject; occurrence: { design: string; instance: string }; canEdit: boolean }): JSX.Element {
  const client = useQueryClient();
  const page = useQuery({
    queryKey: firmwareProjectKey(project.id), queryFn: () => unwrap(fetchFirmwareProject(project.id)), retry: false,
    refetchInterval: (q) => (q.state.data?.builds.some((b) => b.status === 'queued' || b.status === 'running') === true ? 1500 : false),
  });
  const own = project.occurrences.find((o) => o.design === occurrence.design && o.instance === occurrence.instance);
  const n = Object.keys(own?.overrides ?? {}).length;
  const build = (page.data?.builds ?? []).find((b) => b.occurrence?.design === occurrence.design && b.occurrence.instance === occurrence.instance);
  const running = build !== undefined && (build.status === 'queued' || build.status === 'running');
  const size = build?.findings.filter((f) => /^(RAM|FLASH):/.test(f.message)).map((f) => f.message).join('\n');
  const compile = async (): Promise<void> => {
    const out = await startCompile(project.id, occurrence);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    await client.invalidateQueries({ queryKey: firmwareProjectKey(project.id) });
  };
  return (
    <span className="inline-flex items-center gap-1">
      <Link to="/firmware/$id" params={{ id: project.id }} search={occurrence} className="underline">
        {project.label}{n === 0 ? '' : ` (${n} override${n === 1 ? '' : 's'})`}
      </Link>
      {build === undefined ? null : <Chip tone={BUILD_TONE[build.status]} title={size === '' ? undefined : size}>{BUILD_LABEL[build.status]}</Chip>}
      {canEdit ? <Button size="xs" loading={running} disabled={running || project.source.length === 0} title={project.source.length === 0 ? 'No source yet' : undefined} onClick={() => void compile()}>Compile</Button> : null}
    </span>
  );
}

const BUILD_TONE: Record<FirmwareBuild['status'], Tone> = { queued: 'info', running: 'info', ok: 'ok', failed: 'err', error: 'warn', cancelled: 'neutral' };
const BUILD_LABEL: Record<FirmwareBuild['status'], string> = { queued: 'queued', running: 'compiling', ok: 'compiled', failed: 'failed', error: 'could not run', cancelled: 'cancelled' };

/** One board placement's firmware: linked projects (newest build, Compile), one-click Link for the board's others. */
function OccurrenceFirmware({ design, instance, board, projects, canEdit }: { design: string; instance: string; board: string; projects: FirmwareProject[]; canEdit: boolean }): JSX.Element {
  const client = useQueryClient();
  const occurrence = { design, instance };
  const linked = projects.filter((p) => p.occurrences.some((o) => o.design === design && o.instance === instance));
  const forBoard = projects.filter((p) => p.board === board && !linked.includes(p));
  const link = async (project: FirmwareProject): Promise<void> => {
    const all = await unwrap(fetchFirmware());
    const next = all.projects.map((p) => (p.id === project.id ? { ...p, occurrences: [...p.occurrences, { design, instance, overrides: {} }] } : p));
    const out = await saveFirmware(next, all.etag);
    if (!out.ok) return void toast.error(out.message, { description: out.hint });
    client.setQueryData(firmwareKey, out.value);
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-occurrence={instance}>
      <Chip mono>{instance}</Chip>
      {linked.map((p) => <LinkedFirmware key={p.id} project={p} occurrence={occurrence} canEdit={canEdit} />)}
      {forBoard.map((p) => canEdit ? (
        <Button key={p.id} size="xs" variant="ghost" title={`Link ${p.label} to ${instance}`} onClick={() => void link(p)}>Link {p.label}</Button>
      ) : null)}
      {linked.length === 0 && forBoard.length === 0 ? (
        <Link to="/firmware" search={{ board, ...occurrence }} className="text-muted underline">add firmware</Link>
      ) : null}
    </div>
  );
}

/** The design inspector's per-occurrence firmware: one row per board placed in the design. */
export function DesignFirmware({ design, className = 'mx-2' }: { design: CableDesign; className?: string }): JSX.Element | null {
  const list = useFirmware();
  const studio = useOptionalStudio();
  const canEdit = studio?.me?.role !== 'viewer';
  const boards = design.instances.pcbas;
  if (boards.length === 0) return null;
  const projects = list.data?.projects ?? [];
  return (
    <Section id="design-firmware" title="Firmware" testId="design-firmware" className={className} summary={`${boards.length} board${boards.length === 1 ? '' : 's'}`}>
      <div className="flex flex-col gap-1">
        {boards.map((inst) => <OccurrenceFirmware key={inst.id} design={design.id} instance={inst.id} board={inst.def} projects={projects} canEdit={canEdit} />)}
      </div>
    </Section>
  );
}

/** The editor's extensions with the firmware rows added to the inspector. */
export function withDesignFirmware(extensions: EditorExtensions | undefined): EditorExtensions {
  const inner = extensions?.inspector;
  return {
    ...(extensions ?? {}),
    inspector: (context) => (
      <>
        {inner?.(context)}
        {/* per-board firmware belongs with the parts, not under every tab */}
        {context.inspectorTab !== undefined && context.inspectorTab !== 'part' ? null : <DesignFirmware design={context.design} />}
      </>
    ),
  };
}
