/**
 * The parametric 3D wire: a stock drawn from its own
 * definition — every layer at its documented diameter, laid where the 2D
 * cross-section lays it — with the strip, length, explode and lay under the
 * builder's hands. The default export is what the Library, the wire builder
 * and the Inspector lazy-load, so three.js stays in its own chunk.
 *
 * Owner, 2026-09-29: "create the coaxial and bonded multi-core wires as models where
 * the different parts and pieces were able to be manipulated? Like showing
 * different lengths, stripped back at different layers, etc. Perhaps even
 * allowing our existing wire creation tools to drive this process".
 *
 * Draws on demand (a control, a resize, a theme change), never in a loop.
 * Without WebGL (jsdom, an old browser) the canvas stays and a sentence says
 * why nothing is drawn.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

import type { WireDefinition } from '@wirehub/model';
import { wireModel, type StripEnd, type StripPreset, type WireEndShown, type WireModel } from '@wirehub/render-svg';

import { classes } from '../context.ts';
import { frameBox, makeLights } from '../model-scene.ts';
import { VIEW_DIRECTIONS } from '../models.ts';
import { editedEnd, initialWireView, modelOptionsOf, withStrip, type WireLayFacts, type WireViewState } from '../wire-view.ts';
import { buildWireObject, FALLBACK_COLOURS, type WireObject, type WirePalette } from '../wire-scene.ts';
import { isDarkTheme, NO_WEBGL, readPalette, readToken, webglContext } from './viewer-dom.ts';

export interface WireModel3dProps {
  wire: WireDefinition;
  /** "Bare cut" first, then the practice for this stock (`presetsFor`) */
  presets: readonly StripPreset[];
  /** the recipe's lay facts, when there is a recipe */
  facts?: WireLayFacts;
  /** where to start (a design segment's length and plan) */
  initial?: Partial<WireViewState>;
  /** the length is the design's: shown, not edited */
  lengthLocked?: boolean;
  height?: number;
  /** fewer controls (the builder's live preview) */
  compact?: boolean;
}

type View = 'iso' | 'top' | 'front' | 'side' | 'end';

interface Live {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  lights: THREE.Group;
  environment: THREE.Texture;
  object?: WireObject;
  box: THREE.Box3;
  render: () => void;
}

/**
 * Soft studio light for small metal and plastic parts: the shared rig turned
 * down, with a room environment doing most of the work — metals need
 * something to reflect, or copper renders as a dark rod.
 */
function softLights(palette: ReturnType<typeof readPalette>): THREE.Group {
  const lights = makeLights(palette);
  lights.traverse((o) => {
    const light = o as THREE.Light;
    if (light.isLight === true) light.intensity *= 0.55;
  });
  return lights;
}

function palettes(host: Element): { scene: ReturnType<typeof readPalette>; wire: WirePalette } {
  const colours: Record<string, string> = {};
  for (const name of Object.keys(FALLBACK_COLOURS)) {
    const value = readToken(host, `--cond-${name}`);
    if (value !== undefined) colours[name] = value;
  }
  // a black jacket on a near-black canvas still needs an edge
  if (isDarkTheme()) colours['black'] = '#2a2b2e';
  return { scene: readPalette(host), wire: { colours, dark: isDarkTheme() } };
}

const SHIELD_MODES: { value: StripEnd['shield']; label: string; title: string }[] = [
  { value: 'trim', label: 'Trim', title: 'Cut part of the exposed screen off; twist the rest (SW "Stripping Coax": ~80 % off)' },
  { value: 'gather', label: 'Gather', title: 'Unwind the screens back to the jacket and gather them into one lead' },
  { value: 'fold', label: 'Fold', title: 'Fold the exposed screen back over the layer outside it' },
  { value: 'keep', label: 'Keep', title: 'Leave the screen on, down to the insulation' },
];

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; title?: string; onChange: (value: number) => void }): JSX.Element {
  return (
    <label className="cs-w3-slider" title={props.title}>
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} aria-label={props.label} onChange={(e) => props.onChange(Number(e.target.value))} />
      <output className="cs-mono">
        {props.value}
        {props.unit ?? ''}
      </output>
    </label>
  );
}

