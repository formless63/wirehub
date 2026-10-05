#!/usr/bin/env -S node --experimental-strip-types
/**
 * Rewrite a git repository's history to drop the owner-only settings documents
 * (`docs/self-hosting.md` "Older history of the git mirror").
 *
 *   pnpm --filter studio mirror:purge <repo-folder> [--path <file>]... [--dry-run] [--confirm <folder name>]
 *
 * `<repo-folder>` is a local clone or working copy of the mirror (or the file backend's git
 * export) — never a URL. It always starts with a dry run that changes nothing; without
 * `--dry-run` it then asks you to type the folder's name, or takes it from `--confirm` when
 * there is no terminal. It never pushes and never touches a remote: publishing the rewritten
 * history (a force push, or better a fresh empty repository) is your step. Work on a copy
 * (`git clone --mirror`) if you want the original kept.
 *
 * `--path` names a file to drop instead of the default three settings documents (repeat it).
 */

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { confirmationWord, describeInspection, inspect, PurgeError, rewrite } from '../server/history/purge-paths.ts';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { path: { type: 'string', multiple: true }, 'dry-run': { type: 'boolean' }, confirm: { type: 'string' }, help: { type: 'boolean' } },
});

const usage = 'usage: mirror-purge.ts <repo-folder> [--path <file>]... [--dry-run] [--confirm <folder name>]';

try {
  if (values.help === true || positionals.length !== 1) {
    console.error(usage);
    process.exit(values.help === true ? 0 : 2);
  }
  const target = positionals[0] as string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[^/\s]+@[^/\s]+:/.test(target)) throw new PurgeError('This works on a local folder only; clone the repository first (git clone --mirror <url> <folder>).');
  const options = values.path === undefined ? {} : { paths: values.path };

  const plan = inspect(target, options);
  console.log('Dry run — nothing is changed:');
  for (const line of describeInspection(plan)) console.log(`  ${line}`);
  if (values['dry-run'] === true || plan.holding === 0) process.exit(0);

  const word = confirmationWord(plan.repo);
  let given = values.confirm;
  if (given === undefined) {
    if (!process.stdin.isTTY) throw new PurgeError(`Not a terminal: pass --confirm ${word} to rewrite ${plan.repo}.`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    given = await rl.question(`\nThis rewrites ${plan.repo} for good. Type its folder name (${word}) to continue: `);
    rl.close();
  }
  if (given.trim() !== word) throw new PurgeError(`Not confirmed (expected ${word}); nothing was changed.`);

  const done = rewrite(target, { ...options, log: (line) => console.log(line) });
  console.log(`\nRewrote ${done.rewritten} commits, dropped ${done.dropped} that only touched those paths.`);
  console.log(`Moved: ${done.movedRefs.join(', ') || 'none'}. Deleted: ${done.deletedRefs.join(', ') || 'none'}.`);
  if (done.remaining.length > 0) console.log(`Still present in some other ref (a stash, a linked worktree?): ${done.remaining.join(', ')}. Remove that ref, then run this again.`);
  else console.log('No reachable commit holds those paths now.');
  console.log('\nNext: publish this history yourself (a fresh empty repository, or git push --force-with-lease after reading the docs).');
  console.log('Anyone who cloned or forked the old history still has it; treat what those files held as seen.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
