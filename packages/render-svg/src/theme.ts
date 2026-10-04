/**
 * The print-first visual language: paint, stroke weights and the stylesheet.
 *
 * Colour is **additive**. Every track, port and symbol also carries a text
 * label, so a monochrome laser print of this drawing loses nothing but the
 * convenience of picking the red core out at a glance. Light conductors
 * (white, yellow) get a neutral halo underneath so they survive white paper.
 */

import { FONT_FAMILY, METRICS as M, type DiagramTrack } from '@cable-studio/layout';

export const INK = {
  ink: '#14181d',
  muted: '#5b6570',
  rule: '#98a2ac',
  faint: '#dde2e7',
  zebra: '#f3f5f7',
  paper: '#ffffff',
  bandFill: '#fbfcfd',
  jacket: '#2b3138',
  shield: '#7c848c',
  overallShield: '#5b6570',
  drain: '#b06a2c',
  warn: '#a8410f',
} as const;

/** Catalog colour names → print-safe paint. */
const CONDUCTOR_PAINT: Readonly<Record<string, string>> = {
  red: '#cc2b2b',
  green: '#17864a',
  blue: '#2453c4',
  yellow: '#d8a400',
  white: '#ffffff',
  black: '#17191c',
  brown: '#8a5a2b',
  orange: '#d2601a',
  violet: '#7b3fb0',
  purple: '#7b3fb0',
  grey: '#7b8288',
  gray: '#7b8288',
  pink: '#d0568f',
};

/** Colours that need a halo to be visible on white paper. */
const LIGHT_COLORS = new Set(['white', 'yellow']);

export interface StrokeStyle {
  stroke: string;
  width: number;
  dash?: string;
  /** draw a neutral under-stroke so a pale conductor reads on white paper */
  halo: boolean;
}

export function conductorPaint(colorName: string | undefined): string {
  if (colorName === undefined) return '#444b52';
  return CONDUCTOR_PAINT[colorName.toLowerCase()] ?? '#444b52';
}

/** How one band track is stroked. */
export function trackStyle(track: DiagramTrack): StrokeStyle {
  switch (track.role) {
    case 'shield':
      return { stroke: INK.shield, width: 0.75, dash: '2 1.2', halo: false };
    case 'overall-shield':
      return { stroke: INK.overallShield, width: 1.1, dash: '4 1.6', halo: false };
    case 'drain':
      return { stroke: INK.drain, width: 1, dash: '2.4 1 0.6 1', halo: false };
    default: {
      const light =
        track.colorName !== undefined && LIGHT_COLORS.has(track.colorName.toLowerCase());
      return {
        stroke: track.bare ? INK.drain : conductorPaint(track.colorName),
        width: 1.4,
        halo: light,
      };
    }
  }
}

/**
 * A joint drawn between a wire end and whatever it lands on carries the
 * conductor's identity out of the band, so the fan-out is readable at a
 * glance. Joints that touch no wire (pin-to-pin bonds, component leads) draw
 * in ink.
 */
export function jointStyle(track: DiagramTrack | undefined): StrokeStyle {
  if (track === undefined) {
    return { stroke: INK.ink, width: 0.5, halo: false };
  }
  const base = trackStyle(track);
  return {
    stroke: base.stroke,
    width: Math.max(0.5, base.width * 0.62),
    ...(base.dash === undefined ? {} : { dash: base.dash }),
    halo: base.halo,
  };
}

/**
 * Every rule below that sets `font-size` reads it from `METRICS`
 * (`packages/layout/src/metrics.ts`) rather than a literal — layout sizes
 * gutters, pitches and word-wraps off those same numbers via `textWidth`, so
 * a class whose CSS disagreed with the metric it was reserved at would either
 * waste the reserved space or overflow it. A few labels (`.direction`,
 * `.block-caption`, `.polarity`, `.notes-heading`,
 * `.issue`) have no metric of their own — layout does not reserve width for
 * them off a font size — so they stay literal, picked to sit in proportion
 * with the scale around them.
 */
