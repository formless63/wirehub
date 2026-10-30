/**
 * The device's 3D view (WF-ASM): every placed node of a `deviceScene` — the generated enclosure
 * base and lid, board occurrences with their own models, hardware, schematic cable routes — in
 * one canvas. Lazy chunk (`DeviceViewer` in `DevicePanels.tsx` loads it).
 *
 * The scene is built once per scene/model set; selection, explode and section are applied to the
 * live objects afterwards and never touch the canonical matrices they were built from. Draws on
 * demand, never in a loop.
 *
 * Frames: the device is millimetres, z up (CAD). One root turns it to three's y up. A Library GLB
 * (y up, board-centred) is turned back and moved to the board-local origin (outline minimum).
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { gateWheelZoom } from './wheel-gate.ts';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import type { DeviceSceneNode, DeviceVec3 } from '@wirehub/model';

import { applyMaterials, disposeObject, frameBox, makeLights, parseModel } from '../model-scene.ts';
import type { ViewPreset } from '../models.ts';
import { NO_WEBGL, readPalette, readToken, webglContext } from './viewer-dom.ts';

/** Bytes of one model a node draws with. `frame`: how its axes relate to the device's. */
export interface DeviceModelFile {
  bytes: ArrayBuffer;
  mime: string;
  /** `glb-y-up`: a Library GLB; `stl-z-up`: CAD as is; `stl-flipped`: a print-oriented lid (turned 180° about x) */
  frame: 'glb-y-up' | 'stl-z-up' | 'stl-flipped';
  /** a GLB not centred on its outline (a board's native export, in its board-file coordinates): centre it across x and y */
  centre?: boolean;
}

export interface DeviceSection {
  axis: 'x' | 'y' | 'z';
  /** 0..1 across the scene's extent */
  at: number;
}

export interface DeviceViewer3dProps {
  nodes: readonly DeviceSceneNode[];
  /** model bytes by key (`modelKey`) */
  models: ReadonlyMap<string, DeviceModelFile>;
  /** the model a node draws, by key, or none (a placeholder is drawn) */
  modelKey: (node: DeviceSceneNode) => string | undefined;
  selected: readonly string[];
  onSelect: (path: string | undefined) => void;
  /** 0 = canonical placement; 1 = fully exploded (view only) */
  explode: number;
  section?: DeviceSection;
  height?: number;
  label: string;
}

interface Live {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  root: THREE.Group;
  objects: Map<string, THREE.Object3D>;
  box: THREE.Box3;
  render: () => void;
}

function matrixOf(m: number[][]): THREE.Matrix4 {
  const r = (i: number): number[] => m[i] ?? [0, 0, 0, 0];
  return new THREE.Matrix4().set(...(r(0) as [number, number, number, number]), ...(r(1) as [number, number, number, number]), ...(r(2) as [number, number, number, number]), ...(r(3) as [number, number, number, number]));
}

/** A node's centre in the device frame: its outline's middle for a sized board, else its origin. */
export function nodeCentre(node: DeviceSceneNode): DeviceVec3 {
  const m = node.matrix;
  if (m === undefined) return [0, 0, 0];
  const [sx, sy] = node.size ?? [0, 0, 0];
  const p: DeviceVec3 = [sx / 2, sy / 2, 0];
  return [0, 1, 2].map((i) => (m[i]?.[0] ?? 0) * p[0] + (m[i]?.[1] ?? 0) * p[1] + (m[i]?.[2] ?? 0) * p[2] + (m[i]?.[3] ?? 0)) as DeviceVec3;
}

/**
 * How far a node moves when exploded (device frame, mm, at explode = 1). View only.
 * Lids and hardware lift; boards lift in steps (by `rank`, so two boards never move together) and
 * spread outward from the scene centre — a design with no enclosure separates as visibly as one with.
 */
