export function parseTokens(css: string): {
  base: Record<string, string>;
  light: Record<string, string>;
  fallback: Record<string, string>;
};
export function generate(css: string): { 'tokens.ts': string; 'theme.css': string };
