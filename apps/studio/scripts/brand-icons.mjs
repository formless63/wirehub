// Renders the PNG icons and the README header from the SVGs in brand/.
// Run from the repository root:
//   pnpm --filter studio brand:icons
// (@resvg/resvg-js is a dependency of the app.) Deterministic: the same
// SVG always gives the same PNG.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const brand = (name) => readFileSync(join(root, 'brand', name), 'utf8');
const png = (svg, width, out) => {
  const image = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  writeFileSync(join(root, out), image.asPng());
  console.log(`${out} ${image.width}x${image.height}`);
};

const mark = brand('wirehub-mark.svg');
png(mark, 32, 'apps/studio/public/favicon-32.png');
png(mark, 180, 'apps/studio/public/apple-touch-icon.png');
png(mark, 192, 'apps/studio/public/icon-192.png');
png(mark, 512, 'apps/studio/public/icon-512.png');
writeFileSync(join(root, 'apps/studio/public/favicon.svg'), mark);
// the development build's favicon: the mark with a copper dot, so a dev tab is never mistaken for a real hub
const dev = brand('wirehub-mark-dev.svg');
png(dev, 32, 'apps/studio/public/favicon-dev-32.png');
writeFileSync(join(root, 'apps/studio/public/favicon-dev.svg'), dev);
// the social card (OpenGraph / Twitter, and the repository's social preview upload)
png(brand('wirehub-social.svg'), 1200, 'brand/wirehub-social.png');
if (process.argv.includes('--preview')) {
  png(brand('wirehub-logo.svg'), 966, 'brand/.preview-logo.png');
  png(brand('wirehub-logo-dark.svg'), 966, 'brand/.preview-logo-dark.png');
  png(brand('wirehub-header.svg'), 1280, 'brand/.preview-header.png');
}