export const STYLESHEET = [
  // the concrete stack `textWidth` is measured against (layout `text.ts`)
  `text{font-family:${FONT_FAMILY};fill:#14181d}`,
  '.page{fill:#ffffff}',
  `.title{font-size:${M.fontTitle}px;font-weight:600}`,
  `.subtitle{font-size:${M.fontSubtitle}px;fill:#5b6570}`,
  '.direction{font-size:3.2px;fill:#5b6570;letter-spacing:0.08px}',
  `.legend-text{font-size:${M.fontLegend}px;fill:#5b6570}`,
  '.block-outline{fill:#ffffff;stroke:#14181d;stroke-width:0.6}',
  `.block-title{font-size:${M.fontBlockTitle}px;font-weight:600}`,
  `.block-sub{font-size:${M.fontBlockSub}px;fill:#5b6570}`,
  '.block-caption{font-size:2.6px;fill:#5b6570;letter-spacing:0.06px}',
  '.zebra{fill:#f3f5f7}',
  `.pin-id{font-size:${M.fontPin}px;font-weight:600}`,
  `.pin-label{font-size:${M.fontPin}px;fill:#14181d}`,
  `.block-foot{font-size:${M.fontFootnote}px;fill:#5b6570}`,
  '.internal-link{fill:none;stroke:#5b6570;stroke-width:0.35}',
  `.annot{font-size:${M.fontAnnot}px;fill:#3a424b}`,
  '.band-outline{fill:#fbfcfd;stroke:#2b3138;stroke-width:0.7}',
  `.band-label{font-size:${M.fontBandLabel}px;font-weight:600}`,
  '.bracket{fill:none;stroke:#98a2ac;stroke-width:0.4}',
  `.group-label{font-size:${M.fontGroup}px;font-weight:600;fill:#3a424b}`,
  `.track-label{font-size:${M.fontTrack}px;fill:#3a424b}`,
  '.edge{fill:none;stroke-linecap:round;stroke-linejoin:round}',
  '.halo{fill:none;stroke:#6b7178;stroke-linecap:round;stroke-linejoin:round}',
  '.joint-dot{fill:#14181d}',
  '.symbol{fill:#ffffff;stroke:#14181d;stroke-width:0.5}',
  '.symbol-line{stroke:#14181d;stroke-width:0.5;fill:none}',
  `.comp-label{font-size:${M.fontComponentLabel}px;font-weight:600;text-anchor:middle}`,
  '.polarity{font-size:2.8px;font-weight:600;text-anchor:middle}',
  '.cut{stroke:#a8410f;stroke-width:0.5;fill:none}',
  `.cut-ref{font-size:${M.fontCutRef}px;font-weight:600;fill:#a8410f}`,
  '.xs-panel{fill:#fbfcfd;stroke:#98a2ac;stroke-width:0.4}',
  `.xs-title{font-size:${M.fontBlockTitle}px;font-weight:600}`,
  `.xs-sub{font-size:${M.fontBlockSub}px;fill:#5b6570}`,
  '.xs-outline{fill:none;stroke:#14181d;stroke-width:0.15}',
  '.xs-hatch{fill:none;stroke:#3a424b;stroke-width:0.26;stroke-linecap:round}',
  '.xs-leader-halo{fill:none;stroke:#ffffff;stroke-width:1;stroke-linecap:round}',
  '.xs-leader{fill:none;stroke:#5b6570;stroke-width:0.3}',
  `.xs-tag{font-size:${M.fontCrossSectionTag}px;font-weight:600}`,
  '.xs-swatch{stroke:#14181d;stroke-width:0.15}',
  `.xs-key-tag{font-size:${M.fontCrossSectionKey}px;font-weight:600}`,
  `.xs-key{font-size:${M.fontCrossSectionKey}px;fill:#3a424b}`,
  '.xs-dim{fill:none;stroke:#5b6570;stroke-width:0.25}',
  `.xs-dim-text{font-size:${M.fontCrossSectionKey}px;fill:#5b6570}`,
  '.xs-rule{stroke:#14181d;stroke-width:0.3}',
  `.xs-rule-text{font-size:${M.fontCrossSectionKey}px;fill:#5b6570}`,
  '.notes-heading{font-size:3.4px;font-weight:600;letter-spacing:0.1px}',
  `.note-num{font-size:${M.fontNote}px;font-weight:600;fill:#5b6570}`,
  `.note-text{font-size:${M.fontNote}px;fill:#14181d}`,
  '.issue{font-size:3px;fill:#a8410f}',
  '.rule{stroke:#98a2ac;stroke-width:0.3}',
].join('');

/**
 * The rules a **depicted** block needs, appended to the stylesheet only on a
 * page that actually draws artwork. Kept separate so a drawing with no
 * depictions is byte-for-byte the drawing it was before depictions existed —
 * the fallback is not merely equivalent, it is identical.
 *
 * `.block-outline-art` must come after `.block-outline` (equal specificity,
 * later wins): a depicted block is see-through, because its wires land on pads
 * *inside* the outline and are drawn before it.
 */
