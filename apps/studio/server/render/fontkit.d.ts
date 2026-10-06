/** The small public fontkit surface used by the server's font converter. */
declare module 'fontkit' {
  export interface Font {
    numGlyphs: number;
    createSubset(): { includeGlyph(glyph: number): number; encode(): Uint8Array };
    getGlyph(glyph: number): { advanceWidth: number; path: { commands: unknown[]; toSVG(): string }; bbox: { minX: number; minY: number; maxX: number; maxY: number } };
    glyphForCodePoint(codePoint: number): { id: number };
  }
  export function create(bytes: Uint8Array): Font;
}
