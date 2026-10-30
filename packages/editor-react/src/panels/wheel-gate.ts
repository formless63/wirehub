/**
 * A 3D view on a long page must not trap the page's scrolling: the wheel zooms only once the view
 * was clicked (until a click elsewhere), or with Ctrl held; otherwise it scrolls the page.
 */

import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Gate `controls`' wheel zoom on `canvas`; returns the cleanup. */
export function gateWheelZoom(controls: OrbitControls, canvas: HTMLElement): () => void {
  let active = false;
  controls.enableZoom = false;
  // on the parent, in capture: runs before the controls' own wheel listener on the canvas
  const host = canvas.parentElement ?? canvas;
  const onWheel = (e: WheelEvent): void => {
    if (e.target !== canvas) return;
    controls.enableZoom = active || e.ctrlKey || e.metaKey;
  };
  const onDown = (e: PointerEvent): void => {
    active = e.target === canvas;
  };
  host.addEventListener('wheel', onWheel, { capture: true });
  document.addEventListener('pointerdown', onDown, { capture: true });
  canvas.title = canvas.title || 'Click to zoom with the wheel, or hold Ctrl';
  return () => {
    host.removeEventListener('wheel', onWheel, { capture: true });
    document.removeEventListener('pointerdown', onDown, { capture: true });
  };
}
