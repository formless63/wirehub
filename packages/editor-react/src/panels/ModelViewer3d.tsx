/**
 * The 3D view — a three.js canvas with orbit
 * controls, fit/reset and top/front/side presets. The default export is what
 * `ModelPanel` lazy-loads, so three.js is its own chunk and a Library page
 * without a model never downloads it.
 *
 * Draws on demand (a control change, a resize, a theme change), never in a
 * loop: an idle Library page costs nothing. Without WebGL (an old browser,
 * jsdom) the canvas stays and a sentence says why nothing is drawn.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { applyMaterials, countTriangles, disposeObject, frameBox, makeLights, modelSize, parseModel } from '../model-scene.ts';
import type { ViewPreset } from '../models.ts';
import { NO_WEBGL, readPalette, webglContext } from './viewer-dom.ts';

export interface ModelViewer3dProps {
  bytes: ArrayBuffer;
  mime: string;
  /** for the canvas's accessible name */
  label: string;
  /** CSS height of the view */
  height?: number;
}

interface Live {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Object3D;
  lights: THREE.Group;
  box: THREE.Box3;
  render: () => void;
}

export default function ModelViewer3d(props: ModelViewer3dProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [info, setInfo] = useState<string>('');
  const [preset, setPreset] = useState<ViewPreset>('iso');

  /** a preset, or `'fit'`: the whole part in frame from where the camera looks now */
  const frame = useCallback((next: ViewPreset | 'fit'): void => {
    const l = live.current;
    if (l === undefined) return;
    const along = next === 'fit' ? l.camera.position.clone().sub(l.controls.target) : next;
    const f = frameBox(l.box, along, l.camera.fov, l.camera.aspect);
    l.camera.position.copy(f.position);
    l.camera.near = f.near;
    l.camera.far = f.far;
    if (next !== 'fit') l.camera.up.set(0, 1, 0);
    l.camera.updateProjectionMatrix();
    l.controls.target.copy(f.target);
    l.controls.update();
    l.render();
    if (next !== 'fit') setPreset(next);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null) return;
    let cancelled = false;
    let cleanup = (): void => undefined;
    const gl = webglContext(canvas);
    if (gl === null) {
      setProblem(`${NO_WEBGL}, so the model is not shown. It is still stored with the part.`);
      return;
    }
    void (async () => {
      let model: THREE.Object3D;
      try {
        model = await parseModel(props.bytes, props.mime);
      } catch (error) {
        if (!cancelled) setProblem(`The model could not be read: ${(error as Error).message}`);
        return;
      }
      if (cancelled) {
        disposeObject(model);
        return;
      }
      const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
      const palette = readPalette(host);
      scene.background = new THREE.Color(palette.background);
      applyMaterials(model, palette);
      let lights = makeLights(palette);
      scene.add(model, lights);
      // precise: vertices, not a file's declared bounds (a third-party GLB may declare them wrong)
      const box = new THREE.Box3().setFromObject(model, true);
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = false;
      controls.screenSpacePanning = true;
      const render = (): void => renderer.render(scene, camera);
      controls.addEventListener('change', render);
      live.current = { renderer, scene, camera, controls, model, lights, box, render };

      const resize = (): void => {
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(canvas.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        render();
      };
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined;
      observer?.observe(host);
      resize();
      frame('iso');

      // a theme toggle repaints the view with the other palette
      const themeWatch = new MutationObserver(() => {
        const next = readPalette(host);
        scene.background = new THREE.Color(next.background);
        applyMaterials(model, next);
        scene.remove(lights);
        lights = makeLights(next);
        scene.add(lights);
        if (live.current !== undefined) live.current.lights = lights;
        render();
      });
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });

      const size = modelSize(box);
      const triangles = countTriangles(model);
      setInfo(`${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm · ${triangles >= 1000 ? `${Math.round(triangles / 1000)}k` : triangles} triangles`);

      cleanup = (): void => {
        observer?.disconnect();
        themeWatch.disconnect();
        controls.removeEventListener('change', render);
        controls.dispose();
        disposeObject(model);
        renderer.dispose();
        live.current = undefined;
      };
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [props.bytes, props.mime, frame]);

  const presets: { id: ViewPreset; label: string; title: string }[] = [
    { id: 'top', label: 'Top', title: 'Look straight down' },
    { id: 'front', label: 'Front', title: 'Look at the front' },
    { id: 'side', label: 'Side', title: 'Look from the right side' },
  ];

  return (
    <div className="cs-model-view" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="cs-model-canvas"
        style={{ height: props.height ?? 320 }}
        role="img"
        aria-label={`3D model of ${props.label}. Drag to turn, scroll to zoom, right-drag to pan.`}
      />
      {problem !== undefined ? (
        <p className="cs-model-problem" role="status">
          {problem}
        </p>
      ) : (
        <div className="cs-model-tools" role="toolbar" aria-label="3D view">
          <button type="button" onClick={() => frame('iso')} title="Back to the starting view, the whole part in frame" aria-pressed={preset === 'iso'}>
            Reset
          </button>
          <button type="button" onClick={() => frame('fit')} title="Fit the whole part in the view, looking from where you are">
            Fit
          </button>
          {presets.map((p) => (
            <button key={p.id} type="button" onClick={() => frame(p.id)} title={p.title} aria-pressed={preset === p.id}>
              {p.label}
            </button>
          ))}
          {info === '' ? null : <span className="cs-model-info">{info}</span>}
        </div>
      )}
    </div>
  );
}
