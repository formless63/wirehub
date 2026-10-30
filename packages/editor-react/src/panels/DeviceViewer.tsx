/** The device 3D view, loaded on demand: three.js stays its own chunk. */

import { lazy, Suspense, type JSX } from 'react';

import type { DeviceViewer3dProps } from './DeviceViewer3d.tsx';

const Viewer = lazy(() => import('./DeviceViewer3d.tsx'));

export function DeviceViewer(props: DeviceViewer3dProps): JSX.Element {
  return (
    <Suspense fallback={<div className="cs-model-view text-sm text-faint" style={{ height: props.height ?? 460 }}>Loading the 3D view…</div>}>
      <Viewer {...props} />
    </Suspense>
  );
}
