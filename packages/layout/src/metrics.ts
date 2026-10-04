/**
 * The type scale and geometry constants of the schematic.
 *
 * Everything is millimetres — the diagram is a print-first drawing, so the
 * numbers below are the real paper sizes of the features they name. Font
 * sizes live here too because layout has to estimate text extents; the
 * renderer reads the same values so drawn text matches reserved space.
 */
export const METRICS = {
  /** page margin on all four sides */
  margin: 8,

  /* --- type scale (mm cap-to-descender box, i.e. SVG font-size) ---
   * Raised so pin/pad labels read larger at fit on a 1600×1000 viewport
   * — see
   * `pnpm --filter @wirehub/render-svg measure-density`. The print-first
   * fixed scales elsewhere on the sheet (the board and cutaway artwork are
   * never "fit the panel", see below) mean a bigger type scale also widens
   * text-driven blocks, which partly offsets itself at fit — see that
   * script's own doc comment before pushing these further. */
  fontTitle: 6,
  fontSubtitle: 3,
  fontLegend: 2.9,
  fontBlockTitle: 3.8,
  fontBlockSub: 3,
  fontPin: 3.6,
  fontBandLabel: 3.4,
  fontGroup: 3.1,
  fontTrack: 3.1,
  fontAnnot: 2.9,
  fontNote: 2.9,
  fontFootnote: 2.9,

  /* --- header --- */
  titleBlockHeight: 31,

  /* --- wire bands --- */
  trackPitch: 7,
  /** clearance between the jacket outline and the outermost track */
  bandPadY: 5,
  bandMinWidth: 125,
  branchBandMinWidth: 65,
  /** x of the group bracket inside the band */
  bracketX: 3.5,
  bracketWidth: 3,
  /** a pigtail's bracket: gap out from the band edge, and further out per extra pigtail at that end */
  pigtailBracketGap: 2,
  pigtailSlotPitch: 2,
  /** a pigtail's lead from its bracket out to its landing anchor */
  pigtailLead: 2,
  /** a breakout mould's width beyond its pigtail slots */
  breakoutPad: 9,
  /** how far a breakout mould's outline reaches back over the trunk band's end, and above/below it */
  breakoutInset: 3,
  /** gap between the bracket and the group label */
  groupLabelGap: 2.5,
  /** gap between the group-label column and the track-label column */
  trackLabelGap: 8,
  /** free band length to the right of the track labels */
  bandTailPad: 5,
  /** vertical room above the jacket for the stock/length label */
  bandLabelHeight: 6,

  /* --- blocks --- */
  portPitch: 7.5,
  blockPad: 3,
  blockHeaderHeight: 11,
  /** width of the pin-number gutter inside a block */
  pinIdWidth: 9.5,
  /**
   * Corridor between a PCBA's two port columns, where its internal links run.
   * Deliberately a constant rather than a function of the `via` annotations:
   * `via` is opaque catalog prose that changes under us, and no part of the
   * geometry should move when the wording does. Annotations wrap to fit.
   */
  pcbaCorridor: 31,

  /* --- depicted blocks (artwork instead of stacked pin rows) --- */
  /**
   * Page millimetres per millimetre of real part. A **fixed** magnification,
   * for the same reason the cutaway has one: two boards drawn on two sheets
   * stay comparable, and anything measured off the drawing scales back to the
   * real part by one constant. Never "fit the block".
   */
  depictionScale: 2,
  /** clearance between the artwork frame and the block outline */
  depictionPad: 4,
  /** gap between the callout gutter and the artwork frame */
  calloutGap: 7,
  /** vertical pitch of the stacked pin callouts beside a depicted block */
  calloutPitch: 4.8,
  /** how far the leader starts from the callout text */
  calloutLeaderGap: 1.2,
  fontCallout: 3.1,

  /* --- connectors drawn as themselves --- */
  /**
   * Page millimetres per unit of the shared connector art (the canvas's CSS
   * pixel). The art's own pixels-per-millimetre is already chosen per family
   * for legibility (a mini-DIN is drawn larger than a D-Sub), so the page
   * keeps the canvas's proportions rather than one true-size magnification.
   */
  artFaceScale: 0.3,
  /** the most a face may grow to meet the height of its rows */
  artFaceScaleMax: 0.55,
  /** the same for a side profile (RCA/TRS/BNC), whose lugs sit closer */
  artProfileScale: 0.36,
  /** room above the drawing for its `MATING FACE` / `SIDE VIEW` caption */
  artCaption: 3.6,
  /** least width of the fan between the pin rows and the drawing */
  artFanMin: 6,
  /** clear air a wire's run across the drawing keeps from other pins, page mm */
  artLeadClearance: 0.6,
  /** least distance between two runs across the drawing, page mm */
  artLeadGap: 1.2,
  /** candidate step when searching for a run's level, page mm */
  artLeadStep: 0.3,

  /* --- two-faced boards --- */
  /**
   * A two-faced board's long side aims for this many page millimetres. The
   * magnification is then snapped down to a `boardScaleStep` and clamped to
   * `boardScaleMin`…`boardScaleMax`: small boards (a 13 × 17 mm
   * board) come up legibly, the big SCART boards stay at the old 2×,
   * and every board still measures back to the real part by one printed-scale
   * constant per board.
   */
  boardLongSide: 60,
  boardScaleMin: 2,
  boardScaleMax: 4,
  boardScaleStep: 0.25,
  /** the `TOP` / `BOTTOM` caption row above each face */
  faceCaption: 4,
  /** clear air between the two faces */
  faceGap: 4,
  fontFaceCaption: 2.6,
  /** pad names beside the wires, in the gutter on the cable side */
  fontPadLabel: 3.2,
  /** how far a pad name sits above its own wire */
  padLabelLift: 0.6,
  /** gap between the artwork and a pad name */
  padLabelGap: 1.2,
  /** the corridor between a board and the connector mounted on its connector edge */
  dockGap: 14,
  /** between a branch band's far end and the blocks it runs to */
  branchFanGap: 22,
  /** clearance a wire keeps when it detours round a block it does not belong to */
  detourClearance: 3,
  /** pitch of the lanes in a corridor never drops below this */
  lanePitchMin: 1.6,

  /* --- components --- */
  componentWidth: 11,
  componentHeight: 4.4,
  /** minimum vertical pitch between two component symbols in one column */
  componentPitch: 12,
  /** distance from the band edge to the component column */
  componentInset: 10,
  /**
   * How far a capacitor's plates overhang the symbol's body rect, above and
   * below. The renderer draws them; the router keeps out of them. Shared so
   * that what is on the paper and what the router avoids cannot drift apart.
   */
  componentPlateOverhang: 0.6,
  /**
   * Clearance a routed wire keeps from a component body it does not belong to.
   *
   * Sized by the tightest channel the drawing can produce: two components at
   * `componentPitch` leave `componentPitch - componentHeight` = 4.6 mm between
   * their bodies, and the lower one's designator label (baseline 1.6 mm above
   * its rect, cap height 1.73 mm at `fontAnnot`-ish size) eats the top 3.33 mm
   * of that gap. A hair over a millimetre is what is left to thread, so that
   * is what a detour claims — enough to read as clear air, small enough that
   * the channel between two stacked components stays passable.
   */
  componentClearance: 1,
  /**
   * Designator label over a component symbol (`r1 · 150 Ω`), baseline
   * `componentLabelLift` above the body. The router keeps vertical lanes out
   * of it as it does out of the body.
   */
  fontComponentLabel: 2.8,
  componentLabelLift: 1.6,
  /** the note ref printed beside a deliberate cut end, kept clear of lanes too */
  fontCutRef: 2.7,
  /** a breakout mould's part line, wrapped under the mould to its width */
  fontMouldSub: 2.2,
  mouldSubLineHeight: 2.6,

  /* --- routing --- */
  /**
   * How far a pad's approach lead runs out of the pad at its real angle
   * before joining the route (render-svg) — the drawn
   * wire reaches this far past a pad the layout's own anchor sits on.
   */
  approachLead: 2.5,
  /** straight run out of a port/track end before the router may turn */
  stub: 3.5,
  /** horizontal room reserved between a block column and the band */
  fanGap: 26,
  /** separation between the branch band and the trunk band's left edge */
  branchGapX: 26,
  /** vertical separation between stacked bands */
  branchGapY: 16,
  /**
   * There is deliberately **no** alignment tolerance here. Routing draws its
   * straight two-point form from anchor to anchor, so calling two anchors
   * "aligned enough" would draw a diagonal — see `routeJoint` in `layout.ts`.
   * Anchors are either exactly level, or they get a jog.
   */
  jointRadius: 0.9,

  /* --- cross-section cutaway --- */
  /**
   * Millimetres of paper per millimetre of cable. A fixed magnification (not
   * "fit the panel") on purpose: two stocks drawn on two sheets stay
   * comparable, and the mm ruler beside the circle means anything on the
   * drawing can be measured back to the real cable.
   */
  crossSectionScale: 4,
  crossSectionPad: 3,
  /** radial room outside the jacket for the numbered callouts */
  crossSectionCallout: 8,
  /** how far past the jacket a callout leader runs before its tag */
  crossSectionLeader: 4,
  crossSectionKeyPitch: 4.2,
  crossSectionKeyGap: 6,
  crossSectionSwatchR: 1.3,
  fontCrossSectionTag: 3,
  fontCrossSectionKey: 2.9,
  /** gap between the trunk band's column and the cutaway inset below it */
  crossSectionInsetGap: 6,

  /* --- footnotes --- */
  footnoteGap: 6,
  footnoteLineHeight: 3.9,
  footnoteIndent: 7,
  /**
   * Minimum usable column width for the notes list to sit beside the cutaway
   * inset instead of stacking in its own full-width strip below it
   * — free paper the cutaway's row already has, since
   * nothing else is drawn that low. Below this width, wrapping would make the
   * notes harder to read than the height they save is worth, so they fall
   * back to the strip below.
   */
  notesBesideMin: 55,

  /** the drawing is padded out to at least this width : height ratio */
  targetAspect: 1.414,
} as const;

export type Metrics = typeof METRICS;
