/**
 * Semantic design tokens — the single source of truth for both this package
 * and `apps/studio`. The app depends on `@wirehub/editor-react`, not the
 * other way around, so the editor is the natural owner: import from here
 * rather than redefining a palette.
 *
 * The brand tokens match the logo (`brand/wirehub-logo.svg`, `brand/README.md`).
 * There is no code-generation step — `tokens.css` mirrors this file as CSS
 * custom properties; keep the two in sync when either changes.
 *
 * Most consumers should reach for the CSS custom properties (`var(--panel)`,
 * `var(--cond-red)`, …) or the Tailwind utilities they back (`bg-panel`,
 * `text-ink`, `cs:bg-panel`, …). This TS module exists for the handful of
 * call sites that need a colour value in JavaScript — e.g. a React Flow prop
 * that only accepts a string, not something the browser resolves from the
 * cascade (see `CableEditor.tsx`'s `MiniMap`). Even those call sites should
 * prefer reading the CSS variable at runtime (`getComputedStyle`) over one of
 * these constants where the DOM is available, since only the CSS actually
 * reacts to a theme change.
 */

export type ThemeName = 'light' | 'dark';

export interface SemanticTokens {
  bg: string;
  rail: string;
  panel: string;
  raised: string;
  hover: string;
  line: string;
  line2: string;
  /** boundary of inputs, selects and checkboxes (WCAG 1.4.11, 3:1) */
  lineField: string;
  ink: string;
  dim: string;
  faint: string;
  canvas: string;
  dot: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  /** the WireHub logo: badge fill, its lettering, the copper node, the "Wire" strokes */
  brand: string;
  brandInk: string;
  brandCopper: string;
  brandWordmark: string;
  ok: string;
  warn: string;
  err: string;
  board: string;
  jacket: string;
  jacketLine: string;
  diel: string;
  foil: string;
  copper: string;
  scrim: string;
  shadow: string;
  connKind: string;
  wireKind: string;
  compKind: string;
}

export const SEMANTIC_TOKENS: Record<ThemeName, SemanticTokens> = {
  dark: {
    bg: '#121315',
    rail: '#0d0e10',
    panel: '#18191c',
    raised: '#1f2024',
    hover: '#24252a',
    line: '#27282d',
    line2: '#34353b',
    lineField: '#6a6b72',
    ink: '#ebe8e3',
    dim: '#a19e96',
    faint: '#8b887f',
    canvas: '#0f1012',
    dot: '#232428',
    accent: '#e39256',
    accentInk: '#1c1008',
    accentSoft: 'rgba(227,146,86,0.14)',
    brand: '#2e5e99',
    brandInk: '#ffffff',
    brandCopper: '#e39256',
    brandWordmark: '#e8edf3',
    ok: '#5fbf8a',
    warn: '#d9a441',
    err: '#ef6461',
    board: '#5fbf8a',
    jacket: '#26272b',
    jacketLine: '#46474d',
    diel: '#d8d3c6',
    foil: '#9aa3ad',
    copper: '#c98a5a',
    scrim: 'rgba(0,0,0,0.5)',
    shadow: '0 12px 32px rgba(0,0,0,0.45)',
    connKind: '#7ea6db',
    wireKind: '#d2a85a',
    compKind: '#b38be0',
  },
  light: {
    bg: '#f7f6f3',
    rail: '#efeee9',
    panel: '#ffffff',
    raised: '#f4f3ef',
    hover: '#efeee9',
    line: '#e4e2dc',
    line2: '#d3d0c8',
    lineField: '#8a867c',
    ink: '#1b1a18',
    dim: '#5f5c55',
    faint: '#6f6b62',
    canvas: '#f2f1ed',
    dot: '#d7d4cc',
    accent: '#a4531c',
    accentInk: '#ffffff',
    accentSoft: 'rgba(164,83,28,0.10)',
    brand: '#1d3a5f',
    brandInk: '#ffffff',
    brandCopper: '#c06a2b',
    brandWordmark: '#1d3a5f',
    ok: '#267a4c',
    warn: '#946509',
    err: '#c9403c',
    board: '#267a4c',
    jacket: '#e6e4de',
    jacketLine: '#c2beb4',
    diel: '#fbfaf6',
    foil: '#8a939d',
    copper: '#b86f3c',
    scrim: 'rgba(40,36,30,0.28)',
    shadow: '0 12px 32px rgba(40,36,30,0.18)',
    connKind: '#3f6fb0',
    wireKind: '#a97f2c',
    compKind: '#8656c4',
  },
};

/**
 * Conductor colours — the domain palette (wire jackets, cores, drains), not
 * UI chrome. Identical in both themes except `white` and `black`, which get
 * an outline stroke when drawn (see `OUTLINED_CONDUCTORS`) because a bare
 * fill in either colour disappears against one of the two theme canvases.
 */
export type ConductorColorName =
  | 'red'
  | 'green'
  | 'blue'
  | 'yellow'
  | 'brown'
  | 'purple'
  | 'gnd'
  | 'white'
  | 'black';

export const CONDUCTOR_COLORS: Record<ThemeName, Record<ConductorColorName, string>> = {
  dark: {
    red: '#e5484d',
    green: '#3fb56a',
    blue: '#3b82f6',
    yellow: '#e6c229',
    brown: '#9a5b34',
    purple: '#9b6ce0',
    gnd: '#8a8f96',
    white: '#e9e7e2',
    black: '#0a0a0b',
  },
  light: {
    red: '#e5484d',
    green: '#3fb56a',
    blue: '#3b82f6',
    yellow: '#e6c229',
    brown: '#9a5b34',
    purple: '#9b6ce0',
    gnd: '#8a8f96',
    white: '#ffffff',
    black: '#232323',
  },
};

/** conductor colours that need an outline stroke to read against the canvas */
export const OUTLINED_CONDUCTORS: ReadonlySet<ConductorColorName> = new Set(['white', 'black']);
