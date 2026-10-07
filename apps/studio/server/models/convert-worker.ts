/**
 * The STEP conversion child process (`convert.ts` forks it, one at a time).
 * Receives `{ bytes, name, maxTriangles }` over IPC, answers
 * `{ ok, glb, stats }` or `{ ok: false, error }`, then exits — so the WASM
 * heap OpenCascade grew is handed back to the OS with the process.
 */

import type { BoardTextureProfile } from './cache.ts';
import { assemble, type AssemblyPlan } from './assembly.ts';
import { applyBoardTexture, type BoardArt } from './board-texture.ts';
import { readStep } from './step.ts';
import { finishParts } from './finish.ts';
import type { MeshPart } from './mesh.ts';

interface Job {
  bytes: Uint8Array;
  name: string;
  maxTriangles: number;
  /** a board built from its KiCad file, or one placed library part */
  assembly?: AssemblyPlan;
  /** the board's own gerber-tier art, painted onto its top/bottom faces */
  boardArt?: BoardArt;
  boardTextureProfile?: BoardTextureProfile;
}

const isIges = (name: string): boolean => /\.(igs|iges)$/i.test(name);

/** A finer tessellation first; a coarser one when it comes out too heavy. */
async function tessellate(bytes: Uint8Array, name: string, budget: number): Promise<{ parts: MeshPart[]; deflection: number }> {
  let deflection = 0.001;
  let parts = await readStep(bytes, deflection, isIges(name));
  if (parts.reduce((n, p) => n + p.indices.length / 3, 0) > budget * 2) {
    deflection = 0.004;
    parts = await readStep(bytes, deflection, isIges(name));
  }
  return { parts, deflection };
}

process.once('message', (message: Job) => {
  void (async () => {
    const started = performance.now();
    try {
      let parts: MeshPart[];
      let deflection: number;
      const extras: Record<string, string | number> = { source: 'step' };
      const missing: string[] = [];
      if (message.assembly !== undefined) {
        const plan = message.assembly;
        const meshes: MeshPart[][] = [];
        // each model file read once; a file OpenCascade cannot read is left out, and said so
        for (const model of plan.models) {
          try {
            meshes.push((await tessellate(new Uint8Array(model.bytes), model.name, message.maxTriangles)).parts);
          } catch {
            meshes.push([]);
            missing.push(model.name);
          }
        }
        parts = assemble(plan, meshes);
        deflection = 0.001;
        extras['source'] = plan.board === undefined ? 'kicad-library' : 'kicad-assembly';
        extras['instances'] = plan.instances.length;
        if (missing.length > 0) extras['unreadModels'] = missing.join('; ');
      } else {
        ({ parts, deflection } = await tessellate(message.bytes, message.name, message.maxTriangles));
      }
      const tessellated = parts.reduce((n, p) => n + p.indices.length / 3, 0);
      // a bad SVG or a rasteriser hiccup paints nothing rather than refusing the whole model
      // (the board keeps its flat STEP/assembly colour instead —)
      let textured = parts;
      try {
        textured = await applyBoardTexture(parts, message.boardArt, message.boardTextureProfile);
      } catch (error) {
        extras['boardArtError'] = (error as Error).message;
      }
      const finished = finishParts(textured, message.maxTriangles, { ...extras, deflection });
      const usage = process.resourceUsage();
      process.send!(
        {
          ok: true,
          glb: finished.glb,
          stats: {
            ...finished.stats,
            tessellatedTriangles: tessellated,
            ...(missing.length === 0 ? {} : { unreadModels: missing }),
            deflection,
            ms: Math.round(performance.now() - started),
            // KiB → MiB; the child's own high-water mark
            peakRssMb: Math.round(usage.maxRSS / 1024),
          },
        },
        () => process.exit(0),
      );
    } catch (error) {
      process.send!({ ok: false, error: (error as Error).message }, () => process.exit(0));
    }
  })();
});
