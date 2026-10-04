/**
 * The DOM side both 3D views share (`ModelViewer3d`, `WireModel3d`): the
 * theme read off the page's tokens, and WebGL or why not. Imported only by
 * the lazy viewer chunks.
 */

import type { ScenePalette } from '../model-scene.ts';

export function isDarkTheme(): boolean {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'dark' || (theme !== 'light' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
}

/** The theme's colours, read off the page's tokens (`tokens.css`). */
export function readPalette(element: Element): ScenePalette {
  const style = getComputedStyle(element);
  const dark = isDarkTheme();
  const background = style.getPropertyValue('--canvas').trim() || (dark ? '#0f1012' : '#f4f2ee');
  return { background, body: dark ? '#c9c4ba' : '#a9a49a', dark };
}

/** A token's value, or `undefined` when the stylesheet does not set it. */
export function readToken(element: Element, name: string): string | undefined {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  return value === '' ? undefined : value;
}

/** WebGL, or `null` (an old browser, jsdom). */
export function webglContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | WebGLRenderingContext | null {
  try {
    return (canvas.getContext('webgl2') as WebGL2RenderingContext | null) ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
  } catch {
    return null;
  }
}

export const NO_WEBGL = 'This browser cannot draw 3D here (WebGL is unavailable)';
