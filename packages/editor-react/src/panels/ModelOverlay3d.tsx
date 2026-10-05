/**
 * Two models in one 3D view, for comparing (`docs/revisions.md`): A drawn in one colour, B in
 * another, both translucent, on a shared frame, so what B added and what it took away shows where
 * the two do not coincide. A slider fades between them; A or B alone is the slider at an end. The
 * default export is lazy-loaded with the compare view, like `ModelViewer3d`.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { disposeObject, frameBox, makeLights, parseModel } from '../model-scene.ts';
import { NO_WEBGL, readPalette, webglContext } from './viewer-dom.ts';

export interface ModelOverlay3dProps {
  a: { bytes: ArrayBuffer; mime: string; label: string };
  b: { bytes: ArrayBuffer; mime: string; label: string };
  height?: number;
}

const COLOUR_A = 0xd9480f;
const COLOUR_B = 0x1c7ed6;

function paint(root: THREE.Object3D, colour: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: colour, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, metalness: 0.05, roughness: 0.6 });
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const old = mesh.material;
    for (const m of Array.isArray(old) ? old : [old]) m.dispose();
    mesh.material = material;
  });
  return material;
}

export default function ModelOverlay3d(props: ModelOverlay3dProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [mix, setMix] = useState(50);
  const materials = useRef<{ a: THREE.MeshStandardMaterial; b: THREE.MeshStandardMaterial; render: () => void } | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null) return;
    let cancelled = false;
    let cleanup = (): void => undefined;
    const gl = webglContext(canvas);
    if (gl === null) {
      setProblem(`${NO_WEBGL}, so the overlay is not shown.`);
      return;
    }
    void (async () => {
      let a: THREE.Object3D;
      let b: THREE.Object3D;
      try {
        [a, b] = await Promise.all([parseModel(props.a.bytes, props.a.mime), parseModel(props.b.bytes, props.b.mime)]);
      } catch (error) {
        if (!cancelled) setProblem(`A model could not be read: ${(error as Error).message}`);
        return;
      }
      if (cancelled) {
        disposeObject(a);
        disposeObject(b);
        return;
      }
      const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const scene = new THREE.Scene();
      const palette = readPalette(host);
      scene.background = new THREE.Color(palette.background);
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
      const ma = paint(a, COLOUR_A);
      const mb = paint(b, COLOUR_B);
      scene.add(a, b, makeLights(palette));
      const box = new THREE.Box3().setFromObject(a, true).union(new THREE.Box3().setFromObject(b, true));
      const controls = new OrbitControls(camera, canvas);
      controls.screenSpacePanning = true;
      const render = (): void => renderer.render(scene, camera);
      controls.addEventListener('change', render);
      materials.current = { a: ma, b: mb, render };
      const resize = (): void => {
        const width = Math.max(host.clientWidth, 1);
        const height = Math.max(canvas.clientHeight, 1);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        const f = frameBox(box, 'iso', camera.fov, camera.aspect);
        camera.position.copy(f.position);
        camera.near = f.near;
        camera.far = f.far;
        camera.updateProjectionMatrix();
        controls.target.copy(f.target);
        controls.update();
        render();
      };
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : undefined;
      observer?.observe(host);
      resize();
      cleanup = (): void => {
        observer?.disconnect();
        controls.removeEventListener('change', render);
        controls.dispose();
        disposeObject(a);
        disposeObject(b);
        renderer.dispose();
        materials.current = undefined;
      };
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [props.a.bytes, props.a.mime, props.b.bytes, props.b.mime]);

  // the fade: A fully at 0, B fully at 100, both at half in between
  useEffect(() => {
    const m = materials.current;
    if (m === undefined) return;
    m.a.opacity = Math.max(0.05, Math.min(0.9, (100 - mix) / 100));
    m.b.opacity = Math.max(0.05, Math.min(0.9, mix / 100));
    m.a.visible = mix < 100;
    m.b.visible = mix > 0;
    m.render();
  }, [mix]);

  return (
    <div className="cs-model-view" ref={hostRef} data-testid="model-overlay">
      <canvas ref={canvasRef} className="cs-model-canvas" style={{ height: props.height ?? 360 }} role="img" aria-label={`${props.a.label} and ${props.b.label}, laid over each other`} />
      {problem !== undefined ? (
        <p className="cs-model-problem" role="status">
          {problem}
        </p>
      ) : (
        <div className="cs-model-tools" role="toolbar" aria-label="Overlay">
          <span style={{ color: `#${COLOUR_A.toString(16)}` }}>A {props.a.label}</span>
          <input type="range" min={0} max={100} value={mix} aria-label="Fade between A and B" onChange={(e) => setMix(Number(e.target.value))} />
          <span style={{ color: `#${COLOUR_B.toString(16)}` }}>B {props.b.label}</span>
        </div>
      )}
    </div>
  );
}