export default function WireModel3d(props: WireModel3dProps): JSX.Element {
  const { wire, presets } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>('iso');
  const [stats, setStats] = useState<{ triangles: number; drawCalls: number; pieces: number } | undefined>(undefined);
  const [state, setState] = useState<WireViewState>(() => ({ ...initialWireView(presets), ...props.initial }));
  const facts = props.facts ?? {};
  const [themeTick, setThemeTick] = useState(0);
  const framed = useRef<string | undefined>(undefined);

  // a different stock (or preset list) starts from its own first preset; the view options stay
  const presetIds = presets.map((p) => p.id).join('|');
  const lastWire = useRef(wire.id);
  useEffect(() => {
    if (lastWire.current === wire.id) return;
    lastWire.current = wire.id;
    setState((s) => {
      const fresh = initialWireView(presets, { lengthMm: s.lengthMm, show: s.show });
      return { ...fresh, explode: s.explode, twist: s.twist, xray: s.xray, ...props.initial };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wire.id, presetIds]);

  const model: WireModel | undefined = useMemo(() => {
    try {
      return wireModel(wire, modelOptionsOf(state, wire, facts));
    } catch {
      return undefined;
    }
    // facts is a small object from the caller; its values are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wire, state, facts.layLengthMm, facts.hand, facts.filler]);

  const directionFor = useCallback(
    (next: View): THREE.Vector3 => {
      const toward = state.show === 'b' ? 1 : state.show === 'a' ? -1 : 0;
      if (next === 'end') return new THREE.Vector3(toward === 0 ? -1 : toward, 0.12, 0.18);
      // a 3/4 view from in front of the stripped end, a little above it
      if (next === 'iso') return toward === 0 ? new THREE.Vector3(0.25, 0.75, 1.15) : new THREE.Vector3(toward * 1.2, 0.8, 1.0);
      return new THREE.Vector3(...VIEW_DIRECTIONS[next]);
    },
    [state.show],
  );

  const frame = useCallback(
    (next: View | 'fit'): void => {
      const l = live.current;
      if (l === undefined || l.box.isEmpty()) return;
      const along = next === 'fit' ? l.camera.position.clone().sub(l.controls.target) : directionFor(next);
      const f = frameBox(l.box, along, l.camera.fov, l.camera.aspect, 1.02);
      l.camera.position.copy(f.position);
      l.camera.near = f.near;
      l.camera.far = f.far;
      l.camera.up.set(0, 1, 0);
      l.camera.updateProjectionMatrix();
      l.controls.target.copy(f.target);
      l.controls.update();
      l.render();
      if (next !== 'fit') setView(next);
    },
    [directionFor],
  );

  // the renderer, once per canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (canvas === null || host === null) return;
    const gl = webglContext(canvas);
    if (gl === null) {
      setProblem(`${NO_WEBGL}, so the wire is not drawn. Its cross-section and spec sheet still are.`);
      return;
    }
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // keeps the conductor colours' hues while taming the metal highlights
    renderer.toneMapping = THREE.NeutralToneMapping;
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();
    scene.environment = environment;
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    const { scene: palette } = palettes(host);
    scene.background = new THREE.Color(palette.background);
    scene.environmentIntensity = palette.dark ? 0.75 : 0.9;
    let lights = softLights(palette);
    scene.add(lights);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;
    const render = (): void => renderer.render(scene, camera);
    controls.addEventListener('change', render);
    live.current = { renderer, scene, camera, controls, lights, environment, box: new THREE.Box3(), render };

    // a bench hook for the performance check: n frames orbiting the model, ms per frame
    (canvas as HTMLCanvasElement & { csBench?: (frames: number) => number }).csBench = (frames: number): number => {
      const l = live.current;
      if (l === undefined) return NaN;
      const pixel = new Uint8Array(4);
      const target = l.controls.target.clone();
      const offset = l.camera.position.clone().sub(target);
      const start = performance.now();
      for (let i = 0; i < frames; i += 1) {
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), (2 * Math.PI) / frames);
        l.camera.position.copy(target).add(offset);
        l.camera.lookAt(target);
        l.renderer.render(l.scene, l.camera);
        const ctx = l.renderer.getContext();
        ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, pixel);
      }
      return (performance.now() - start) / frames;
    };

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

    const themeWatch = new MutationObserver(() => {
      const next = palettes(host);
      scene.background = new THREE.Color(next.scene.background);
      scene.remove(lights);
      lights = softLights(next.scene);
      scene.add(lights);
      scene.environmentIntensity = next.scene.dark ? 0.75 : 0.9;
      if (live.current !== undefined) {
        live.current.lights = lights;
        // colours come from the tokens: rebuild on a theme change
        setThemeTick((t) => t + 1);
      }
      render();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    setReady(true);

    return () => {
      observer?.disconnect();
      themeWatch.disconnect();
      controls.removeEventListener('change', render);
      controls.dispose();
      live.current?.object?.dispose();
      environment.dispose();
      renderer.dispose();
      live.current = undefined;
    };
  }, []);

  // the model → meshes, swapped in place; the camera re-frames for a new stock or end
  useEffect(() => {
    const l = live.current;
    const host = hostRef.current;
    if (!ready || l === undefined || host === null) return;
    if (l.object !== undefined) {
      l.scene.remove(l.object.group);
      l.object.dispose();
      l.object = undefined;
    }
    if (model === undefined) {
      l.box.makeEmpty();
      setStats(undefined);
      l.render();
      return;
    }
    const object = buildWireObject(model, palettes(host).wire);
    l.object = object;
    l.scene.add(object.group);
    l.box.set(new THREE.Vector3(model.span[0], -model.reach, -model.reach), new THREE.Vector3(model.span[1], model.reach, model.reach));
    setStats({ triangles: object.triangles, drawCalls: object.drawCalls, pieces: model.pieces.length });
    // re-frame for a new stock, end or length, and as the explode grows the model
    const key = `${wire.id}|${state.show}|${state.lengthMm}|${state.explode}`;
    if (framed.current !== key) {
      framed.current = key;
      frame('iso');
    } else l.render();
  }, [model, ready, themeTick, wire.id, state.show, state.lengthMm, state.explode, frame]);

  const end = editedEnd(state);
  const set = (patch: Partial<StripEnd>): void => setState((s) => withStrip(s, patch));
  const pickPreset = (id: string): void => {
    const preset = presets.find((p) => p.id === id);
    if (preset !== undefined) setState((s) => ({ ...s, preset: id, strip: preset.strip }));
  };
  const current = presets.find((p) => p.id === state.preset);
  const hasSheath = wire.structure.children.some((c) => c.kind === 'group' && c.role === 'coax');
  const hasDrain = wire.structure.children.some((c) => c.kind === 'conductor' && c.bare === true);
  const maxStrip = Math.max(20, Math.min(120, Math.round(state.lengthMm / 4)));

  const views: { id: View; label: string; title: string }[] = [
    { id: 'end', label: 'End', title: 'Look into the shown end' },
    { id: 'top', label: 'Top', title: 'Look straight down' },
    { id: 'front', label: 'Front', title: 'Look at the front' },
    { id: 'side', label: 'Side', title: 'Look along the cable' },
  ];

  return (
    <div className={classes('cs-model-view', 'cs-w3', props.compact === true && 'is-compact')} ref={hostRef}>
      <div className="cs-w3-stage">
      <canvas
        ref={canvasRef}
        className="cs-model-canvas"
        style={{ height: props.height ?? 340 }}
        role="img"
        aria-label={`3D model of ${wire.label}. Drag to turn, scroll to zoom, right-drag to pan.`}
        data-triangles={stats?.triangles}
        data-draw-calls={stats?.drawCalls}
      />
      {problem !== undefined ? (
        <p className="cs-model-problem" role="status">
          {problem}
        </p>
      ) : model === undefined ? (
        <p className="cs-model-problem" role="status">
          This stock has no jacket or core diameters to draw from yet.
        </p>
      ) : null}
      <div className="cs-model-tools" role="toolbar" aria-label="3D view">
        <button type="button" onClick={() => frame('iso')} title="Back to the starting view" aria-pressed={view === 'iso'}>
          Reset
        </button>
        <button type="button" onClick={() => frame('fit')} title="Fit the whole wire in the view, looking from where you are">
          Fit
        </button>
        {views.map((v) => (
          <button key={v.id} type="button" onClick={() => frame(v.id)} title={v.title} aria-pressed={view === v.id}>
            {v.label}
          </button>
        ))}
        {stats === undefined ? null : (
          <span className="cs-model-info" title={`${stats.pieces} pieces in ${stats.drawCalls} draw calls`}>
            {model?.odMm.toFixed(1)} mm Ø · {state.lengthMm} mm · {stats.triangles >= 1000 ? `${Math.round(stats.triangles / 1000)}k` : stats.triangles} tri
          </span>
        )}
      </div>
      </div>
      <div className="cs-w3-controls" role="group" aria-label="wire model">
        <div className="cs-w3-row">
          <label className="cs-w3-field" title={current?.src ?? 'Moved by hand'}>
            <span>Strip</span>
            <select aria-label="strip preset" value={state.preset} onChange={(e) => pickPreset(e.target.value)}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.inferred ? ' (lengths inferred)' : ''}
                </option>
              ))}
              {state.preset === 'custom' ? <option value="custom">Custom</option> : null}
            </select>
          </label>
          <div className="cs-seg" role="group" aria-label="end shown">
            {(['a', 'b', 'both'] as WireEndShown[]).map((s) => (
              <button
                key={s}
                type="button"
                className={classes(state.show === s && 'is-active')}
                aria-pressed={state.show === s}
                title={s === 'a' ? 'The source end' : s === 'b' ? 'The destination end' : 'The whole length'}
                onClick={() => setState((st) => ({ ...st, show: s }))}
              >
                {s === 'a' ? 'End A' : s === 'b' ? 'End B' : 'Full length'}
              </button>
            ))}
          </div>
          <label className="cs-w3-field" title={props.lengthLocked === true ? "The design segment's length" : 'Cable length'}>
            <span>Length</span>
            <input
              type="number"
              className="cs-mono"
              aria-label="length (mm)"
              min={20}
              max={20000}
              step={10}
              value={state.lengthMm}
              disabled={props.lengthLocked === true}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 20) setState((s) => ({ ...s, lengthMm: Math.round(v) }));
              }}
            />
            <span className="cs-w3-unit">mm</span>
          </label>
          <label className="cs-w3-check" title={`Lay the cores up as a helix${facts.layLengthMm === undefined ? ' (lay length not on the sheet: 16 × Ø, inferred)' : `, ${facts.layLengthMm} mm lay`}`}>
            <input type="checkbox" checked={state.twist} onChange={(e) => setState((s) => ({ ...s, twist: e.target.checked }))} /> Twist
          </label>
          <label className="cs-w3-check" title="See through the jacket">
            <input type="checkbox" checked={state.xray} onChange={(e) => setState((s) => ({ ...s, xray: e.target.checked }))} /> X-ray
          </label>
          <Slider label="Explode" value={state.explode} min={0} max={1} step={0.05} title="Splay the stripped cores out, and pull each layer's end apart" onChange={(v) => setState((s) => ({ ...s, explode: v }))} />
        </div>
        {props.compact === true ? null : (
          <div className="cs-w3-row" aria-label={`strip at ${state.show === 'both' ? 'both ends' : `end ${state.show.toUpperCase()}`}`}>
            <Slider label="Jacket" value={end.jacketMm} min={0} max={maxStrip} step={1} unit=" mm" title="Overall jacket (and foil) taken off from the tip" onChange={(v) => set({ jacketMm: v })} />
            {hasSheath ? <Slider label="Sheath" value={end.sheathMm} min={0} max={maxStrip} step={1} unit=" mm" title="Each coax's own sheath taken off from the tip" onChange={(v) => set({ sheathMm: v })} /> : null}
            <label className="cs-w3-field" title={SHIELD_MODES.find((m) => m.value === end.shield)?.title}>
              <span>Screen</span>
              <select aria-label="screen treatment" value={end.shield} onChange={(e) => set({ shield: e.target.value as StripEnd['shield'] })}>
                {SHIELD_MODES.map((m) => (
                  <option key={m.value} value={m.value} title={m.title}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {end.shield === 'trim' ? <Slider label="Keep" value={end.shieldKeepPct} min={0} max={100} step={5} unit=" %" title="Share of the exposed screen left on" onChange={(v) => set({ shieldKeepPct: v })} /> : null}
            <Slider label="Insulation" value={end.insulationMm} min={0} max={Math.max(20, Math.round(maxStrip / 2))} step={0.5} unit=" mm" title="Dielectric / core insulation taken off — the bare conductor" onChange={(v) => set({ insulationMm: v })} />
            {hasDrain ? (
              <label className="cs-w3-check" title="Drain landed (twisted in) or cut flush at this end">
                <input type="checkbox" checked={end.drain === 'land'} onChange={(e) => set({ drain: e.target.checked ? 'land' : 'cut' })} /> Drain
              </label>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
