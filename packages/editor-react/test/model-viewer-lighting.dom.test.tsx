// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import * as THREE from 'three';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ environments: [] as { texture: unknown; dispose: ReturnType<typeof vi.fn> }[], fail: false, draws: [] as unknown[], rendererDisposes: vi.fn() }));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return { ...actual, WebGLRenderer: class {
    setPixelRatio() {} setSize() {} dispose = state.rendererDisposes;
    render(scene: unknown) { state.draws.push(scene); }
  } };
});
vi.mock('three/examples/jsm/controls/OrbitControls.js', async () => {
  const three = await import('three');
  return { OrbitControls: class extends three.EventDispatcher {
    target = new three.Vector3(); update() {} dispose() {}
  } };
});
vi.mock('../src/panels/viewer-dom.ts', () => ({ webglContext: () => ({}), NO_WEBGL: 'WebGL is unavailable', readPalette: () => ({ background: '#121315', body: '#c9c4ba', dark: true }) }));
vi.mock('../src/model-scene.ts', async (original) => {
  const actual = await original<typeof import('../src/model-scene.ts')>();
  const three = await import('three');
  return { ...actual,
    parseModel: async () => new three.Group().add(new three.Mesh(new three.BoxGeometry(), new three.MeshStandardMaterial({ name: 'supplied', metalness: 1, roughness: 0.2 }))),
    makeStudioEnvironment: () => {
      if (state.fail) throw new Error('synthetic allocation failure');
      const value = { texture: new three.Texture(), dispose: vi.fn() };
      state.environments.push(value); return value;
    },
  };
});
import ModelViewer3d from '../src/panels/ModelViewer3d.tsx';

afterEach(() => {
  cleanup(); state.environments.length = 0; state.draws.length = 0; state.fail = false;
  state.rendererDisposes.mockClear(); document.documentElement.removeAttribute('data-theme');
});

it('reuses reflections through theme changes and releases them on model replacement and unmount', async () => {
  const view = render(<ModelViewer3d bytes={new ArrayBuffer(1)} mime="model/gltf-binary" label="Synthetic metal" />);
  await waitFor(() => expect(state.environments).toHaveLength(1));
  const first = state.environments[0]!;
  const scene = state.draws.at(-1) as THREE.Scene;
  expect(scene.environment).toBe(first.texture);
  const draws = state.draws.length;
  document.documentElement.setAttribute('data-theme', 'light');
  await waitFor(() => expect(state.draws.length).toBeGreaterThan(draws));
  expect(scene.environment).toBe(first.texture);
  expect(state.environments).toHaveLength(1);
  expect(first.dispose).not.toHaveBeenCalled();
  view.rerender(<ModelViewer3d bytes={new ArrayBuffer(2)} mime="model/gltf-binary" label="Synthetic replacement" />);
  await waitFor(() => expect(state.environments).toHaveLength(2));
  expect(first.dispose).toHaveBeenCalledOnce();
  expect(scene.environment).toBeNull();
  view.unmount();
  expect(state.environments[1]!.dispose).toHaveBeenCalledOnce();
  expect(state.rendererDisposes).toHaveBeenCalledTimes(2);
});

it('keeps model controls available with a truthful reflection fallback and clears it for a replacement', async () => {
  state.fail = true;
  const view = render(<ModelViewer3d bytes={new ArrayBuffer(1)} mime="model/gltf-binary" label="Synthetic part" />);
  expect(await screen.findByRole('note')).toHaveProperty('textContent', 'Studio reflections are unavailable; the model is shown with direct lighting.');
  expect(screen.getByRole('button', { name: 'Fit' })).toBeTruthy();
  const scene = state.draws.at(-1) as THREE.Scene;
  expect(scene.environment).toBeNull();
  expect(scene.getObjectByName('lights')).toBeDefined();
  state.fail = false;
  view.rerender(<ModelViewer3d bytes={new ArrayBuffer(2)} mime="model/gltf-binary" label="Synthetic replacement" />);
  await waitFor(() => expect(state.environments).toHaveLength(1));
  expect(screen.queryByRole('note')).toBeNull();
});
