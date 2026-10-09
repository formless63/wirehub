/**
 * GENERATED from `tokens.css` by `scripts/gen-tokens.mjs` -- do not edit by hand.
 * Run `pnpm --filter @wirehub/editor-react gen:tokens`; `test/tokens-drift.test.ts` fails on drift.
 *
 * Semantic design tokens for call sites that need a value in JavaScript (a React Flow prop that
 * only takes a string, a canvas paint). Prefer the CSS custom properties (`var(--panel)`) or the
 * Tailwind utilities they back (`bg-panel`, `cs:bg-panel`): only the CSS follows a theme change.
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
  ink: string;
  dim: string;
  faint: string;
  lineField: string;
  canvas: string;
  dot: string;
  accent: string;
  accentInk: string;
  accentSoft: string;
  selected: string;
  focus: string;
  brand: string;
  brandInk: string;
  brandCopper: string;
  brandWordmark: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  err: string;
  errSoft: string;
  errInk: string;
  info: string;
  infoSoft: string;
  board: string;
  boardKind: string;
  jacket: string;
  jacketLine: string;
  diel: string;
  foil: string;
  copper: string;
  scrim: string;
  elev1: string;
  elev2: string;
  elev3: string;
  shadow: string;
  connKind: string;
  wireKind: string;
  compKind: string;
  paper: string;
  paper2: string;
  paper3: string;
  paperDim: string;
  paperInk: string;
  paperInk2: string;
  padRing: string;
  padInk: string;
  trace: string;
  artChipBodyFill: string;
  artChipBodyStroke: string;
  artChipEndFill: string;
  artChipEndStroke: string;
  artDiodeBandFill: string;
  artDiodeBodyFill: string;
  artDiodeBodyStroke: string;
  artElecBodyFill: string;
  artElecBodyStroke: string;
  artElecStripeFill: string;
  artIcBodyFill: string;
  artIcBodyStroke: string;
  artIcLeadFill: string;
  artIcLeadStroke: string;
  artJumperBlobFill: string;
  artJumperBlobStroke: string;
  artJumperPadFill: string;
  artJumperPadStroke: string;
  artLedBodyFill: string;
  artLedBodyStroke: string;
  artLedDomeFill: string;
  artMarking: string;
  artMlccBodyFill: string;
  artMlccBodyStroke: string;
  artMlccEndFill: string;
  artMlccEndStroke: string;
  artPin1: string;
  artShieldMetal: string;
  artPlainInsulation: string;
  artPin1Stroke: string;
  artTantBandFill: string;
  artTantBodyFill: string;
  artTantBodyStroke: string;
}

export const SEMANTIC_TOKENS: Record<ThemeName, SemanticTokens> = {
  dark: {
    bg: "#121315",
    rail: "#0d0e10",
    panel: "#18191c",
    raised: "#1f2024",
    hover: "#24252a",
    line: "#27282d",
    line2: "#34353b",
    ink: "#ebe8e3",
    dim: "#a19e96",
    faint: "#8b887f",
    lineField: "#6a6b72",
    canvas: "#0f1012",
    dot: "#232428",
    accent: "#e39256",
    accentInk: "#1c1008",
    accentSoft: "rgba(227, 146, 86, 0.14)",
    selected: "rgba(227, 146, 86, 0.12)",
    focus: "#7ea6db",
    brand: "#2e5e99",
    brandInk: "#ffffff",
    brandCopper: "#e39256",
    brandWordmark: "#e8edf3",
    ok: "#5fbf8a",
    okSoft: "rgba(95, 191, 138, 0.14)",
    warn: "#d9a441",
    warnSoft: "rgba(217, 164, 65, 0.14)",
    err: "#f0706d",
    errSoft: "rgba(240, 112, 109, 0.14)",
    errInk: "#1c0b0b",
    info: "#7ea6db",
    infoSoft: "rgba(126, 166, 219, 0.14)",
    board: "#5fbf8a",
    boardKind: "#5fbf8a",
    jacket: "#26272b",
    jacketLine: "#46474d",
    diel: "#d8d3c6",
    foil: "#9aa3ad",
    copper: "#c98a5a",
    scrim: "rgba(0, 0, 0, 0.5)",
    elev1: "0 1px 2px rgba(0, 0, 0, 0.4)",
    elev2: "0 4px 12px rgba(0, 0, 0, 0.4)",
    elev3: "0 12px 32px rgba(0, 0, 0, 0.45)",
    shadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
    connKind: "#7ea6db",
    wireKind: "#d2a85a",
    compKind: "#b38be0",
    paper: "#ffffff",
    paper2: "#f6f7f8",
    paper3: "#eceff2",
    paperDim: "#6b7280",
    paperInk: "#1b2129",
    paperInk2: "#16191d",
    padRing: "#f2f1ed",
    padInk: "#1b1a18",
    trace: "#c2602a",
    artChipBodyFill: "#1c1c1c",
    artChipBodyStroke: "#050505",
    artChipEndFill: "#c7ccd2",
    artChipEndStroke: "#9aa0a8",
    artDiodeBandFill: "#e6e8ea",
    artDiodeBodyFill: "#17181a",
    artDiodeBodyStroke: "#050505",
    artElecBodyFill: "#46484c",
    artElecBodyStroke: "#202224",
    artElecStripeFill: "#d8dadd",
    artIcBodyFill: "#1c1c1c",
    artIcBodyStroke: "#050505",
    artIcLeadFill: "#c7ccd2",
    artIcLeadStroke: "#9aa0a8",
    artJumperBlobFill: "#d7dade",
    artJumperBlobStroke: "#9aa0a8",
    artJumperPadFill: "#c3a765",
    artJumperPadStroke: "#8a763f",
    artLedBodyFill: "#17181a",
    artLedBodyStroke: "#050505",
    artLedDomeFill: "#e2894a",
    artMarking: "#f2f2f2",
    artMlccBodyFill: "#b9905a",
    artMlccBodyStroke: "#8a6a3e",
    artMlccEndFill: "#c7ccd2",
    artMlccEndStroke: "#9aa0a8",
    artPin1: "#e7e7ea",
    artShieldMetal: "#a7aeb5",
    artPlainInsulation: "#e9edf1",
    artPin1Stroke: "#8a8f96",
    artTantBandFill: "#241d15",
    artTantBodyFill: "#e2a13a",
    artTantBodyStroke: "#a8741f",
  },
  light: {
    bg: "#f7f6f3",
    rail: "#efeee9",
    panel: "#ffffff",
    raised: "#f4f3ef",
    hover: "#efeee9",
    line: "#e4e2dc",
    line2: "#d3d0c8",
    ink: "#1b1a18",
    dim: "#5f5c55",
    faint: "#6f6b62",
    lineField: "#8a867c",
    canvas: "#f2f1ed",
    dot: "#d7d4cc",
    accent: "#a4531c",
    accentInk: "#ffffff",
    accentSoft: "rgba(164, 83, 28, 0.1)",
    selected: "rgba(164, 83, 28, 0.09)",
    focus: "#2f64b0",
    brand: "#1d3a5f",
    brandInk: "#ffffff",
    brandCopper: "#c06a2b",
    brandWordmark: "#1d3a5f",
    ok: "#22714a",
    okSoft: "rgba(34, 113, 74, 0.08)",
    warn: "#8a5d08",
    warnSoft: "rgba(138, 93, 8, 0.08)",
    err: "#b8352f",
    errSoft: "rgba(184, 53, 47, 0.08)",
    errInk: "#ffffff",
    info: "#2f64b0",
    infoSoft: "rgba(47, 100, 176, 0.08)",
    board: "#267a4c",
    boardKind: "#2f8f5b",
    jacket: "#e6e4de",
    jacketLine: "#c2beb4",
    diel: "#fbfaf6",
    foil: "#8a939d",
    copper: "#b86f3c",
    scrim: "rgba(40, 36, 30, 0.28)",
    elev1: "0 1px 2px rgba(40, 36, 30, 0.12)",
    elev2: "0 4px 12px rgba(40, 36, 30, 0.14)",
    elev3: "0 12px 32px rgba(40, 36, 30, 0.18)",
    shadow: "0 12px 32px rgba(40, 36, 30, 0.18)",
    connKind: "#3f6fb0",
    wireKind: "#a97f2c",
    compKind: "#8656c4",
    paper: "#ffffff",
    paper2: "#f6f7f8",
    paper3: "#eceff2",
    paperDim: "#6b7280",
    paperInk: "#1b2129",
    paperInk2: "#16191d",
    padRing: "#f2f1ed",
    padInk: "#1b1a18",
    trace: "#c2602a",
    artChipBodyFill: "#1c1c1c",
    artChipBodyStroke: "#050505",
    artChipEndFill: "#c7ccd2",
    artChipEndStroke: "#9aa0a8",
    artDiodeBandFill: "#e6e8ea",
    artDiodeBodyFill: "#17181a",
    artDiodeBodyStroke: "#050505",
    artElecBodyFill: "#46484c",
    artElecBodyStroke: "#202224",
    artElecStripeFill: "#d8dadd",
    artIcBodyFill: "#1c1c1c",
    artIcBodyStroke: "#050505",
    artIcLeadFill: "#c7ccd2",
    artIcLeadStroke: "#9aa0a8",
    artJumperBlobFill: "#d7dade",
    artJumperBlobStroke: "#9aa0a8",
    artJumperPadFill: "#c3a765",
    artJumperPadStroke: "#8a763f",
    artLedBodyFill: "#17181a",
    artLedBodyStroke: "#050505",
    artLedDomeFill: "#e2894a",
    artMarking: "#f2f2f2",
    artMlccBodyFill: "#b9905a",
    artMlccBodyStroke: "#8a6a3e",
    artMlccEndFill: "#c7ccd2",
    artMlccEndStroke: "#9aa0a8",
    artPin1: "#e7e7ea",
    artShieldMetal: "#a7aeb5",
    artPlainInsulation: "#e9edf1",
    artPin1Stroke: "#8a8f96",
    artTantBandFill: "#241d15",
    artTantBodyFill: "#e2a13a",
    artTantBodyStroke: "#a8741f",
  },
};

/** theme-independent scales: type steps, the 4 px space grid, radii, control heights, motion (px / ms strings) */
export const SCALES = {
  font: {
    sans: '\'IBM Plex Sans\', system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif',
    mono: '\'IBM Plex Mono\', ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  text: {
    '2xs': '11px',
    xs: '12px',
    sm: '13px',
    md: '14px',
    lg: '16px',
    xl: '20px',
    'canvas-5': '5px',
    'canvas-7-5': '7.5px',
    'canvas-8': '8px',
    'canvas-9': '9px',
    'canvas-9-5': '9.5px',
    'canvas-10': '10px',
    'canvas-10-5': '10.5px',
    'canvas-11-5': '11.5px',
  },
  space: {
    unit: '4px',
    '3xs': '2px',
    '2xs': '4px',
    xs: '6px',
    sm: '8px',
    md: '12px',
    lg: '16px',
    xl: '24px',
    '2xl': '32px',
  },
  radius: {
    xs: '2px',
    sm: '4px',
    md: '6px',
    lg: '8px',
  },
  control: {
    sm: '22px',
    md: '26px',
    lg: '30px',
  },
  motion: {
    fast: '120ms',
    base: '180ms',
    ease: 'cubic-bezier(0.2, 0, 0, 1)',
  },
} as const;

/**
 * Conductor colours: the domain palette (wire jackets, cores, drains), not UI chrome. Identical in
 * both themes except `white` and `black`, which get an outline stroke when drawn (see
 * `OUTLINED_CONDUCTORS`) because a bare fill in either colour disappears against one of the canvases.
 */
export type ConductorColorName = 'red' | 'green' | 'blue' | 'yellow' | 'brown' | 'purple' | 'gnd' | 'white' | 'black';

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
