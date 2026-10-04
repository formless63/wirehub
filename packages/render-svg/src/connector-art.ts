/**
 * A connector block's drawing: the shared connector art
 * (`@wirehub/layout`'s `connectorArt` — the same geometry the canvas's
 * connector node paints) in print paint, placed at the block's art frame.
 *
 * Painted as artwork (`.depiction`), under the wiring, so every wire reads as
 * one run on to its pin. Pins a wire lands on print solid ink; unused pins
 * print hollow — the drawing says which pins are wired even before the joint
 * dots go on. The paint is fixed (white paper, like the rest of the sheet):
 * the schematic panel shows the sheet as paper in either theme.
 */

import type { ArtShape, DiagramBlock, DiagramConnectorArt, DiagramMouldJack } from '@wirehub/layout';

import { fmt, leaf, node, text, tooltip } from './svg.ts';

/** Outline weight on the page, mm — divided by the art's scale in its own frame. */
const STROKE_MM = 0.18;

function shape(item: ArtShape, bandPaint: (terminal: string) => string | undefined): string {
  const cls = `ca ca-${item.tone}`;
  switch (item.el) {
    case 'path':
      return leaf('path', { class: cls, d: item.d });
    case 'circle':
      return leaf('circle', { class: cls, cx: item.cx, cy: item.cy, r: item.r });
    case 'rect': {
      const fill = item.band === undefined ? undefined : bandPaint(item.band);
      return leaf('rect', {
        class: cls,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        rx: item.rx,
        ...(fill === undefined ? {} : { fill }),
      });
    }
  }
}

function pin(item: DiagramConnectorArt['pins'][number]): string {
  const cls = `ca-pin ca-pin-${item.form}${item.used ? ' is-used' : ''}`;
  const attrs = { 'data-pin': item.terminal };
  if (item.width !== undefined && item.height !== undefined) {
    return leaf('rect', {
      class: cls,
      ...attrs,
      x: item.x - item.width / 2,
      y: item.y - item.height / 2,
      width: item.width,
      height: item.height,
      rx: Math.min(item.width, item.height) * 0.2,
    });
  }
  return leaf('circle', { class: cls, ...attrs, cx: item.x, cy: item.y, r: item.r ?? 2.2 });
}

/**
 * One connector's drawing, placed at its own art frame — shared by a block
 * (`renderConnectorArt`) and a connector a breakout houses, drawn inside its
 * mould instead (`renderMouldJack`).
 */
function renderConnectorArtAt(instanceId: string, art: DiagramConnectorArt, bandPaint: (terminal: string) => string | undefined): string {
  const what = `${art.short} ${art.view === 'profile' ? 'side view' : 'mating face'}`;
  const body = [
    tooltip(art.approximate ? `${what} — drawn from the family's general shape (approximate)` : what),
    ...art.shapes.map((item) => shape(item, bandPaint)),
    ...art.pins.map((item) => pin(item)),
    ...art.labels.map((label) => text(label.text, { class: 'ca-label', x: label.x, y: label.y, 'text-anchor': label.anchor })),
  ].join('');
  return node(
    'g',
    {
      class: 'depiction connector-art',
      'data-instance': instanceId,
      'data-depiction': `${art.defId}/${art.view === 'profile' ? 'side-profile' : 'mating-face'}`,
      transform: `translate(${fmt(art.rect.x)} ${fmt(art.rect.y)}) scale(${fmt(art.scale)})`,
      'stroke-width': fmt(STROKE_MM / art.scale),
    },
    body,
  );
}

/**
 * One block's connector drawing, or `''` when the block is not drawn as a
 * connector. `bandPaint` colours a profile's grip band with the conductor that
 * lands on the band's terminal, as the canvas does.
 */
export function renderConnectorArt(block: DiagramBlock, bandPaint: (terminal: string) => string | undefined): string {
  const art = block.connectorArt;
  if (art === undefined) return '';
  return renderConnectorArtAt(block.id, art, bandPaint);
}

/**
 * A connector a breakout houses: drawn as itself inside
 * the mould's own outline, its opening facing the same way the mould's legs
 * run — never as a block on a lead. `''` when the definition or family has no
 * drawing (the mould still lists it in words).
 */
export function renderMouldJack(jack: DiagramMouldJack, bandPaint: (terminal: string) => string | undefined): string {
  if (jack.connectorArt === undefined) return '';
  return renderConnectorArtAt(jack.instanceId, jack.connectorArt, bandPaint);
}
