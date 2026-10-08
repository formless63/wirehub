/**
 * The frame every module-contributed panel sits in on a core page (Library detail, Documents):
 * titled with the module's name and a "module" chip, collapsible, collapsed by default, and
 * placed after the page's own content by the host. A person can pin one open; the pin is
 * remembered per user (`slot-prefs.ts`). A module whose required settings are not filled in
 * shows one line, "<Module> is not set up · Set up →", linking to Settings › Module settings,
 * never its form.
 */

import { IconChevronRight, IconPin, IconPinFilled } from '@tabler/icons-react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext, useState, type JSX, type ReactNode } from 'react';

import { runtimeSettingsQuery, type ModuleFieldView } from '../settings.browser.ts';
import { AppLink } from '../shell/AppLink.tsx';
import { useOptionalStudio } from '../studio-context.tsx';
import { readPins, writePin } from './slot-prefs.ts';

export interface ModuleSlotProps {
  /** the module's id and label */
  module: string;
  label: string;
  /** the page area it sits in: `library-detail` or `cable-documents` */
  slot: string;
  /** the module declares required settings (checked against Settings › Module settings) */
  requiresSetup: boolean;
  children: ReactNode;
}

/**
 * Required settings that are still empty. A setting that `gates` a provider belongs to that
 * provider's group: a module with several providers is set up once one group is complete
 * (Mouser's key alone is enough); settings with no `gates` must all be filled in.
 */
export function setupIncomplete(fields: readonly ModuleFieldView[]): boolean {
  const required = fields.filter((f) => f.required === true);
  const done = (f: ModuleFieldView): boolean => f.status !== 'missing';
  if (required.some((f) => f.gates === undefined && !done(f))) return true;
  const groups = new Map<string, ModuleFieldView[]>();
  for (const f of required) if (f.gates !== undefined) groups.set(f.gates, [...(groups.get(f.gates) ?? []), f]);
  return groups.size > 0 && ![...groups.values()].some((group) => group.every(done));
}

export function ModuleSlot(props: ModuleSlotProps): JSX.Element {
  const client = useContext(QueryClientContext);
  // the settings read needs the app's query client; a host without one shows the panel
  return props.requiresSetup && client !== undefined ? <SetupGate {...props} /> : <Frame {...props} incomplete={false} />;
}

function SetupGate(props: ModuleSlotProps): JSX.Element {
  const settings = useQuery(runtimeSettingsQuery);
  const mine = settings.data?.modules?.find((m) => m.module === props.module);
  // a restricted view (not an owner) cannot tell, so it is treated as set up
  const incomplete = mine !== undefined && mine.restricted !== true && setupIncomplete(mine.fields);
  return <Frame {...props} incomplete={incomplete} />;
}

function Frame({ module, label, slot, children, incomplete }: ModuleSlotProps & { incomplete: boolean }): JSX.Element {
  const user = useOptionalStudio()?.user ?? 'local';
  const slotKey = `${slot}/${module}`;
  const [pinned, setPinned] = useState(() => readPins(user).has(slotKey));
  const [open, setOpen] = useState(pinned);
  if (incomplete) {
    return (
      <section className="cs-module-slot is-unset" data-module-slot={slotKey} data-state="not-set-up" aria-label={`${label} (module)`}>
        <span className="cs-module-slot-title">{label}</span>
        <span className="cs-module-chip">module</span>
        <span className="cs-module-slot-note">
          {label} is not set up · <AppLink to="/settings" section="module-settings" className="underline">Set up →</AppLink>
        </span>
      </section>
    );
  }
  const togglePin = (): void => {
    const next = !pinned;
    setPinned(next);
    writePin(user, slotKey, next);
    if (next) setOpen(true);
  };
  return (
    <section className="cs-module-slot" data-module-slot={slotKey} data-state={open ? 'open' : 'collapsed'} aria-label={`${label} (module)`}>
      <header className="cs-module-slot-head">
        <button type="button" className="cs-module-slot-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <IconChevronRight size={13} aria-hidden className="cs-module-slot-caret" />
          <span className="cs-module-slot-title">{label}</span>
          <span className="cs-module-chip">module</span>
        </button>
        <button type="button" className="cs-module-slot-pin" aria-pressed={pinned} title={pinned ? 'Unpin: collapse this by default again' : 'Pin open: keep this expanded for you'} aria-label={`${pinned ? 'Unpin' : 'Pin open'} ${label}`} onClick={togglePin}>
          {pinned ? <IconPinFilled size={13} aria-hidden /> : <IconPin size={13} aria-hidden />}
        </button>
      </header>
      {open ? <div className="cs-module-slot-body">{children}</div> : null}
    </section>
  );
}
