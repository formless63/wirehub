import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bake = vi.hoisted(() => ({ fromScene: vi.fn(), dispose: vi.fn() }));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return { ...actual, PMREMGenerator: class { fromScene = bake.fromScene; dispose = bake.dispose; } };
});

import { makeStudioEnvironment } from '../src/model-scene.ts';

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

function rendererStub() {
  const initial = new THREE.WebGLRenderTarget(8, 8);
  let current = initial;
  let face = 2;
  let mipmap = 3;
  const renderer = {
    xr: { enabled: true }, autoClear: true, toneMapping: THREE.ACESFilmicToneMapping,
    getRenderTarget: () => current, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mipmap,
    setRenderTarget(target: THREE.WebGLRenderTarget, nextFace = 0, nextMipmap = 0) { current = target; face = nextFace; mipmap = nextMipmap; },
  } as unknown as THREE.WebGLRenderer;
  return { renderer, initial };
}

describe('local studio reflections', () => {
  it('bakes a neutral local room and releases temporary resources before retaining the target', () => {
    const { renderer, initial } = rendererStub();
    const method = renderer.setRenderTarget;
    const output = new THREE.WebGLRenderTarget(16, 16);
    const texture = output.texture;
    const release = vi.spyOn(output, 'dispose');
    const observe = vi.spyOn(output, 'addEventListener');
    const unobserve = vi.spyOn(output, 'removeEventListener');
    const roomRelease = vi.spyOn(RoomEnvironment.prototype, 'dispose');
    bake.fromScene.mockImplementation(() => {
      renderer.setRenderTarget(output);
      renderer.xr.enabled = false; renderer.autoClear = false; renderer.toneMapping = THREE.NoToneMapping;
      expect(() => makeStudioEnvironment(renderer)).toThrow(/already being prepared/);
      return output;
    });
    const environment = makeStudioEnvironment(renderer);
    const room = bake.fromScene.mock.calls[0]![0] as RoomEnvironment;
    expect(room).toBeInstanceOf(RoomEnvironment);
    expect(room.getObjectByProperty('isLight', true)).toBeDefined();
    expect(bake.fromScene.mock.calls[0]![1]).toBe(0.04);
    expect(roomRelease).toHaveBeenCalledOnce();
    expect(bake.dispose).toHaveBeenCalledOnce();
    expect(environment.texture).toBe(texture);
    expect(renderer.setRenderTarget).toBe(method);
    expect(renderer.getRenderTarget()).toBe(initial);
    expect(renderer.getActiveCubeFace()).toBe(2);
    expect(renderer.getActiveMipmapLevel()).toBe(3);
    expect(renderer.xr.enabled).toBe(true);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(unobserve).toHaveBeenCalledWith('dispose', observe.mock.calls[0]![1]);
    expect(release).not.toHaveBeenCalled();
    environment.dispose();
    environment.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(['render', 'binding'])('restores renderer state and releases all bound targets after a %s failure', (failure) => {
    const { renderer, initial } = rendererStub();
    const originalMethod = renderer.setRenderTarget;
    const initialRelease = vi.spyOn(initial, 'dispose');
    const output = new THREE.WebGLRenderTarget(16, 16);
    const pingPong = new THREE.WebGLRenderTarget(16, 16);
    const outputRelease = vi.spyOn(output, 'dispose');
    const pingPongRelease = vi.spyOn(pingPong, 'dispose');
    const roomRelease = vi.spyOn(RoomEnvironment.prototype, 'dispose');
    if (failure === 'binding') {
      renderer.setRenderTarget = function (target, face, mipmap) {
        originalMethod.call(renderer, target, face, mipmap);
        if (target === pingPong) throw new Error('synthetic binding failure');
      };
    }
    const expectedMethod = renderer.setRenderTarget;
    // The real generator releases its internal ping-pong target itself.
    bake.dispose.mockImplementation(() => pingPong.dispose());
    bake.fromScene.mockImplementation(() => {
      renderer.xr.enabled = false;
      renderer.autoClear = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setRenderTarget(output, 4, 1);
      renderer.setRenderTarget(output, 5, 2); // one target bound more than once
      renderer.setRenderTarget(pingPong);
      throw new Error('synthetic render failure');
    });
    expect(() => makeStudioEnvironment(renderer)).toThrow(/synthetic .* failure/);
    expect(renderer.setRenderTarget).toBe(expectedMethod);
    expect(renderer.getRenderTarget()).toBe(initial);
    expect(renderer.getActiveCubeFace()).toBe(2);
    expect(renderer.getActiveMipmapLevel()).toBe(3);
    expect(renderer.xr.enabled).toBe(true);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.toneMapping).toBe(THREE.ACESFilmicToneMapping);
    expect(initialRelease).not.toHaveBeenCalled();
    expect(outputRelease).toHaveBeenCalledOnce();
    expect(pingPongRelease).toHaveBeenCalledOnce();
    expect(roomRelease).toHaveBeenCalledOnce();
    expect(bake.dispose).toHaveBeenCalledOnce();
  });
});
