/**
 * The three.js half of the Library's 3D view:
 * bytes → a scene object, materials that read in both themes, and the
 * camera framing for fit / reset / top / bottom / front / side. DOM-free so the
 * loaders are unit-tested in Node; only `panels/ModelViewer3d.tsx` (the lazy
 * chunk) and tests import it.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { looksLikeGlb, VIEW_DIRECTIONS, type ViewPreset } from './models.ts';

export interface ScenePalette {
  background: string;
  /** the neutral body colour for a model that carries none */
  body: string;
  /** light theme: brighter key, weaker fill */
  dark: boolean;
}

const sourceMaterials = new WeakMap<THREE.Mesh, readonly THREE.Material[]>();
const explicitMaterials = new WeakMap<THREE.Material, boolean>();
const suppliedAppearance = new WeakMap<THREE.Object3D, boolean>();
const activeStudioBakes = new WeakSet<THREE.WebGLRenderer>();

/** Parse a stored model (GLB or STL) into an object ready to add to a scene. */
export async function parseModel(bytes: ArrayBuffer, mime = ''): Promise<THREE.Object3D> {
  if (mime === 'model/gltf-binary' || looksLikeGlb(bytes)) {
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    // Material names are optional in glTF. Distinguish an explicit source
    // material from GLTFLoader's neutral default using its source association.
    for (const mesh of meshes(gltf.scene)) {
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        explicitMaterials.set(material, gltf.parser.associations.get(material)?.materials !== undefined);
      }
    }
    rememberAppearance(gltf.scene);
    return gltf.scene;
  }
  if (mime === 'model/stl' || mime === '' || mime === 'application/octet-stream') {
    const geometry = new STLLoader().parse(bytes);
    // CAD is Z-up; the viewer (like glTF) is Y-up
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry);
    mesh.name = 'stl';
    // STL has no material or sidedness declaration; keep open CAD surfaces visible.
    (mesh.material as THREE.Material).side = THREE.DoubleSide;
    const group = new THREE.Group();
    group.add(mesh);
    rememberAppearance(group);
    return group;
  }
  throw new Error(`The 3D view cannot show a ${mime} file.`);
}

/** Every mesh in `root`. */
function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) out.push(node as THREE.Mesh);
  });
  return out;
}

function rememberAppearance(root: THREE.Object3D): void {
  const parts = meshes(root);
  if (parts.length === 0) return;
  suppliedAppearance.set(root, parts.some((mesh) => mesh.geometry.getAttribute('color') !== undefined ||
    (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((material) => explicitMaterials.get(material) === true)));
}

/** Only parsed source declarations support a blanket appearance statement. */
export function modelAppearanceNote(root: THREE.Object3D): string | undefined {
  return suppliedAppearance.get(root) === false ? 'This model contains geometry only; its source does not specify colors or finishes.' : undefined;
}

/**
 * Materials for both themes: a model's own colours (vertex colours, or a
 * coloured glTF material — a board's green laminate) are kept; everything
 * else gets one neutral body colour. A mesh without normals (every STL we
 * store) is shaded flat, which is what a faceted print looks like anyway. A
 * board face painted with its own gerber art keeps
 * that texture — GLTFLoader decodes it fine, but the flat colour this
 * function used to build from scratch had no map on it at all, so the art
 * never showed.
 */
export function applyMaterials(root: THREE.Object3D, palette: ScenePalette): void {
  for (const mesh of meshes(root)) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const hasNormals = geometry.getAttribute('normal') !== undefined;
    const vertexColors = geometry.getAttribute('color') !== undefined;
    const previous = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!sourceMaterials.has(mesh)) sourceMaterials.set(mesh, previous);
    const sources = sourceMaterials.get(mesh)!;
    const materials = sources.map((source) => {
      const standard = source as THREE.MeshStandardMaterial;
      const explicit = explicitMaterials.get(source);
      const hasSource = explicit ?? (source.name !== '' || standard.map != null || (standard.color !== undefined && standard.color.getHex() !== 0xffffff));
      // Keep the full source material: base color multiplies its texture, and
      // alpha/normal/emissive maps and per-group materials must survive too.
      const material = hasSource ? source.clone() : new THREE.MeshStandardMaterial({ color: vertexColors ? 0xffffff : palette.body, metalness: 0.05, roughness: 0.62, side: source.side });
      material.name = hasSource ? standard.map != null ? 'source-art' : 'source' : 'neutral';
      if (material instanceof THREE.MeshStandardMaterial) {
        material.vertexColors = vertexColors;
        material.flatShading = !hasNormals;
      }
      return material;
    });
    for (const material of previous) material.dispose();
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0]!;
  }
}

export interface StudioEnvironment {
  texture: THREE.Texture;
  dispose(): void;
}

/** Local neutral studio reflections for supplied PBR materials, independent of theme.
 * No downloaded image or inferred finish: metalness/roughness remain the source's.
 * The temporary room and PMREM generator are released after baking; the caller
 * retains only the render target and releases it when the viewer closes.
 */
