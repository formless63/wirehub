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
  to: '/library' | '/modules' | '/settings' | '/cables';
  section?: string;
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
                  if (router === undefined || router === null) window.location.assign(`${view.to}${view.section === undefined ? '' : `?section=${view.section}`}`);
                  else void router.navigate({ to: view.to, ...(view.section === undefined ? {} : { search: { section: view.section } }) });
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
