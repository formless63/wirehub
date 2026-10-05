/**
 * Restarting WireHub from its own UI (`specs/runtime-modules.md` §4): an owner
 * presses Restart in Settings, the process drains — stops accepting, lets
 * in-flight requests finish, takes the write lock so no write is half done,
 * releases what it holds, stops its jobs, closes its pools — and exits with
 * `RESTART_EXIT_CODE`. The container's restart policy (`restart:
 * unless-stopped`) starts it again. Nothing outside the app is asked to do
 * anything: no Docker socket, no orchestrator API.
 */

import { randomUUID } from 'node:crypto';

/** The exit code of a requested restart: not a crash (1), not a stop (0). EX_TEMPFAIL, "try again". */
export const RESTART_EXIT_CODE = 75;

/** One step of the drain, run in order, each bounded in time. */
export interface DrainStep {
  name: string;
  run(): Promise<unknown>;
}

export interface SystemControl {
  /** changes with every start: the page waits for a new one */
  readonly bootId: string;
  readonly startedAt: string;
  /** a supervisor brings the process back (`WIREHUB_RESTART_SUPERVISED=true`, the image sets it) */
  readonly supervised: boolean;
  restarting(): boolean;
  /** drain and exit, soon (the answer is sent first); a second call is ignored */
  restart(by: string): void;
  /** the drain itself, awaited (tests) */
  drain(by: string): Promise<void>;
}

export interface SystemControlOptions {
  steps: () => readonly DrainStep[];
  /** how the process ends (tests pass their own) */
  exit?: (code: number) => void;
  log?: (line: string) => void;
  supervised?: boolean;
  /** pause before the drain starts, so the answer reaches the browser (ms) */
  delayMs?: number;
  /** a step that takes longer is left behind (ms) */
  stepTimeoutMs?: number;
  /** a fixed boot id (tests) */
  bootId?: string;
}

export function createSystemControl(options: SystemControlOptions): SystemControl {
  const log = options.log ?? ((line: string) => console.log(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const stepTimeout = options.stepTimeoutMs ?? 20_000;
  let restarting = false;
  let draining: Promise<void> | undefined;
  const drain = (by: string): Promise<void> => {
    draining ??= (async () => {
      restarting = true;
      log(`[restart] requested by ${by}: draining (stop accepting, finish in-flight work, release locks, close pools)`);
      for (const step of options.steps()) {
        const started = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            step.run(),
            new Promise((_, fail) => {
              timer = setTimeout(() => fail(new Error(`still running after ${Math.round(stepTimeout / 1000)} s; left behind`)), stepTimeout);
              timer.unref?.();
            }),
          ]);
          log(`[restart] ${step.name}: done (${Date.now() - started} ms)`);
        } catch (error) {
          log(`[restart] ${step.name}: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      log(`[restart] requested by ${by}: exiting with code ${RESTART_EXIT_CODE} (restart requested, not a crash)`);
      exit(RESTART_EXIT_CODE);
    })();
    return draining;
  };
  return {
    bootId: options.bootId ?? randomUUID(),
    startedAt: new Date().toISOString(),
    supervised: options.supervised ?? false,
    restarting: () => restarting,
    restart(by) {
      if (restarting) return;
      restarting = true;
      const timer = setTimeout(() => void drain(by), options.delayMs ?? 250);
      timer.unref?.();
    },
    drain,
  };
}

/** Count the requests in flight, and wait for them to finish (the drain's "finish in-flight" step). */
export function inFlightCounter(): { enter(): () => void; idle(): Promise<void>; readonly count: number } {
  let count = 0;
  let waiters: (() => void)[] = [];
  return {
    get count() {
      return count;
    },
    enter() {
      count += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        count -= 1;
        if (count === 0) {
          const now = waiters;
          waiters = [];
          for (const wake of now) wake();
        }
      };
    },
    idle: () => (count === 0 ? Promise.resolve() : new Promise<void>((wake) => waiters.push(wake))),
  };
}
