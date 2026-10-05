#!/usr/bin/env -S node --experimental-strip-types
/**
 * `render`: a design's documents and exports without a browser.
 *
 *   pnpm --filter studio render de9-crossover bom --format csv
 *   pnpm --filter studio render de9-crossover build-sheet --format pdf --rev latest --out ./out
 *   pnpm --filter studio render de9-crossover all --out ./out
 *   pnpm --filter studio render de9-crossover continuity.json --out -
 *
 * Details and the formats: `scripts/render-lib.ts`, `docs/exports.md`.
 */

import { resolve } from 'node:path';

import { configFromEnv } from './studio-api-lib.ts';
import { httpSource, localSource, parseRenderArgs, renderToFiles, RenderCliError, type RenderSource } from './render-lib.ts';

async function main(argv: string[]): Promise<number> {
  const args = parseRenderArgs(argv);
  if (args.out !== '-') args.out = resolve(process.env['INIT_CWD'] ?? process.cwd(), args.out);
  let source: RenderSource;
  let close = async (): Promise<void> => {};
  if ((process.env['WIREHUB_API_URL'] ?? '').trim() !== '') {
    const config = configFromEnv(process.env);
    source = httpSource(config.url, config.token);
  } else {
    const [{ workbenchDepsFromEnv }, { routeWorkbenchRequest }] = await Promise.all([import('../server/default-deps.ts'), import('../server/api.ts')]);
    const built = await workbenchDepsFromEnv(process.env);
    close = built.close;
    source = localSource((request) => routeWorkbenchRequest(request, built.deps));
  }
  try {
    await renderToFiles(source, args, { stdout: (bytes) => void process.stdout.write(bytes), log: (line) => console.error(line) });
  } finally {
    await close();
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof RenderCliError) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof Error && /^(Set WIREHUB_|WIREHUB_)/.test(error.message)) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
}
