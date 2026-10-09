import { describe, expect, it } from 'vitest';

import { applyFavicon } from '../src/favicon.ts';

const page = () => {
  document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">';
};

describe('favicon states', () => {
  it('keeps the mark in production and adds the dev dot in a development build', () => {
    page();
    expect(applyFavicon(false)).toBe(false);
    expect(document.querySelectorAll('link[rel="icon"]')[0]?.getAttribute('href')).toBe('/favicon.svg');
    expect(applyFavicon(true)).toBe(true);
    const hrefs = [...document.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href'));
    expect(hrefs).toEqual(['/favicon-dev.svg', '/favicon-dev-32.png']);
  });
});
