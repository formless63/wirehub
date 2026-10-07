/**
 * `/m/<module>/<path>` — a page a module contributes (`UiRouteContribution`),
 * and `/modules` — the deployment's modules and their `settings` panels.
 */

import { useMatches } from '@tanstack/react-router';
import type { ModuleRegistry, RouteProps } from '@wirehub/modules';
import { useMemo, type ComponentType, type JSX } from 'react';

import { moduleApi } from '../modules/api.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { ModulePanels } from '../modules/slots.tsx';
import { PacksPanel } from '../modules/PacksPanel.tsx';
import { NotFoundView } from '../shell/NotFoundView.tsx';
import { useStudio } from '../studio-context.tsx';

export function ModuleRoute(): JSX.Element {
  const registry = useModules();
  const studio = useStudio();
  const matches = useMatches();
  const params = (matches[matches.length - 1]?.params ?? {}) as { module?: string; _splat?: string };
  const module = params.module ?? '';
  const path = (params._splat ?? '').replace(/\/+$/, '');
  const found = registry.routes().find((r) => r.module === module && r.path === path);
  const api = useMemo(() => moduleApi(module), [module]);
  if (found === undefined) return <NotFoundView message="No module page lives at that address." backTo="/cables" backLabel="Back to Cables" />;
  const Page = found.component as ComponentType<RouteProps>;
  return (
    <div className="cs-module-route h-full min-h-0 overflow-auto p-4" data-module={module} data-route={path}>
      <Page module={module} path={path} db={studio.db} api={api} />
    </div>
  );
}

/** a registry view that shows one module's panels, so a settings page groups them by module */
function onlyModule(registry: ModuleRegistry, id: string): ModuleRegistry {
  return { ...registry, panels: (slot) => registry.panels(slot).filter((p) => p.module === id) };
}

export function ModulesRoute(): JSX.Element {
  const registry = useModules();
  const studio = useStudio();
  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]">
      <h1 className="mb-3 text-[14px] font-semibold">Modules</h1>
      <PacksPanel />
      {registry.modules.map((m) => {
        const panels = registry.panels('settings').filter((p) => p.module === m.id);
        return (
          <section key={m.id} className="mb-4 border-b border-line pb-3" data-module={m.id}>
            <h2 className="text-[13px] font-medium">
              {m.label} <span className="text-faint">{m.id} {m.version}{m.license === undefined ? '' : ` · ${m.license}`}</span>
            </h2>
            {panels.length === 0 ? null : <ModulePanels registry={onlyModule(registry, m.id)} slot="settings" context={{ db: studio.db, readOnly: false }} />}
          </section>
        );
      })}
    </div>
  );
}
