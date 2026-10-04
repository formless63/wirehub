/**
 * The parametric 3D wire, lazily: three.js is its own chunk, fetched the
 * first time a wire is shown in 3D.
 */

import { lazy, Suspense, type JSX } from 'react';

import type { WireModel3dProps } from './WireModel3d.tsx';

const WireModel3d = lazy(() => import('./WireModel3d.tsx'));

export function LazyWireModel3d(props: WireModel3dProps): JSX.Element {
  return (
    <Suspense fallback={<p className="cs-model-loading">Loading the 3D view…</p>}>
      <WireModel3d {...props} />
    </Suspense>
  );
}
