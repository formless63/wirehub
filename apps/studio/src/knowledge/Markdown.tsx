/**
 * A small, safe markdown renderer for notes (`specs/knowledge.md`). It builds React elements
 * directly — never HTML strings — so raw HTML in a note is shown as text and nothing in a note can
 * run script. Links are limited to http(s), mailto and same-site paths; images only to the hub's own
 * content-addressed blobs (no remote loading). Supported: headings, paragraphs, lists (with task
 * boxes), quotes, fenced code, rules, `code`, **bold**, *italic*, [links](url).
 */
import type { JSX, ReactNode } from 'react';

const SAFE_LINK = /^(?:https?:\/\/|mailto:|\/(?!\/))/i;
const BLOB_IMAGE = /^\/api\/blobs\/[0-9a-f]{64}$/;

export function safeHref(url: string): string | undefined {
  const trimmed = url.trim();
  // no control characters or whitespace tricks inside the scheme (`java\tscript:`)
  if (/[\u0000-\u001f\u007f\s]/.test(trimmed)) return undefined;
  return SAFE_LINK.test(trimmed) ? trimmed : undefined;
}

const INLINE = /(`[^`]+`)|(!?\[[^\]]*\]\([^)\s]*\))|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const k = `${key}-${n++}`;
    if (token.startsWith('`')) out.push(<code key={k} className="rounded bg-raised px-1 font-mono text-xs">{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) out.push(<strong key={k}>{inline(token.slice(2, -2), k)}</strong>);
    else if (token.startsWith('*') || token.startsWith('_')) out.push(<em key={k}>{inline(token.slice(1, -1), k)}</em>);
    else {
      const image = token.startsWith('!');
      const label = token.slice(image ? 2 : 1, token.indexOf(']('));
      const url = token.slice(token.indexOf('](') + 2, -1);
      if (image && BLOB_IMAGE.test(url)) out.push(<img key={k} src={url} alt={label} loading="lazy" className="my-1 max-h-48 max-w-full rounded border border-line object-contain" />);
      else {
        const href = image ? undefined : safeHref(url);
        out.push(href === undefined ? <span key={k}>{label}</span>
          : <a key={k} href={href} className="underline" {...(href.startsWith('/') ? {} : { target: '_blank', rel: 'noopener noreferrer nofollow' })}>{label}</a>);
      }
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source, className }: { source: string; className?: string }): JSX.Element {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let b = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const key = `b${b++}`;
    if (line.trim() === '') { i += 1; continue; }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] as string).startsWith('```')) body.push(lines[i++] as string);
      i += 1;
      blocks.push(<pre key={key} className="overflow-x-auto rounded bg-raised p-2 font-mono text-xs">{body.join('\n')}</pre>);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = (heading[1] as string).length;
      blocks.push(<p key={key} role="heading" aria-level={level + 2} className={level <= 2 ? 'font-semibold text-sm' : 'font-semibold text-xs'}>{inline(heading[2] as string, key)}</p>);
      i += 1;
      continue;
    }
    if (/^(?:-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={key} className="border-line" />); i += 1; continue; }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && (lines[i] as string).startsWith('>')) body.push((lines[i++] as string).replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key} className="border-l-2 border-line2 pl-2 text-dim">{inline(body.join(' '), key)}</blockquote>);
      continue;
    }
    const listItem = /^\s*(?:[-*+]|\d+[.)])\s+/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: ReactNode[] = [];
      while (i < lines.length && listItem.test(lines[i] as string)) {
        const raw = (lines[i++] as string).replace(listItem, '');
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(raw);
        items.push(<li key={`${key}-${items.length}`}>{task === null ? inline(raw, `${key}-${items.length}`) : <><span aria-label={task[1] === ' ' ? 'open' : 'done'}>{task[1] === ' ' ? '☐ ' : '☑ '}</span>{inline(task[2] as string, `${key}-${items.length}`)}</>}</li>);
      }
      blocks.push(ordered ? <ol key={key} className="list-decimal pl-5">{items}</ol> : <ul key={key} className="list-disc pl-5">{items}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && (lines[i] as string).trim() !== '' && !/^(```|#{1,4}\s|>|\s*(?:[-*+]|\d+[.)])\s)/.test(lines[i] as string)) para.push(lines[i++] as string);
    if (para.length === 0) { para.push(line); i += 1; }
    blocks.push(<p key={key}>{inline(para.join(' '), key)}</p>);
  }
  return <div className={`flex flex-col gap-1.5 text-xs leading-relaxed ${className ?? ''}`}>{blocks}</div>;
}
