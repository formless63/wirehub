/**
 * The one way the backup runs git: `spawn('git', args)` with an explicit
 * argument array — never a shell string — and a timeout, so a hung ssh can
 * never hold the save queue forever.
 *
 * Every call disables hooks (`core.hooksPath=/dev/null`): the container has
 * none of the tools a developer's hooks expect (bd), and a studio commit is
 * data, not code. Prompts are off (`GIT_TERMINAL_PROMPT=0`; ssh gets
 * `BatchMode=yes` from `GIT_SSH_COMMAND` in the compose file), and output is
 * in the C locale so the error text the backup classifies is stable.
 */

import { spawn } from 'node:child_process';

export interface GitResult {
  /** the exit code; -1 when git could not be started or was killed on timeout */
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitCall {
  cwd: string;
  /** extra environment (author/committer identity) */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** `latin1`: stdout is bytes, one char each (a binary blob), to be read back with `Buffer.from(stdout, 'latin1')`; default utf8 */
  encoding?: 'utf8' | 'latin1';
}

export type GitRunner = (args: readonly string[], call: GitCall) => Promise<GitResult>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Options that go before every subcommand. */
export const GIT_PREFIX = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false'] as const;

export const execGit: GitRunner = (args, call) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn('git', [...GIT_PREFIX, ...args], {
      cwd: call.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(call.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: -1, stdout, stderr: `${stderr}\ngit ${args[0] ?? ''} timed out` });
    }, call.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.setEncoding(call.encoding ?? 'utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => done({ code: -1, stdout, stderr: error.message }));
    child.on('close', (code) => done({ code: code ?? -1, stdout, stderr }));
  });
