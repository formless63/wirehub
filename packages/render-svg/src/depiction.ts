/**
 * Inlining a depiction's artwork into the drawing.
 *
 * The page must stay what it claims to be: **self-contained, deterministic and
 * printable**. So a vector asset is not referenced, it is absorbed — its outer
 * `<svg>` wrapper stripped, its content re-parented under one `<g>` that
 * carries the translate/scale into the block's frame, and anything that could
 * reach outside the file or leak across the page removed on the way in:
 *
 *  - `<script>`, `<style>`, `<metadata>`, `<foreignObject>` and event-handler
 *    attributes never make it through. A `<style>` is the subtle one: CSS in
 *    SVG is document-scoped, so an asset's stylesheet would repaint the whole
 *    schematic, not just its own group.
 *  - `href` / `xlink:href` survive only when they point inside the document
 *    (`#…`) or carry their own bytes (`data:…`).
 *  - every `id` is prefixed per block, and every reference to one rewritten,
 *    so two depicted blocks on one page cannot collide.
 *
 * Namespaces need no work: the wrapper `<g>` sits inside the schematic's own
 * `<svg>`, so the asset's elements inherit the SVG namespace. `xmlns:xlink` is
 * re-declared only if the content actually uses the prefix.
 */

/** Elements whose whole subtree is dropped, wherever they appear. */
const DROPPED_ELEMENTS = ['script', 'style', 'metadata', 'foreignObject'];

function dropElements(svg: string): string {
  let out = svg;
  for (const name of DROPPED_ELEMENTS) {
    out = out
      .replace(new RegExp(`<${name}\\b[^>]*/>`, 'gi'), '')
      .replace(new RegExp(`<${name}\\b[\\s\\S]*?</${name}\\s*>`, 'gi'), '');
  }
  return out;
}

/** The content between the outermost `<svg …>` and its matching `</svg>`. */
export function svgBody(source: string): string {
  const open = /<svg\b[^>]*>/i.exec(source);
  if (open === null) return source;
  const start = open.index + open[0].length;
  const end = source.lastIndexOf('</svg');
  return end === -1 || end < start ? source.slice(start) : source.slice(start, end);
}

/**
 * Prefix every `id` and every reference to one. Called with a per-block prefix
 * (`dep-u1-`), so the same asset used twice on a page stays two distinct
 * sets of ids.
 */
export function prefixIds(body: string, prefix: string): string {
  return body
    .replace(/\bid="([^"]*)"/g, (_match, id: string) => `id="${prefix}${id}"`)
    .replace(/url\(#([^)"']*)\)/g, (_match, id: string) => `url(#${prefix}${id})`)
    .replace(
      /\b(xlink:href|href)="#([^"]*)"/g,
      (_match, name: string, id: string) => `${name}="#${prefix}${id}"`,
    );
}

/**
 * Normalise an asset into one line of markup, ready to be a `<g>`'s children.
 * Whitespace between elements collapses (the generated assets are pretty
 * printed) so the page stays one deterministic line like everything else the
 * renderer emits; whitespace *inside* a text run is left alone.
 */
export function inlineVectorAsset(source: string, prefix: string): string {
  const body = svgBody(dropElements(source))
    // XML declarations and doctypes are document-level, never child content
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    // event handlers
    .replace(/\son[a-zA-Z]+="[^"]*"/g, '')
    // references that leave the file: keep only `#fragment` and `data:` bytes
    .replace(/\s(?:xlink:)?href="(?!#|data:)[^"]*"/g, '');
  return prefixIds(body, prefix)
    .replace(/>\s*\n\s*</g, '><')
    .trim();
}

/** `true` when the inlined content still uses the `xlink:` prefix. */
export function usesXlink(body: string): boolean {
  return /\bxlink:/.test(body);
}