export function makeStudioEnvironment(renderer: THREE.WebGLRenderer): StudioEnvironment {
  if (activeStudioBakes.has(renderer)) throw new Error('Studio reflections are already being prepared.');
  const original = {
    setRenderTarget: renderer.setRenderTarget,
    target: renderer.getRenderTarget(),
    cubeFace: renderer.getActiveCubeFace(),
    mipmap: renderer.getActiveMipmapLevel(),
    xr: renderer.xr.enabled,
    autoClear: renderer.autoClear,
    toneMapping: renderer.toneMapping,
  };
  const generator = new THREE.PMREMGenerator(renderer);
  activeStudioBakes.add(renderer);
  type BoundTarget = NonNullable<Parameters<THREE.WebGLRenderer['setRenderTarget']>[0]>;
  const bound = new Set<BoundTarget>();
  const released = new Set<BoundTarget>();
  const observeRelease = (event: { target: BoundTarget }): void => { released.add(event.target); };
  let room: RoomEnvironment | undefined;
  let completed = false;
  // fromScene does not expose its output until it succeeds. Track only public
  // bindings during this synchronous bake: unbound targets have no GPU storage.
  // No source model or asynchronous rendering runs through this temporary wrapper.
  renderer.setRenderTarget = function (...args: Parameters<THREE.WebGLRenderer['setRenderTarget']>): void {
    const target = args[0];
    if (target !== null && target !== original.target && !bound.has(target)) {
      bound.add(target);
      target.addEventListener('dispose', observeRelease);
    }
    original.setRenderTarget.apply(renderer, args);
  };
  try {
    room = new RoomEnvironment();
    const target = generator.fromScene(room, 0.04);
    completed = true;
    let disposed = false;
    return {
      texture: target.texture,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        target.dispose();
      },
    };
  } finally {
    renderer.setRenderTarget = original.setRenderTarget;
    // Three restores these on success, but not if allocation/shader/rendering
    // throws. Binding the original target also restores its viewport/scissor.
    try {
      original.setRenderTarget.call(renderer, original.target, original.cubeFace, original.mipmap);
    } finally {
      renderer.xr.enabled = original.xr;
      renderer.autoClear = original.autoClear;
      renderer.toneMapping = original.toneMapping;
      try {
        room?.dispose();
        generator.dispose();
        if (!completed) for (const target of bound) if (!released.has(target)) target.dispose();
      } finally {
        for (const target of bound) target.removeEventListener('dispose', observeRelease);
        activeStudioBakes.delete(renderer);
      }
    }
  }
}

/** Key, fill and rim lights plus a hemisphere, tuned per theme. */
export function makeLights(palette: ScenePalette): THREE.Group {
  const group = new THREE.Group();
  group.name = 'lights';
  group.add(new THREE.HemisphereLight(0xffffff, palette.dark ? 0x30343a : 0x9a9690, palette.dark ? 1.4 : 1.1));
  const key = new THREE.DirectionalLight(0xffffff, palette.dark ? 1.9 : 1.6);
  key.position.set(1, 1.6, 1.2);
  const fill = new THREE.DirectionalLight(0xffffff, palette.dark ? 0.7 : 0.5);
  fill.position.set(-1.2, 0.4, -0.6);
  const rim = new THREE.DirectionalLight(0xffffff, 0.5);
  rim.position.set(0, -1, -1);
  group.add(key, fill, rim);
  return group;
}

export interface Framing {
  target: THREE.Vector3;
  position: THREE.Vector3;
  near: number;
  far: number;
}

/**
 * Where the camera goes to show all of `box` from `preset` (or along a
 * direction): the box's eight corners are fitted to both fields of view, so
 * a long flat part fills a wide view instead of sitting in the middle of its
 * bounding sphere. `margin` > 1 leaves room for the toolbar.
 */
export function frameBox(box: THREE.Box3, preset: ViewPreset | THREE.Vector3, fovDeg: number, aspect: number, margin = 1.15): Framing {
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * Math.max(aspect, 1e-3);
  const dir = (typeof preset === 'string' ? new THREE.Vector3(...VIEW_DIRECTIONS[preset]) : preset.clone()).normalize();
  // the camera's own axes when it looks along -dir with Y up
  let right = new THREE.Vector3(0, 1, 0).cross(dir);
  if (right.lengthSq() < 1e-8) right = new THREE.Vector3(1, 0, 0);
  right.normalize();
  const up = dir.clone().cross(right).normalize();
  let distance = 0;
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) {
        const offset = new THREE.Vector3(x, y, z).sub(center);
        const toward = offset.dot(dir);
        distance = Math.max(distance, toward + Math.abs(offset.dot(right)) / tanH, toward + Math.abs(offset.dot(up)) / tanV);
      }
    }
  }
  distance = Math.max(distance * margin, radius * 0.5);
  return {
    target: center.clone(),
    position: center.clone().add(dir.multiplyScalar(distance)),
    near: Math.max(distance / 1000, 0.01),
    far: distance * 10 + radius * 4,
  };
}

/** Size in millimetres, for the viewer's corner label. */
export function modelSize(box: THREE.Box3): { x: number; y: number; z: number } {
  const size = box.getSize(new THREE.Vector3());
  return { x: size.x, y: size.y, z: size.z };
}

/** Triangles in `root`. */
export function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  for (const mesh of meshes(root)) {
    const g = mesh.geometry as THREE.BufferGeometry;
    n += (g.index?.count ?? g.getAttribute('position')?.count ?? 0) / 3;
  }
  return Math.round(n);
}

export function disposeObject(root: THREE.Object3D): void {
  for (const mesh of meshes(root)) {
    sourceMaterials.delete(mesh);
    mesh.geometry.dispose();
    const material = mesh.material;
    for (const m of Array.isArray(material) ? material : [material]) m.dispose();
  }
}
