#!/usr/bin/env -S node --experimental-strip-types
/**
 * `studio-api`: work on the studio's catalog as JSON files, through its own API.
 *
 *   WIREHUB_API_URL=https://wirehub.example.com WIREHUB_API_TOKEN=cst_… \
 *     pnpm --filter studio studio-api pull ./work
 *   (edit the JSON in ./work)
 *   pnpm --filter studio studio-api push ./work --dry-run
 *   pnpm --filter studio studio-api push ./work -m "Re-pin the RS-485 adapters" [--lock]
 *   pnpm --filter studio studio-api call GET /api/designs
 *   pnpm --filter studio studio-api call PUT /api/designs/x '{"id":"x",…}' [--if-match '"etag"']
 *
 * Details and the rules: `scripts/studio-api-lib.ts`, `specs/postgres-backend.md` §4.5.
 */

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ApiClient, ApiClientError, configFromEnv, formatResult, pull, push } from './studio-api-lib.ts';

const USAGE = 'usage: studio-api pull <dir> | push <dir> [--dry-run] [-m <message>] [--lock] | call <method> <path> [body] [--if-match <etag>]';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, message: { type: 'string', short: 'm' }, lock: { type: 'boolean' }, 'if-match': { type: 'string' } },
  });
  if (command !== 'pull' && command !== 'push' && command !== 'call') {
    console.error(USAGE);
    return 2;
  }
  const client = new ApiClient(configFromEnv(process.env));
  const from = (path: string): string => resolve(process.env['INIT_CWD'] ?? process.cwd(), path);
  if (command === 'pull') {
    if (positionals[0] === undefined) throw new ApiClientError(USAGE);
    const result = await pull(client, from(positionals[0]));
    console.log(`Pulled ${result.files} files at catalog version ${result.version} into ${result.dir}.`);
    return 0;
  }
  if (command === 'push') {
    if (positionals[0] === undefined) throw new ApiClientError(USAGE);
    const dryRun = values['dry-run'] === true;
    if (!dryRun && (values.message ?? '').trim() === '') throw new ApiClientError('Say what the change is: -m "<message>" (or --dry-run to look first).');
    const result = await push(client, from(positionals[0]), {
      dryRun,
      ...(values.message === undefined ? {} : { message: values.message }),
      ...(values.lock === true ? { lock: true } : {}),
      log: (line) => console.log(line),
    });
    for (const line of formatResult(result, dryRun)) console.log(line);
    return result.ok ? 0 : 1;
  }
  const [method, path, bodyText] = positionals;
  if (method === undefined || path === undefined || !path.startsWith('/api/')) throw new ApiClientError(USAGE);
  const answer = await client.request(method.toUpperCase(), path, {
    ...(bodyText === undefined ? {} : { body: JSON.parse(bodyText) as unknown }),
    ...(values['if-match'] === undefined ? {} : { headers: { 'if-match': values['if-match'] } }),
  });
  console.log(`${answer.status}${answer.etag === undefined ? '' : `  ETag: ${answer.etag}`}`);
  console.log(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body, null, 2));
  return answer.status < 400 ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof ApiClientError || error instanceof SyntaxError) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
}
