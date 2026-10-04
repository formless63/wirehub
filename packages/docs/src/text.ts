/**
 * String plumbing shared by the markdown and HTML renderers.
 *
 * Nothing here knows about cables. It exists so that every table in this
 * package escapes the same way and sorts the same way — a build sheet that
 * renders a `|` in a component note must not silently grow a table column,
 * and a document that reorders itself between runs is not a document.
 */

/** HTML-escape text destined for an element body or a double-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Escape the characters that would break out of a markdown table cell. */
export function escapeMarkdownCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Locale-free comparison. `localeCompare` without an explicit locale is the
 * classic source of "the same input sorted differently on the build server",
 * so every sort in this package goes through here.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Compare by a list of string keys, in order. */
export function byKeys<T>(...keys: ((value: T) => string)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const result = compareStrings(key(a), key(b));
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** A markdown pipe table. `align` is per column; defaults to left. */
export function markdownTable(
  headers: string[],
  rows: string[][],
  align: ('left' | 'right')[] = [],
): string {
  const rule = headers.map((_, index) =>
    align[index] === 'right' ? '---:' : ':---',
  );
  const line = (cells: string[]): string =>
    `| ${cells.map(escapeMarkdownCell).join(' | ')} |`;
  return [line(headers), `| ${rule.join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** An HTML table with a `<thead>`; `className` scopes it to this package. */
export function htmlTable(
  className: string,
  headers: string[],
  rows: string[][],
  align: ('left' | 'right')[] = [],
): string {
  const cell = (tag: string, value: string, index: number): string => {
    const classAttr = align[index] === 'right' ? ' class="cs-num"' : '';
    return `<${tag}${classAttr}>${escapeHtml(value)}</${tag}>`;
  };
  const head = `<thead><tr>${headers.map((h, i) => cell('th', h, i)).join('')}</tr></thead>`;
  const body = `<tbody>${rows
    .map((row) => `<tr>${row.map((value, i) => cell('td', value, i)).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table class="${escapeHtml(className)}">${head}${body}</table>`;
}

/** Join the non-empty parts with ` · `, the house separator for fact strips. */
export function facts(parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
}
