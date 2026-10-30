/**
 * A re-run of a recorded tool run (`repro/api.ts`) names the exact image each pack ran in
 * (`request.pinImages`: `{ <pack>: 'sha256:…' }`). The stage handlers get a runner that starts
 * that image instead of the pack's current tag; a request without pins gets the runner as it is.
 */

import type { ToolRunner } from '../tools/runner.ts';

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export function pinsOf(request: Record<string, unknown>): Record<string, string> | undefined {
  const pins = request['pinImages'];
  if (typeof pins !== 'object' || pins === null || Array.isArray(pins)) return undefined;
  const out: Record<string, string> = {};
  for (const [pack, id] of Object.entries(pins)) if (typeof id === 'string' && IMAGE_ID.test(id)) out[pack] = id;
  return Object.keys(out).length === 0 ? undefined : out;
}

export function pinnedRunner(runner: ToolRunner, request: Record<string, unknown>): ToolRunner {
  const pins = pinsOf(request);
  if (pins === undefined) return runner;
  return {
    describe: runner.describe,
    available: (pack) => runner.available(pack),
    run: (req) => runner.run(pins[req.pack] === undefined || req.imageId !== undefined ? req : { ...req, imageId: pins[req.pack] }),
  };
}