export function explodeOffset(node: DeviceSceneNode, extent: number, centre: DeviceVec3 = [0, 0, 0], rank = 0, count = 1): DeviceVec3 {
  const lift = Math.max(30, extent * 0.5);
  const outward = (k: number): [number, number] => {
    const c = nodeCentre(node);
    let dx = c[0] - centre[0];
    let dy = c[1] - centre[1];
    const len = Math.hypot(dx, dy);
    if (len < 1) {
      // on top of each other: fan out by rank
      if (count < 2) return [0, 0];
      const a = (rank / count) * Math.PI * 2;
      dx = Math.cos(a);
      dy = Math.sin(a);
      return [dx * lift * k, dy * lift * k];
    }
    return [(dx / len) * lift * k, (dy / len) * lift * k];
  };
  switch (node.kind) {
    case 'lid': return [0, 0, lift * 1.3];
    case 'board': {
      const [x, y] = outward(0.6);
      return [x, y, lift * (0.7 + 0.45 * rank)];
    }
    case 'hardware': {
      const z = node.matrix?.[2]?.[3] ?? 0;
      const [x, y] = outward(0.25);
      if (z <= 0.01) return [x, y, -lift * 0.5];
      return [x, y, z > extent * 0.3 ? lift * 2.2 : lift * 1.1];
    }
    default: return [0, 0, 0];
  }
}

async function parseFile(file: DeviceModelFile): Promise<THREE.Object3D> {
  if (file.frame === 'glb-y-up') {
    const obj = await parseModel(file.bytes, file.mime);
    const wrap = new THREE.Group();
    obj.rotation.x = Math.PI / 2; // y up → z up
    wrap.add(obj);
    if (file.centre === true) {
      const centre = new THREE.Box3().setFromObject(wrap).getCenter(new THREE.Vector3());
      obj.position.x -= centre.x;
      obj.position.y -= centre.y;
    }
    return wrap;
  }
  const geometry = new STLLoader().parse(file.bytes);
  if (file.frame === 'stl-flipped') geometry.rotateX(Math.PI);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

function tint(obj: THREE.Object3D, color: THREE.Color, opacity = 1): void {
  obj.traverse((n) => {
    const mesh = n as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const s = m as THREE.MeshStandardMaterial;
      s.color?.copy(color);
      s.metalness = 0.05;
      s.roughness = 0.7;
      if (opacity < 1) { s.transparent = true; s.opacity = opacity; s.depthWrite = false; }
    }
  });
}

/** A labelled placeholder: a board-sized slab, or a small block. */
function placeholder(node: DeviceSceneNode): THREE.Object3D {
  const [x, y, t] = node.size ?? (node.kind === 'board' ? [50, 30, 1.6] : [4, 4, 4]);
  const geo = new THREE.BoxGeometry(x, y, Math.max(t, 0.8));
  geo.translate(node.size === undefined && node.kind !== 'board' ? 0 : x / 2, node.size === undefined && node.kind !== 'board' ? 0 : y / 2, Math.max(t, 0.8) / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x3a7a55, roughness: 0.8, transparent: true, opacity: 0.75 }));
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x1d3a2a }));
  const g = new THREE.Group();
  g.add(mesh, edges);
  return g;
}

