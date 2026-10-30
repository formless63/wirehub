// @vitest-environment jsdom
/** Notes are user text shown inside the app: nothing in one may run, load remotely or link to script (specs/knowledge.md). */
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { sniffAttachment } from '../server/knowledge.ts';
import { Markdown, safeHref } from '../src/knowledge/Markdown.tsx';

afterEach(cleanup);

it('renders raw HTML as text and only safe links and hub-owned images', () => {
  const blob = `/api/blobs/${'a'.repeat(64)}`;
  const { container } = render(<Markdown source={[
    '<script>alert(1)</script> <img src=x onerror=alert(2)>',
    '[bad](javascript:alert) [ok](https://example.com/a) [local](/projects/x) [proto](//evil.example/x)',
    `![remote](https://example.com/x.png) ![own](${blob})`,
  ].join('\n\n')} />);
  expect(container.querySelector('script')).toBeNull();
  expect(container.textContent).toContain('<script>alert(1)</script>');
  expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual([blob]);
  expect([...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a', '/projects/x']);
  expect(safeHref('java\tscript:alert(1)')).toBeUndefined();
});

it('names an upload by its bytes, not by what the client claims', () => {
  expect(sniffAttachment(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBe('application/octet-stream');
  expect(sniffAttachment(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
  expect(sniffAttachment(new TextEncoder().encode('%PDF-1.7'))).toBe('application/pdf');
});
