/**
 * The label's QR code (cs-8kj.5): `qrcode-generator` (MIT, no dependencies,
 * pinned), error correction M, the smallest version that holds the text.
 * Deterministic: the same text gives the same modules. The payload is plain
 * ASCII (anything else is replaced), so every reader decodes it the same way.
 *
 * What a label encodes is the design's part number and revision
 * (`PN rev N`), or a URL built from the hub's pattern (Settings › Documents):
 * `{pn}`, `{rev}`, `{design}` and `{label}` are replaced.
 */

import qrcode from 'qrcode-generator';

/** The default payload: the part number and revision, readable by eye as well as by a phone. */
export function qrPayload(facts: { pn?: string; rev?: string; design?: string; label?: string }, pattern?: string): string {
  const pn = facts.pn ?? facts.design ?? '';
  const rev = facts.rev ?? '';
  const text =
    pattern !== undefined && pattern.trim() !== ''
      ? pattern.replace(/\{(pn|rev|design|label)\}/g, (_, key: 'pn' | 'rev' | 'design' | 'label') => encodeURIComponent(({ pn, rev, design: facts.design ?? '', label: facts.label ?? '' })[key]))
      : `${pn}${rev === '' || rev === '—' ? '' : ` rev ${rev}`}`;
  return text.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

/** The dark modules as rows of booleans (a quiet zone is the caller's). */
export function qrModules(text: string): boolean[][] {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const count = code.getModuleCount();
  return Array.from({ length: count }, (_, r) => Array.from({ length: count }, (_, c) => code.isDark(r, c)));
}

const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);

/**
 * The code as SVG, `size` mm square with its top-left at (`x`, `y`): one `<rect>` per horizontal run of
 * dark modules, so the PDF writers need nothing but rectangles. The quiet zone is the caller's to leave.
 */
export function qrSvg(text: string, x: number, y: number, size: number): string {
  const modules = qrModules(text);
  const cell = size / modules.length;
  const out: string[] = [`<g data-qr="${modules.length}" fill="#000000">`];
  modules.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (row[c] !== true) {
        c += 1;
        continue;
      }
      let end = c;
      while (end < row.length && row[end] === true) end += 1;
      out.push(`<rect x="${n3(x + c * cell)}" y="${n3(y + r * cell)}" width="${n3((end - c) * cell)}" height="${n3(cell)}"/>`);
      c = end;
    }
  });
  out.push('</g>');
  return out.join('');
}