export default function DeviceViewer3d(props: DeviceViewer3dProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [preset, setPreset] = useState<ViewPreset>('iso');
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;

  const frame = useCallback((next: ViewPreset | 'fit'): void => {
    const l = live.current;
    if (l === undefined) return;
    const along = next === 'fit' ? l.camera.position.clone().sub(l.controls.target) : next;
    // Fit frames what is drawn now (an exploded view reaches further than the assembled one)
    const drawn = next === 'fit' ? new THREE.Box3().setFromObject(l.root, true) : l.box;
    const f = frameBox(drawn.isEmpty() ? l.box : drawn, along, l.camera.fov, l.camera.aspect, 1.25);
    l.camera.position.copy(f.position);
    l.camera.near = f.near;
    l.camera.far = f.far * 3;
    if (next !== 'fit') l.camera.up.set(0, 1, 0);
    l.camera.updateProjectionMatrix();
    l.controls.target.copy(f.target);
    l.controls.update();
    l.render();
    if (next !== 'fit') setPreset(next);
  }, []);

  // build the scene
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null) return;
    setProblem(undefined);
    const gl = webglContext(canvas);
    if (gl === null) {
      setProblem(`${NO_WEBGL}; the tree, ports and BOM still work.`);
      return;
    }
    let cancelled = false;
    let cleanup = (): void => undefined;
    void (async () => {
      const parsed = new Map<string, THREE.Object3D>();
      for (const [key, file] of props.models) {
        try {
          parsed.set(key, await parseFile(file));
        } catch {
          /* a model that cannot be read falls back to a placeholder */
        }
      }
      if (cancelled) { parsed.forEach(disposeObject); return; }
      const palette = readPalette(host);
      const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.localClippingEnabled = true;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(palette.background);
      const root = new THREE.Group();
      root.rotation.x = -Math.PI / 2; // z up → y up
      scene.add(root, makeLights(palette));
      const objects = new Map<string, THREE.Object3D>();
      const cableColor = new THREE.Color(readToken(host, '--copper') ?? 0xb87333);
      for (const node of props.nodes) {
        let obj: THREE.Object3D;
        if (node.kind === 'cable') {
          const pts = (node.points ?? []).map((p) => new THREE.Vector3(...p));
          if (pts.length < 2) continue;
          const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.2);
          obj = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, pts.length * 12), 2.2, 10, false), new THREE.MeshStandardMaterial({ color: cableColor, roughness: 0.55 }));
        } else if (node.kind === 'assembly') {
          continue;
        } else {
          const key = props.modelKey(node);
          const model = key === undefined ? undefined : parsed.get(key);
          if (model !== undefined) {
            obj = model.clone(true);
            obj.traverse((n) => { const m = n as THREE.Mesh; if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone(); });
            if (node.kind === 'board' && props.models.get(key!)?.frame === 'glb-y-up' && node.size !== undefined) {
              // the Library GLB is centred on its outline; board-local starts at the outline minimum
              obj.position.set(node.size[0] / 2, node.size[1] / 2, 0);
              const wrap = new THREE.Group();
              wrap.add(obj);
              obj = wrap;
            }
            if (node.kind === 'enclosure') tint(obj, new THREE.Color(palette.dark ? 0x7d838c : 0xa7adb5));
            if (node.kind === 'lid') tint(obj, new THREE.Color(palette.dark ? 0x9aa1aa : 0xc4c9cf), 0.55);
            if (node.kind !== 'enclosure' && node.kind !== 'lid') applyMaterials(obj, palette);
          } else {
            obj = placeholder(node);
          }
          const holder = new THREE.Group();
          holder.matrixAutoUpdate = false;
          holder.matrix.copy(matrixOf(node.matrix ?? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]));
          holder.add(obj);
          obj = holder;
        }
        obj.userData['path'] = node.path;
        objects.set(node.path, obj);
        root.add(obj);
      }
      const lids = new Set(props.nodes.filter((n) => n.kind === 'lid').map((n) => n.path));
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root, true);
      if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = false;
      controls.screenSpacePanning = true;
      const ungateWheel = gateWheelZoom(controls, canvas);
      const render = (): void => renderer.render(scene, camera);
      controls.addEventListener('change', render);
      live.current = { renderer, scene, camera, controls, root, objects, box, render };

      // click picks the nearest node; a drag (orbit) does not
      let down: { x: number; y: number } | undefined;
      const onDown = (e: PointerEvent): void => { down = { x: e.clientX, y: e.clientY }; };
      const onUp = (e: PointerEvent): void => {
        if (down === undefined || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
        const rect = canvas.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
        const planes = renderer.clippingPlanes;
        const pathOf = (o: THREE.Object3D | null): string | undefined => {
          let n = o;
          while (n !== null && n.userData['path'] === undefined) n = n.parent;
          return n === null ? undefined : (n.userData['path'] as string);
        };
        const hits = ray.intersectObject(root, true).filter((h) => planes.every((p) => p.distanceToPoint(h.point) >= 0) && (h.object as THREE.Mesh).isMesh);
        // the lid is see-through: pick what shows through it, the lid itself only when nothing does
        const through = hits.find((h) => !lids.has(pathOf(h.object) ?? ''));
        onSelect.current(pathOf((through ?? hits[0])?.object ?? null));
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);

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
      setPreset('iso');
      cleanup = (): void => {
        observer?.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        ungateWheel();
        controls.dispose();
        disposeObject(root);
        parsed.forEach(disposeObject);
        renderer.dispose();
        live.current = undefined;
      };
      applyView();
    })();
    return () => { cancelled = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nodes, props.models]);

  // selection, explode and section: presentation over the live objects
  const applyView = (): void => {
    const l = live.current;
    if (l === undefined) return;
    const host = hostRef.current;
    const accent = new THREE.Color((host === null ? undefined : readToken(host, '--accent')) ?? 0x3b82f6);
    const selected = new Set(props.selected);
    const size = l.box.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    // explode spreads from the middle of what is placed (device frame)
    const solid = props.nodes.filter((n) => n.kind !== 'cable' && n.kind !== 'assembly' && n.matrix !== undefined);
    const centres = solid.map(nodeCentre);
    const centre: DeviceVec3 = centres.length === 0 ? [0, 0, 0] : [0, 1, 2].map((i) => centres.reduce((t, c) => t + c[i]!, 0) / centres.length) as DeviceVec3;
    const boards = props.nodes.filter((n) => n.kind === 'board');
    for (const node of props.nodes) {
      const obj = l.objects.get(node.path);
      if (obj === undefined) continue;
      const on = selected.has(node.path);
      // with something else selected, the lid steps back so the selection shows through
      const ghost = node.kind === 'lid' && selected.size > 0 && !on;
      obj.traverse((n) => {
        const mesh = n as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const s = m as THREE.MeshStandardMaterial;
          if (s.emissive !== undefined) { s.emissive.copy(on ? accent : new THREE.Color(0x000000)); s.emissiveIntensity = on ? 0.55 : 0; }
          if (node.kind === 'lid') s.opacity = ghost ? 0.18 : 0.55;
        }
      });
      const d = explodeOffset(node, extent, centre, node.kind === 'board' ? boards.indexOf(node) : 0, boards.length);
      if (node.kind === 'cable') continue;
      // holders carry their matrix; explode adds a translation in the device frame on top
      const m = matrixOf(node.matrix ?? [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]);
      obj.matrix.copy(new THREE.Matrix4().makeTranslation(d[0] * props.explode, d[1] * props.explode, d[2] * props.explode).multiply(m));
    }
    l.root.updateMatrixWorld(true);
    if (props.section === undefined) {
      l.renderer.clippingPlanes = [];
    } else {
      // three frame: device x → x, device y → −z, device z → y
      const min = l.box.min;
      const max = l.box.max;
      const plane = props.section.axis === 'x'
        ? new THREE.Plane(new THREE.Vector3(-1, 0, 0), min.x + (max.x - min.x) * props.section.at)
        : props.section.axis === 'z'
          ? new THREE.Plane(new THREE.Vector3(0, -1, 0), min.y + (max.y - min.y) * props.section.at)
          : new THREE.Plane(new THREE.Vector3(0, 0, 1), -(max.z - (max.z - min.z) * props.section.at));
      l.renderer.clippingPlanes = [plane];
    }
    l.render();
  };
  useEffect(applyView);

  const presets: { id: ViewPreset; label: string }[] = [
    { id: 'top', label: 'Top' },
    { id: 'front', label: 'Front' },
    { id: 'side', label: 'Side' },
  ];
  return (
    <div className="cs-model-view" ref={hostRef}>
      <canvas
        ref={canvasRef}
        className="cs-model-canvas"
        style={{ height: props.height ?? 460 }}
        role="img"
        aria-label={`3D view of ${props.label}. Click a part to select it; drag to turn, scroll to zoom.`}
        data-testid="device-canvas"
      />
      {problem !== undefined ? <p className="cs-model-problem" role="status">{problem}</p> : (
        <div className="cs-model-tools" role="toolbar" aria-label="3D view">
          <button type="button" onClick={() => frame('iso')} aria-pressed={preset === 'iso'}>Reset</button>
          <button type="button" onClick={() => frame('fit')}>Fit</button>
          {presets.map((p) => <button key={p.id} type="button" onClick={() => frame(p.id)} aria-pressed={preset === p.id}>{p.label}</button>)}
        </div>
      )}
    </div>
  );
}
