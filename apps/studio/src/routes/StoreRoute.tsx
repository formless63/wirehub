/**
 * `/library/store` — Browse store (`modules/StoreBrowser.tsx`): the packs the
 * trusted store indexes list, with Install / Update through the pack lifecycle.
 */

import type { JSX } from 'react';
import { Link } from '@tanstack/react-router';

import { libraryStoreRoute } from '../router.tsx';
import { StoreBrowser } from '../modules/StoreBrowser.tsx';

export function StoreRoute(): JSX.Element {
  const { q, pack } = libraryStoreRoute.useSearch();
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto">
      <div className="px-3 pt-2">
        <Link to="/library/$kind" params={{ kind: 'connectors' }} className="underline">
          ← Library
        </Link>
      </div>
      <StoreBrowser {...(q === undefined ? {} : { initialQuery: q })} {...(pack === undefined ? {} : { openPack: pack })} />
    </div>
  );
}
