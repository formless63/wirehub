/**
 * Outcome toasts for installs, uninstalls and saves (sonner, mounted by `App.tsx`):
 * success with a "View" action that goes where the change landed, error with its
 * detail. Works outside the router (tests, other hosts) by falling back to a plain
 * location change.
 */

import { useRouter } from '@tanstack/react-router';
import { useMemo } from 'react';
import { toast } from 'sonner';

/** where "View" goes: a route, optionally with the Settings section */
export interface ViewTarget {
  to: '/library' | '/extensions' | '/settings' | '/cables';
  section?: string;
  /** an Extensions tab */
  tab?: string;
  /** A catalog pack whose contents the Library should show. */
  pack?: string;
}

export interface Notify {
  success(title: string, options?: { description?: string; view?: ViewTarget }): void;
  error(title: string, detail?: string): void;
}

export function useNotify(): Notify {
  const router = useRouter({ warn: false }) as { navigate: (options: { to: string; search?: Record<string, string> }) => unknown } | undefined | null;
  return useMemo<Notify>(() => ({
    success(title, options) {
      const view = options?.view;
      toast.success(title, {
        ...(options?.description === undefined ? {} : { description: options.description }),
        ...(view === undefined
          ? {}
          : {
              action: {
                label: 'View',
                onClick: () => {
                  const search = Object.fromEntries(Object.entries({ section: view.section, tab: view.tab, pack: view.pack }).filter((entry): entry is [string, string] => entry[1] !== undefined));
                  if (router === undefined || router === null) window.location.assign(`${view.to}${Object.keys(search).length === 0 ? '' : `?${new URLSearchParams(search)}`}`);
                  else void router.navigate({ to: view.to, search });
                },
              },
            }),
      });
    },
    error(title, detail) {
      toast.error(title, detail === undefined || detail === '' ? {} : { description: detail });
    },
  }), [router]);
}
