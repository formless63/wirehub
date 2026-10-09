/**
 * `/extensions` — the one place for what extends a hub: Browse (the store's packs and code
 * modules as cards, with filters and the install drawer), Installed (catalog packs, code modules
 * and the built-in modules, with their settings) and Sources (the stores this hub trusts).
 * Replaces Store, Modules, Settings › Code modules and Settings › Catalog stores.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Page, Switch, Tab, TabList, TabPanel, Tabs } from '@wirehub/editor-react';
import { toast } from 'sonner';
import type { JSX } from 'react';

import { fetchHub, hubKey, saveRailModules } from '../hub-settings.browser.ts';
import { useRailModules } from '../hooks/useRailModules.ts';
import { PacksPanel } from '../modules/PacksPanel.tsx';
import { StoreBrowser } from '../modules/StoreBrowser.tsx';
import { useModules } from '../modules/ModulesContext.tsx';
import { ModulePanels } from '../modules/slots.tsx';
import { effectivePlacement } from '../modules/placement.ts';
import { extensionsRoute } from '../router.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
import { useStudio } from '../studio-context.tsx';
import type { ModuleRegistry } from '@wirehub/modules';
import { allowedRailModules } from '../modules.browser.ts';
import { CodeModulesSettings } from './CodeModulesSettings.tsx';
import { StoreSourcesSettings } from './StoreSourcesSettings.tsx';

/** a registry view that shows one module's panels, so a list groups them by module */
function onlyModule(registry: ModuleRegistry, id: string): ModuleRegistry {
  return { ...registry, panels: (slot) => registry.panels(slot).filter((p) => p.module === id) };
}

/** The modules built into this image: their pages, their settings, and (owner only) whether they may add a rail item. */
function BuiltinModules(): JSX.Element {
  const registry = useModules();
  const studio = useStudio();
  const client = useQueryClient();
  const railAllowed = useRailModules();
  const hub = useQuery({ queryKey: hubKey, queryFn: () => fetchHub(), retry: false, staleTime: Infinity });
  const owner = studio.me === undefined || studio.me.role === undefined || studio.me.role === 'owner';
  const chosen = hub.data?.railModules ?? [];
  const setRail = async (id: string, on: boolean): Promise<void> => {
    const next = on ? [...new Set([...chosen, id])] : chosen.filter((m) => m !== id);
    const out = await saveRailModules(next);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    await client.invalidateQueries({ queryKey: hubKey });
  };
  return (
    <section className="cs-ext-section" data-testid="builtin-modules">
      <h2>Built-in modules</h2>
      {registry.modules.length === 0 ? <p className="text-faint">No modules are built into this hub.</p> : null}
      {registry.modules.map((m) => {
        const panels = registry.panels('settings').filter((p) => p.module === m.id);
        const routes = registry.routes().filter((r) => r.module === m.id);
        // the pages a module declared for this list (`extensions`, `settings`; an unallowed `rail` falls back here)
        const pages = routes.filter((r) => ['extensions', 'settings'].includes(effectivePlacement(r, railAllowed)));
        const wantsRail = routes.some((r) => r.placement === 'rail');
        return (
          <div key={m.id} className="border-b border-line pb-3" data-module={m.id}>
            <h3 className="m-0 text-sm font-medium">
              {m.label} <span className="text-faint">{m.id} {m.version}{m.license === undefined ? '' : ` · ${m.license}`}</span>
            </h3>
            {pages.length === 0 ? null : (
              <nav aria-label={`${m.label} pages`} className="my-1 flex flex-wrap gap-2" data-testid={`module-pages-${m.id}`}>
                {pages.map((page) => (
                  <Link key={page.path} to="/m/$module/$" params={{ module: m.id, _splat: page.path }} className="cs-ui-btn no-underline">
                    {page.label} →
                  </Link>
                ))}
              </nav>
            )}
            {panels.length === 0 ? null : (
              <Link to="/settings" search={{ section: 'module-settings' }} className="text-xs underline">
                Settings
              </Link>
            )}
            {wantsRail ? (
              <div className="mt-1">
                <Switch
                  label="Show in the rail"
                  checked={railAllowed.includes(m.id)}
                  disabled={!owner || allowedRailModules.includes(m.id)}
                  onCheckedChange={(on) => void setRail(m.id, on)}
                  aria-label={`Show ${m.label} in the rail`}
                />
              </div>
            ) : null}
            {panels.length === 0 ? null : <ModulePanels registry={onlyModule(registry, m.id)} slot="settings" context={{ db: studio.db, readOnly: false }} />}
          </div>
        );
      })}
    </section>
  );
}

export function ExtensionsRoute(): JSX.Element {
  const search = extensionsRoute.useSearch();
  const navigate = useNavigate();
  const tab = search.tab ?? 'browse';
  return (
    <Page testId="extensions">
      <RouteHeader title="Extensions" />
      <Tabs value={tab} onValueChange={(next) => void navigate({ to: '/extensions', search: { tab: next as 'browse' | 'installed' | 'sources' } })} className="flex min-h-0 flex-1 flex-col">
        <TabList aria-label="extensions" className="px-4">
          <Tab value="browse">Browse</Tab>
          <Tab value="installed">Installed</Tab>
          <Tab value="sources">Sources</Tab>
        </TabList>
        <TabPanel value="browse" className="flex min-h-0 flex-1 flex-col">
          <StoreBrowser {...(search.q === undefined ? {} : { initialQuery: search.q })} {...(search.pack === undefined ? {} : { openPack: search.pack })} />
        </TabPanel>
        <TabPanel value="installed" className="min-h-0 flex-1 overflow-auto p-4">
          <PacksPanel />
          <CodeModulesSettings />
          <BuiltinModules />
        </TabPanel>
        <TabPanel value="sources" className="min-h-0 flex-1 overflow-auto p-4">
          <StoreSourcesSettings />
        </TabPanel>
      </Tabs>
    </Page>
  );
}
