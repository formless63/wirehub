/**
 * The device export routes (`devices/api.ts`), on their own: api.ts reads these statically and loads
 * the handler on first use, so the handler's imports never join api.ts's import cycle.
 */

export const DEVICE_ROUTES = [
  'GET    /api/devices/:id/exports',
  'POST   /api/devices/:id/exports',
] as const;

export function isDevicePath(path: string): boolean {
  return /^\/api\/devices(\/|$)/.test(path.split('?')[0] ?? '');
}
