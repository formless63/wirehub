/**
 * Browser-side cover captures for the shared resolver (`representations.ts`): the 3D view's saved
 * camera and the design editor's current view, each stored as one static image. Galleries show
 * only those images; nothing here keeps a live scene.
 */
import type { QueryClient } from '@tanstack/react-query';
import type { ModelCoverAdapter, Outcome } from '@wirehub/editor-react';
import { isCoverKind } from './representations.ts';
import { canvasToCover, coverKey, readCover, saveCoverCapture } from './representations.browser.ts';

export function modelCoverAdapter(client: QueryClient): ModelCoverAdapter {
  return {
    // boards: the attached model's view; wire stock: its construction view (WireStockDetail)
    kinds: new Set(['pcbas']),
    stockViews: true,
    async saved(kind, id) {
      if (!isCoverKind(kind)) return undefined;
      const view = await client.fetchQuery({ queryKey: coverKey(kind, id), queryFn: () => readCover(kind, id), staleTime: 5_000 });
      const camera = view.candidates.find((c) => c.view === 'camera');
      return camera?.camera === undefined ? undefined
        : { camera: camera.camera, stale: camera.stale !== undefined, chosen: view.choice?.view === 'camera' };
    },
    async save(kind, id, capture): Promise<Outcome<null>> {
      if (!isCoverKind(kind)) return { ok: false, message: 'This record has no shared cover.' };
      const out = await saveCoverCapture(kind, id, { view: 'camera', image: capture.image, width: capture.width, height: capture.height, camera: capture.camera }, capture.modelAsset);
      if (!out.ok) return out;
      client.setQueryData(coverKey(kind, id), out.value);
      return { ok: true, value: null };
    },
  };
}

/* ------------------------------------------------------------------ *
 * The design editor's current view, as a static picture
 * ------------------------------------------------------------------ */

/** Chrome that is not part of the picture: toolbars, minimap, zoom controls, hover cards. */
const SKIP = '.react-flow__panel, .react-flow__minimap, .react-flow__controls, .react-flow__attribution, .cs-canvas-toolbar, .cs-schematic-toolbar, .cs-minimap, [role="toolbar"], [role="tooltip"]';

/** Which editor view is on screen and the element that holds its picture. */
export function editorViewElement(root: ParentNode = document): { element: HTMLElement; editorView: 'canvas' | 'schematic' } | undefined {
  const schematic = root.querySelector<HTMLElement>('.cs-schematic-view');
  if (schematic !== null && schematic.offsetParent !== null) return { element: schematic, editorView: 'schematic' };
  const canvas = root.querySelector<HTMLElement>('.cs-canvas .react-flow');
  if (canvas !== null && canvas.offsetParent !== null) return { element: canvas, editorView: 'canvas' };
  return undefined;
}

function cssText(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet: not ours to read
    }
    for (const rule of Array.from(rules)) {
      // fonts cannot load inside an SVG image; the fallback stack draws the text
      if (rule.cssText.startsWith('@font-face')) continue;
      out.push(rule.cssText);
    }
  }
  return out.join('\n');
}

/** Every custom property the page defines, with today's value (theme tokens, light or dark). */
function tokenStyle(css: string): string {
  const names = new Set(css.match(/--[A-Za-z0-9_-]+(?=\s*:)/g) ?? []);
  const root = getComputedStyle(document.documentElement);
  const body = getComputedStyle(document.body);
  return [...names].map((name) => {
    const value = (body.getPropertyValue(name) || root.getPropertyValue(name)).trim();
    return value === '' ? '' : `${name}:${value};`;
  }).join('');
}

