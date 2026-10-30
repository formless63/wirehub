/**
 * "Use this view as cover" for both 3D views (`ModelViewer3d`, `WireModel3d`): the camera plus one
 * static render, handed to the host's shared cover resolver. Renders once and reads the pixels in
 * the same task, so no preserved drawing buffer or render loop is needed. Lazy chunks only.
 */

import { useCallback, useState, type JSX, type RefObject } from 'react';
import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { ModelCoverCamera } from '../models.ts';

/** What a 3D view offers when its host has a shared cover. */
export interface ViewerCover {
  camera?: ModelCoverCamera;
  stale?: boolean;
  disabled?: boolean;
  /** stores the capture; resolves to a problem sentence, or undefined when saved */
  onSave: (capture: { camera: ModelCoverCamera; image: Blob; width: number; height: number }) => Promise<string | undefined>;
}

export interface CoverLive {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  box: THREE.Box3;
  render: () => void;
}

/** Longest side of a stored cover render: a gallery image, not a print. */
const COVER_WIDTH = 960;

export function CoverTools3d({ live, cover }: { live: RefObject<CoverLive | undefined>; cover: ViewerCover }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const apply = useCallback((saved: ModelCoverCamera): void => {
    const l = live.current;
    if (l === undefined) return;
    l.camera.position.set(...saved.position);
    l.camera.up.set(...saved.up);
    l.camera.fov = saved.fov;
    l.controls.target.set(...saved.target);
    const distance = l.camera.position.distanceTo(l.controls.target);
    const radius = l.box.isEmpty() ? distance : l.box.getSize(new THREE.Vector3()).length() / 2;
    l.camera.near = Math.max(distance / 1000, 0.01);
    l.camera.far = distance + radius * 4 + 10;
    l.camera.updateProjectionMatrix();
    l.controls.update();
    l.render();
  }, [live]);

  const save = useCallback(async (camera?: ModelCoverCamera): Promise<void> => {
    const l = live.current;
    if (l === undefined) return;
    if (camera !== undefined) apply(camera);
    setBusy(true);
    setMessage(undefined);
    try {
      l.render();
      const source = l.renderer.domElement;
      const scale = Math.min(1, COVER_WIDTH / Math.max(1, source.width));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(source.width * scale));
      out.height = Math.max(1, Math.round(source.height * scale));
      const context = out.getContext('2d');
      if (context === null) throw new Error('This browser cannot draw a preview image.');
      context.drawImage(source, 0, 0, out.width, out.height);
      const image = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/webp', 0.9));
      if (image === null) throw new Error('This browser could not encode the preview image.');
      const now: ModelCoverCamera = {
        position: [l.camera.position.x, l.camera.position.y, l.camera.position.z],
        target: [l.controls.target.x, l.controls.target.y, l.controls.target.z],
        up: [l.camera.up.x, l.camera.up.y, l.camera.up.z],
        fov: l.camera.fov,
      };
      const problem = await cover.onSave({ camera: now, image, width: out.width, height: out.height });
      setMessage(problem ?? 'Cover saved from this view.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [live, cover, apply]);

  return (
    <>
      <button type="button" disabled={busy || cover.disabled === true} onClick={() => void save()} title="Store this camera and a static render as the record's cover">
        Use this view as cover
      </button>
      {cover.camera === undefined ? null : (
        <button type="button" onClick={() => apply(cover.camera!)} title="Show the camera the cover was saved with">
          Cover view
        </button>
      )}
      {cover.camera === undefined || cover.stale !== true ? null : (
        <button type="button" disabled={busy || cover.disabled === true} onClick={() => void save(cover.camera)} title="Re-render the saved cover camera from the current source">
          Refresh cover
        </button>
      )}
      {message === undefined ? null : <span className="cs-model-info" role="status">{message}</span>}
      {cover.stale === true && message === undefined ? <span className="cs-model-info" role="status">Saved cover view is out of date</span> : null}
    </>
  );
}
