/** A model's 3D view (`ModelViewer3d`), loaded on demand: three.js stays its own chunk. */

import { lazy, Suspense, type JSX } from 'react';

import type { ModelViewer3dProps } from './ModelViewer3d.tsx';

const Viewer = lazy(() => import('./ModelViewer3d.tsx'));

export function ModelViewer(props: ModelViewer3dProps): JSX.Element {
  return (
    <Suspense fallback={<div className="cs-model-view text-sm text-faint" style={{ height: props.height ?? 460 }}>Loading the 3D view…</div>}>
      <Viewer {...props} />
    </Suspense>
  );
}
