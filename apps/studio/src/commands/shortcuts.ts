/**
 * Keyboard-combo canonicalisation shared by `registry.tsx` (matching a
 * `keydown` against a registered `AppCommand.shortcut`) and `CommandPalette.tsx`
 * (displaying one). A combo is always written modifiers-then-key, modifiers
 * in `Ctrl`, `Shift`, `Alt` order, `+`-joined — `'Ctrl+Shift+Z'`, `'Shift+A'`,
 * `'V'` — so a command author only ever writes the canonical form once and
 * both matching and display agree with it.
 */

/** `KeyboardEvent` → canonical combo, or `''` for a bare modifier keypress (nothing to match). Ctrl and Cmd (`metaKey`) both count as `Ctrl` — Ctrl K / Cmd K per. */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  const key = normalizeKey(event.key);
  if (key === undefined) return '';
  parts.push(key);
  return parts.join('+');
}

function normalizeKey(key: string): string | undefined {
  if (key === 'Control' || key === 'Meta' || key === 'Shift' || key === 'Alt') return undefined;
  if (key === ' ') return 'Space';
  if (key.length === 1) return key.toUpperCase();
  return key; // 'Enter', 'Escape', 'ArrowUp', …
}

/** the canonical form, for a palette row or a tooltip — `'Ctrl+Shift+Z'` → `'Ctrl Shift Z'` */
export function formatShortcut(shortcut: string): string {
  return shortcut.split('+').join(' ');
}

/** true for an `<input>`, `<textarea>`, `<select>` or anything `contenteditable` — every shortcut but Ctrl+K is ignored there (`registry.tsx`'s keydown handler). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.isContentEditable;
}