export const DEPICTION_STYLESHEET = [
  '.block-outline-art{fill:none}',
  // the artwork paints in one ink through `currentColor`, so it prints
  '.depiction{color:#14181d}',
  `.callout{font-size:${M.fontCallout}px;fill:#14181d}`,
  '.callout-leader{fill:none;stroke:#98a2ac;stroke-width:0.25}',
  // two-faced boards: face captions, pad names over
  // their own wires, and the hollow ring where a link reaches a pad that is
  // on the other face
  `.face-caption{font-size:${M.fontFaceCaption}px;font-weight:600;fill:#5b6570;letter-spacing:0.12px}`,
  `.pad-label{font-size:${M.fontPadLabel}px;font-weight:600;fill:#14181d}`,
  '.link-ghost{fill:#ffffff;stroke:#5b6570;stroke-width:0.3}',
  // a board's mounted parts (y1u.17): the fallback for a part y1u.18 does not
  // yet draw as a real body (an unrecognised package, a connector already
  // drawn by the gerber art, or an unset solder jumper) — a translucent
  // violet box, so the copper and the pads under it still print, never
  // nothing; the label carries the part in words.
  '.board-part-box{fill:#7b3fb0;fill-opacity:0.2;stroke:#7b3fb0;stroke-width:0.12}',
  '.board-part.is-unset .board-part-box{fill:none;stroke-dasharray:0.4 0.3}',
  '.board-part-pin1{fill:#e7e7ea;stroke:#8a8f96;stroke-width:0.05}',
  '.board-part-label{font-size:1.1px;text-anchor:middle;dominant-baseline:central;fill:#14181d;stroke:#ffffff;stroke-width:0.3px;paint-order:stroke}',
  // package bodies (y1u.18): the real top-down colours of the part itself —
  // a black chip resistor prints the same whether or not the page is one a
  // dark canvas would wrap it in, so these never key off theme.
  '.pt-chip-body{fill:#1c1c1c;stroke:#050505;stroke-width:0.05}',
  '.pt-chip-end{fill:#c7ccd2;stroke:#9aa0a8;stroke-width:0.04}',
  '.pt-mlcc-body{fill:#b9905a;stroke:#8a6a3e;stroke-width:0.05}',
  '.pt-mlcc-end{fill:#c7ccd2;stroke:#9aa0a8;stroke-width:0.04}',
  '.pt-tant-body{fill:#e2a13a;stroke:#a8741f;stroke-width:0.05}',
  '.pt-tant-band{fill:#241d15}',
  '.pt-elec-body{fill:#46484c;stroke:#202224;stroke-width:0.06}',
  '.pt-elec-stripe{fill:#d8dadd}',
  '.pt-ic-body{fill:#1c1c1c;stroke:#050505;stroke-width:0.05}',
  '.pt-ic-lead{fill:#c7ccd2;stroke:#9aa0a8;stroke-width:0.04}',
  '.pt-diode-body{fill:#17181a;stroke:#050505;stroke-width:0.05}',
  '.pt-diode-band{fill:#e6e8ea}',
  '.pt-led-body{fill:#17181a;stroke:#050505;stroke-width:0.05}',
  '.pt-led-dome{fill:#e2894a;fill-opacity:0.55}',
  '.pt-jumper-blob{fill:#d7dade;stroke:#9aa0a8;stroke-width:0.05}',
  '.pt-jumper-pad{fill:#c3a765;stroke:#8a763f;stroke-width:0.05}',
  '.pt-marking{font-size:0.55px;text-anchor:middle;dominant-baseline:central;fill:#f2f2f2}',
].join('');

/**
 * A connector drawn as itself: the shared connector
 * art's paint roles in print greys, so the part reads as metal and moulding
 * without competing with the conductor colours. Pins a wire lands on print
 * solid ink, the rest hollow. Only a page that draws one carries these.
 */
export const CONNECTOR_ART_STYLESHEET = [
  '.ca{stroke:#14181d;stroke-linejoin:round}',
  '.ca-flange{fill:#eef0f2}',
  '.ca-shell{fill:#d9dde1}',
  '.ca-insert{fill:#f8f9fa}',
  '.ca-hole{fill:#ffffff}',
  '.ca-metal{fill:#c3c9cf}',
  '.ca-boot{fill:#6b7178}',
  '.ca-grip{fill:#8a929a}',
  '.ca-knurl{fill:none;stroke:#3a424b}',
  '.ca-band{fill:#98a2ac}',
  '.ca-copper{fill:#d49a4e}',
  '.ca-dark{fill:#3a424b}',
  '.ca-key{fill:#aab2ba}',
  '.ca-pin{fill:#ffffff;stroke:#7c848c}',
  '.ca-pin.is-used{fill:#14181d;stroke:#14181d}',
  '.ca-label{font-size:9px;font-weight:600;fill:#5b6570}',
].join('');

/** Only a drawing with a breakout mould carries these. */
export const BREAKOUT_STYLESHEET = [
  '.mould{fill:#e9edf1;stroke:#2b3138;stroke-width:0.6}',
  '.mould-label{font-size:2.6px;font-weight:600}',
  `.mould-sub{font-size:${M.fontMouldSub}px;fill:#5b6570}`,
  '.mould-nc{font-size:1.7px;font-weight:600;fill:#a8410f}',
].join('');
