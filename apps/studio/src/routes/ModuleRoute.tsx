/**
 * `/m/<module>/<path>` — a page a module contributes (`UiRouteContribution`),
 * and `/modules` — the deployment's modules and their `settings` panels.
 */

import { Link, useMatches } from '@tanstack/react-router';
import type { ModuleRegistry, RouteProps } from '@wirehub/modules';
import { useMemo, type ComponentType, type JSX } from 'react';

import { moduleApi } from '../modules/api.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { ModulePanels } from '../modules/slots.tsx';
import { PacksPanel } from '../modules/PacksPanel.tsx';
import { allowedRailModules } from '../modules.browser.ts';
import { effectivePlacement } from '../modules/placement.ts';
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
  if (found === undefined) return <NotFoundView message="No module page lives at that address." backTo="/cables" backLabel="Back to Designs" />;
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
        // the pages a module declared for this list (`extensions`, `settings`; an unallowed `rail` falls back here)
        const pages = registry.routes().filter((r) => r.module === m.id && ['extensions', 'settings'].includes(effectivePlacement(r, allowedRailModules)));
        return (
          <section key={m.id} className="mb-4 border-b border-line pb-3" data-module={m.id}>
            <h2 className="text-[13px] font-medium">
              {m.label} <span className="text-faint">{m.id} {m.version}{m.license === undefined ? '' : ` · ${m.license}`}</span>
            </h2>
            {pages.length === 0 ? null : (
              <nav aria-label={`${m.label} pages`} className="my-1 flex flex-wrap gap-2" data-testid={`module-pages-${m.id}`}>
                {pages.map((page) => (
                  <Link key={page.path} to="/m/$module/$" params={{ module: m.id, _splat: page.path }} className="rounded border border-line bg-panel px-2.5 py-1 hover:bg-hover">
                    {page.label} →
                  </Link>
                ))}
              </nav>
            )}
            {panels.length === 0 ? null : <ModulePanels registry={onlyModule(registry, m.id)} slot="settings" context={{ db: studio.db, readOnly: false }} />}
          </section>
        );
      })}
    </div>
  );
}
