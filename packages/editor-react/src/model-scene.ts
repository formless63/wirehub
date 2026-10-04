/**
 * The three.js half of the Library's 3D view:
 * bytes → a scene object, materials that read in both themes, and the
 * camera framing for fit / reset / top / front / side. DOM-free so the
 * loaders are unit-tested in Node; only `panels/ModelViewer3d.tsx` (the lazy
 * chunk) and tests import it.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

import { looksLikeGlb, VIEW_DIRECTIONS, type ViewPreset } from './models.ts';

export interface ScenePalette {
  background: string;
  /** the neutral body colour for a model that carries none */
  body: string;
  /** light theme: brighter key, weaker fill */
  dark: boolean;
}

/** Parse a stored model (GLB or STL) into an object ready to add to a scene. */
export async function parseModel(bytes: ArrayBuffer, mime = ''): Promise<THREE.Object3D> {
  if (mime === 'model/gltf-binary' || looksLikeGlb(bytes)) {
    const gltf = await new GLTFLoader().parseAsync(bytes, '');
    return gltf.scene;
  }
  if (mime === 'model/stl' || mime === '' || mime === 'application/octet-stream') {
    const geometry = new STLLoader().parse(bytes);
    // CAD is Z-up; the viewer (like glTF) is Y-up
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry);
    mesh.name = 'stl';
    const group = new THREE.Group();
    group.add(mesh);
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
    const previous = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined;
    // the source's own colour (a named glTF material — GLTFLoader's default
    // is unnamed), remembered the first time so a theme change re-applies it
    if (!('ownColor' in mesh.userData)) {
      mesh.userData['ownColor'] =
        previous !== undefined && previous.name !== '' && previous.color !== undefined ? `#${previous.color.getHexString()}` : null;
    }
    if (!('ownMap' in mesh.userData)) {
      mesh.userData['ownMap'] = previous !== undefined && previous.name !== '' && previous.map !== null ? (previous.map ?? null) : null;
    }
    const sourceColor = (mesh.userData['ownColor'] as string | null) ?? undefined;
    const sourceMap = mesh.userData['ownMap'] as THREE.Texture | null;
    if (sourceMap !== null) sourceMap.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshStandardMaterial({
      name: sourceMap !== null ? 'source-art' : sourceColor === undefined && !vertexColors ? 'neutral' : 'source',
      // a textured face is painted white so the map shows unshifted; its own colour otherwise
      color: sourceMap !== null ? 0xffffff : vertexColors ? 0xffffff : (sourceColor ?? palette.body),
      map: sourceMap,
      vertexColors,
      metalness: 0.05,
      roughness: 0.62,
      flatShading: !hasNormals,
      side: THREE.DoubleSide,
    });
    if (previous !== undefined && previous !== material) previous.dispose();
    mesh.material = material;
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
    mesh.geometry.dispose();
    const material = mesh.material;
    for (const m of Array.isArray(material) ? material : [material]) m.dispose();
  }
}
