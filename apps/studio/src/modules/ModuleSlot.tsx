/**
 * The frame every module-contributed panel sits in on a core page (Library detail, Documents):
 * a `Section` titled with the module's name and a "module" chip, collapsed by default, placed
 * after the page's own content by the host. The open state is remembered like any section's; a pin
 * (`slot-prefs.ts`, per user) keeps one open. A module whose required settings are not filled in
 * shows its header only, "not set up" and Set up → (Settings › Module settings), never its form.
 */

import { IconPin, IconPinFilled } from '@tabler/icons-react';
import { IconButton, Section, usePref } from '@wirehub/editor-react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';
import { useContext, type JSX, type ReactNode } from 'react';

import { runtimeSettingsQuery, type ModuleFieldView } from '../settings.browser.ts';
import { AppLink } from '../shell/AppLink.tsx';
import { useOptionalStudio } from '../studio-context.tsx';
import { useSlotPins } from './slot-prefs.ts';

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
  const sectionId = `module.${slotKey}`;
  const [pins, setPin] = useSlotPins(user);
  const pinned = pins.has(slotKey);
  // the Section's own remembered open state, read here only to say it on the frame
  const [remembered] = usePref<boolean>(`section.${sectionId}`, false, (v): v is boolean => typeof v === 'boolean');
  const chip = <span className="cs-module-chip">module</span>;
  if (incomplete) {
    return (
      <div className="cs-module-slot cs-ui-section" data-module-slot={slotKey} data-state="not-set-up" aria-label={`${label} (module)`}>
        <div className="cs-ui-section-head cs-module-slot-unset">
          <span className="cs-ui-section-title">{label}</span>
          {chip}
          <span className="cs-ui-section-sum">not set up</span>
          <span className="cs-spacer" />
          <AppLink to="/settings" section="module-settings" className="underline">Set up →</AppLink>
        </div>
      </div>
    );
  }
  const pin = (
    <IconButton
      size="xs"
      pressed={pinned}
      label={`${pinned ? 'Unpin' : 'Pin open'} ${label}`}
      icon={pinned ? <IconPinFilled size={12} aria-hidden /> : <IconPin size={12} aria-hidden />}
      onClick={() => setPin(slotKey, !pinned)}
    />
  );
  return (
    <div className="cs-module-slot" data-module-slot={slotKey} data-state={remembered || pinned ? 'open' : 'collapsed'} aria-label={`${label} (module)`}>
      <Section id={sectionId} title={label} summary={chip} defaultOpen={false} forceOpen={pinned} actions={pin}>
        {children}
      </Section>
    </div>
  );
}
