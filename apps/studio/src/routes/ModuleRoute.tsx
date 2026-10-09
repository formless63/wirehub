/**
 * `/m/<module>/<path>` — a page a module contributes (`UiRouteContribution`),

 */

import { useMatches } from '@tanstack/react-router';
import { Page } from '@wirehub/editor-react';
import type { RouteProps } from '@wirehub/modules';
import { useMemo, type ComponentType, type JSX } from 'react';

import { moduleApi } from '../modules/api.ts';
import { useModules } from '../modules/ModulesContext.tsx';
import { RouteHeader } from '../shell/RouteHeader.tsx';
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
  const ModulePage = found.component as ComponentType<RouteProps>;
  return (
    <Page>
      <RouteHeader title={found.label} />
      <div className="cs-module-route min-h-0 flex-1 overflow-auto p-4" data-module={module} data-route={path}>
        <ModulePage module={module} path={path} db={studio.db} api={api} />
      </div>
    </Page>
  );
}
