/**
 * Element path addressing inside a wire definition.
 *
 * A path is the dot-joined chain of element ids starting at the *children* of
 * the root group: `core-red.center`, `overall-shield`, `drain`.
 */

import type {
  Element,
  ElectricalElement,
  GroupElement,
  WireDefinition,
} from './model.ts';

export function isGroup(el: Element): el is GroupElement {
  return el.kind === 'group';
}

/** Conductors and shields carry terminals; insulation and groups do not. */
export function isElectricalElement(el: Element): el is ElectricalElement {
  return el.kind === 'conductor' || el.kind === 'shield';
}

export interface ElementAtPath {
  path: string;
  element: Element;
  /** path of the containing group, '' for direct children of the root */
  parentPath: string;
}

/** Every element in the tree, excluding the root group itself. */
export function elementPaths(root: GroupElement): ElementAtPath[] {
  const out: ElementAtPath[] = [];
  const walk = (children: Element[], prefix: string): void => {
    for (const child of children) {
      const path = prefix === '' ? child.id : `${prefix}.${child.id}`;
      out.push({ path, element: child, parentPath: prefix });
      if (isGroup(child)) walk(child.children, path);
    }
  };
  walk(root.children, '');
  return out;
}

/** Paths of every terminal-bearing element in the tree. */
export function electricalPaths(root: GroupElement): string[] {
  return elementPaths(root)
    .filter((e) => isElectricalElement(e.element))
    .map((e) => e.path);
}

/** Resolve a dot-joined element path; `undefined` when it does not exist. */
export function resolveElementPath(
  root: GroupElement,
  path: string,
): Element | undefined {
  if (path === '') return undefined;
  const segments = path.split('.');
  let children: Element[] = root.children;
  let found: Element | undefined;
  for (const segment of segments) {
    found = children.find((c) => c.id === segment);
    if (found === undefined) return undefined;
    children = isGroup(found) ? found.children : [];
  }
  return found;
}

/** Convenience: resolve a path within a wire definition. */
export function resolveWirePath(
  wire: WireDefinition,
  path: string,
): Element | undefined {
  return resolveElementPath(wire.structure, path);
}

/**
 * Sibling id collisions and missing ids, reported as `{ parentPath, id }`
 * pairs. Used by `validateDb`.
 */
export function duplicateSiblingIds(
  root: GroupElement,
): { parentPath: string; id: string }[] {
  const out: { parentPath: string; id: string }[] = [];
  const walk = (group: GroupElement, prefix: string): void => {
    const seen = new Set<string>();
    for (const child of group.children) {
      if (seen.has(child.id)) out.push({ parentPath: prefix, id: child.id });
      seen.add(child.id);
      if (isGroup(child)) walk(child, prefix === '' ? child.id : `${prefix}.${child.id}`);
    }
  };
  walk(root, '');
  return out;
}