async function dataUrl(src: string): Promise<string | undefined> {
  if (src.startsWith('data:')) return src;
  try {
    const response = await fetch(src);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** Shallow copies of the ancestors, so selectors that depend on them still match. */
function ancestorChain(element: HTMLElement, width: number, height: number): { outer: HTMLElement; inner: HTMLElement } {
  const chain: HTMLElement[] = [];
  for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) chain.unshift(node);
  const outer = document.createElement('div');
  outer.className = `${document.documentElement.className} ${document.body.className}`.trim();
  for (const attr of Array.from(document.documentElement.attributes)) if (attr.name.startsWith('data-')) outer.setAttribute(attr.name, attr.value);
  let inner: HTMLElement = outer;
  for (const node of chain) {
    const copy = node.cloneNode(false) as HTMLElement;
    copy.removeAttribute('id');
    copy.setAttribute('style', `display:block;position:relative;margin:0;padding:0;border:0;width:${width}px;height:${height}px;overflow:hidden;transform:none;`);
    inner.appendChild(copy);
    inner = copy;
  }
  return { outer, inner };
}

/**
 * The element as it is drawn now, as a static image: a copy of its DOM with the page's styles and
 * theme tokens inside an SVG `foreignObject`, rasterised in a canvas. Images inside are inlined.
 */
export async function captureEditorView(element: HTMLElement, maxWidth = 960): Promise<{ image: Blob; width: number; height: number }> {
  const box = element.getBoundingClientRect();
  // the canvas: crop to what is drawn (nodes and edges), not the empty grid around it
  let crop: { x: number; y: number; w: number; h: number } | undefined;
  const drawn = Array.from(element.querySelectorAll('.react-flow__node, .react-flow__edge-path')).map((n) => n.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
  if (drawn.length > 0) {
    const pad = 24;
    const left = Math.max(box.left, Math.min(...drawn.map((r) => r.left)) - pad);
    const top = Math.max(box.top, Math.min(...drawn.map((r) => r.top)) - pad);
    const right = Math.min(box.right, Math.max(...drawn.map((r) => r.right)) + pad);
    const bottom = Math.min(box.bottom, Math.max(...drawn.map((r) => r.bottom)) + pad);
    if (right - left > 40 && bottom - top > 40) crop = { x: left - box.left, y: top - box.top, w: right - left, h: bottom - top };
  }
  const width = Math.max(1, Math.round(box.width));
  const height = Math.max(1, Math.round(box.height));
  const clone = element.cloneNode(true) as HTMLElement;
  for (const skip of Array.from(clone.querySelectorAll(SKIP))) skip.remove();
  // canvases (none expected, but a module may draw one) become their pixels
  const sourceCanvases = Array.from(element.querySelectorAll('canvas'));
  Array.from(clone.querySelectorAll('canvas')).forEach((copy, i) => {
    const img = document.createElement('img');
    try { img.src = sourceCanvases[i]?.toDataURL() ?? ''; } catch { /* tainted: leave blank */ }
    img.setAttribute('style', copy.getAttribute('style') ?? '');
    copy.replaceWith(img);
  });
  for (const img of Array.from(clone.querySelectorAll('img'))) {
    const inline = await dataUrl(img.currentSrc || img.src);
    if (inline === undefined) img.removeAttribute('src');
    else img.src = inline;
    img.removeAttribute('srcset');
    img.removeAttribute('loading');
  }
  for (const image of Array.from(clone.querySelectorAll('image'))) {
    const href = image.getAttribute('href') ?? image.getAttribute('xlink:href');
    if (href === null) continue;
    const inline = await dataUrl(href);
    if (inline !== undefined) image.setAttribute('href', inline);
  }
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  clone.style.margin = '0';
  const css = cssText();
  const { outer, inner } = ancestorChain(element, width, height);
  outer.setAttribute('style', `${tokenStyle(css)}width:${width}px;height:${height}px;overflow:hidden;background:${getComputedStyle(document.body).backgroundColor};`);
  inner.appendChild(clone);
  const style = document.createElement('style');
  style.textContent = css;
  outer.prepend(style);
  outer.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  const xhtml = new XMLSerializer().serializeToString(outer);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const picture = new Image();
  picture.decoding = 'sync';
  await new Promise<void>((resolve, reject) => {
    picture.onload = () => resolve();
    picture.onerror = () => reject(new Error('This view could not be drawn as a picture.'));
    picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  if (crop === undefined) return canvasToCover(picture, width, height, maxWidth);
  const cropped = document.createElement('canvas');
  cropped.width = Math.round(crop.w);
  cropped.height = Math.round(crop.h);
  cropped.getContext('2d')?.drawImage(picture, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  return canvasToCover(cropped, cropped.width, cropped.height, maxWidth);
}
