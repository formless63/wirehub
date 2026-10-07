import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bake = vi.hoisted(() => ({ fromScene: vi.fn(), dispose: vi.fn() }));
vi.mock('three', async (original) => {
  const actual = await original<typeof import('three')>();
  return { ...actual, PMREMGenerator: class { fromScene = bake.fromScene; dispose = bake.dispose; } };
});

import { makeStudioEnvironment } from '../src/model-scene.ts';

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('local studio reflections', () => {
  it('bakes a neutral local room and releases temporary resources before retaining the target', () => {
    const texture = new THREE.Texture();
    const release = vi.fn();
    const roomRelease = vi.spyOn(RoomEnvironment.prototype, 'dispose');
    bake.fromScene.mockReturnValue({ texture, dispose: release });
    const environment = makeStudioEnvironment({} as THREE.WebGLRenderer);
    const room = bake.fromScene.mock.calls[0]![0] as RoomEnvironment;
    expect(room).toBeInstanceOf(RoomEnvironment);
    expect(room.getObjectByProperty('isLight', true)).toBeDefined();
    expect(bake.fromScene.mock.calls[0]![1]).toBe(0.04);
    expect(roomRelease).toHaveBeenCalledOnce();
    expect(bake.dispose).toHaveBeenCalledOnce();
    expect(environment.texture).toBe(texture);
    expect(release).not.toHaveBeenCalled();
    environment.dispose();
    environment.dispose();
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases temporary resources when allocation fails so direct lighting can remain usable', () => {
    const roomRelease = vi.spyOn(RoomEnvironment.prototype, 'dispose');
    bake.fromScene.mockImplementation(() => { throw new Error('synthetic render-target allocation failure'); });
    expect(() => makeStudioEnvironment({} as THREE.WebGLRenderer)).toThrow(/allocation failure/);
    expect(roomRelease).toHaveBeenCalledOnce();
    expect(bake.dispose).toHaveBeenCalledOnce();
  });
});
