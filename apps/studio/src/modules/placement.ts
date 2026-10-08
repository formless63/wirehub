/**
 * Where a module's UI route is offered (`UiRouteContribution.placement`, module API 1.6).
 * A route with no placement is listed on the Modules page. `rail` is a request: the host
 * honours it only for a module the owner allowed (`railModules` in `modules.config.ts`),
 * and otherwise treats it as `extensions`. An older module's `icon` no longer adds a rail
 * item by itself.
 */

import type { ModuleRegistry, RoutePlacement, UiRouteContribution } from '@wirehub/modules';

export type PlacedRoute = UiRouteContribution & { module: string };

/** the place a route ends up in, after the owner's rail allow-list */
export function effectivePlacement(route: PlacedRoute, railModules: readonly string[]): Exclude<RoutePlacement, 'rail'> | 'rail' {
  const declared: RoutePlacement = route.placement ?? 'extensions';
  return declared === 'rail' && !railModules.includes(route.module) ? 'extensions' : declared;
}

export function routesIn(registry: ModuleRegistry, place: RoutePlacement, railModules: readonly string[]): PlacedRoute[] {
  return registry.routes().filter((route) => effectivePlacement(route, railModules) === place);
}
