/**
 * A tiny, dependency-free XML well-formedness parser for the tests.
 *
 * The workspace pins its dependency budget hard, so rather than pull a parser
 * in just to assert "the SVG parses", the tests use this: it enforces the
 * rules that matter for a self-contained SVG (balanced tags, quoted attribute
 * values, escaped text) and hands back a tree the structural assertions can
 * query. It is not a general XML implementation — no namespaces resolution,
 * no DTDs, no CDATA.
 */

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** direct text content of this element */
  text: string;
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;
const ENTITY = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/y;

export class XmlError extends Error {}

export function parseXml(source: string): XmlNode {
  let index = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;

  // annotated, not just inferred, so control-flow analysis knows a call to
  // `fail` ends the branch
  const fail: (message: string) => never = (message) => {
    const around = source.slice(Math.max(0, index - 40), index + 40);
    throw new XmlError(`${message} at offset ${index}: …${around}…`);
  };

  const readName = (): string => {
    NAME.lastIndex = index;
    const match = NAME.exec(source);
    if (match === null) return fail('expected a tag or attribute name');
    index = NAME.lastIndex;
    return match[0];
  };

  const skipSpace = (): void => {
    while (index < source.length && /\s/.test(source[index] ?? '')) index += 1;
  };

  const checkText = (chunk: string): void => {
    let cursor = 0;
    while (cursor < chunk.length) {
      const at = chunk.indexOf('&', cursor);
      if (at === -1) break;
      ENTITY.lastIndex = at;
      if (ENTITY.exec(chunk) === null) {
        index = index - chunk.length + at;
        fail('unescaped "&" in text');
      }
      cursor = ENTITY.lastIndex;
    }
    if (chunk.includes('<')) fail('unescaped "<" in text');
  };

  while (index < source.length) {
    if (source[index] !== '<') {
      const next = source.indexOf('<', index);
      const chunk = source.slice(index, next === -1 ? source.length : next);
      index = next === -1 ? source.length : next;
      checkText(chunk);
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.text += decode(chunk);
      else if (chunk.trim() !== '') fail('text outside the root element');
      continue;
    }

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index);
      if (end === -1) fail('unterminated comment');
      index = end + 3;
      continue;
    }
    if (source.startsWith('<?', index) || source.startsWith('<!', index)) {
      const end = source.indexOf('>', index);
      if (end === -1) fail('unterminated declaration');
      index = end + 1;
      continue;
    }

    if (source.startsWith('</', index)) {
      index += 2;
      const name = readName();
      skipSpace();
      if (source[index] !== '>') fail('malformed closing tag');
      index += 1;
      const open = stack.pop();
      if (open === undefined) fail(`closing tag </${name}> with nothing open`);
      if (open?.name !== name) fail(`</${name}> closes <${open?.name ?? '?'}>`);
      continue;
    }

    index += 1;
    const name = readName();
    const node: XmlNode = { name, attrs: {}, children: [], text: '' };
    let selfClosed = false;
    for (;;) {
      skipSpace();
      const char = source[index];
      if (char === '>') {
        index += 1;
        break;
      }
      if (char === '/') {
        if (source[index + 1] !== '>') fail('malformed self-closing tag');
        index += 2;
        selfClosed = true;
        break;
      }
      const attribute = readName();
      skipSpace();
      if (source[index] !== '=') fail(`attribute ${attribute} has no value`);
      index += 1;
      skipSpace();
      const quote = source[index];
      if (quote !== '"' && quote !== "'") fail(`attribute ${attribute} is unquoted`);
      index += 1;
      const end = source.indexOf(quote, index);
      if (end === -1) fail(`unterminated value for ${attribute}`);
      const raw = source.slice(index, end);
      if (raw.includes('<')) fail(`unescaped "<" in attribute ${attribute}`);
      checkText(raw);
      if (attribute in node.attrs) fail(`duplicate attribute ${attribute}`);
      node.attrs[attribute] = decode(raw);
      index = end + 1;
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== undefined) fail('more than one root element');
      root = node;
    } else {
      parent.children.push(node);
    }
    if (!selfClosed) stack.push(node);
  }

  if (stack.length > 0) {
    throw new XmlError(`unclosed element <${stack[stack.length - 1]?.name ?? '?'}>`);
  }
  if (root === undefined) throw new XmlError('no root element');
  return root;
}

function decode(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export function walk(node: XmlNode, visit: (node: XmlNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

export function findAll(
  root: XmlNode,
  predicate: (node: XmlNode) => boolean,
): XmlNode[] {
  const out: XmlNode[] = [];
  walk(root, (node) => {
    if (predicate(node)) out.push(node);
  });
  return out;
}

export function hasClass(node: XmlNode, className: string): boolean {
  return (node.attrs['class'] ?? '').split(/\s+/).includes(className);
}

export function byClass(root: XmlNode, className: string): XmlNode[] {
  return findAll(root, (node) => hasClass(node, className));
}

export function byAttr(root: XmlNode, name: string): XmlNode[] {
  return findAll(root, (node) => node.attrs[name] !== undefined);
}

/** All text content of a node and its descendants, in document order. */
export function textOf(node: XmlNode): string {
  let out = '';
  walk(node, (item) => {
    out += item.text;
  });
  return out;
}
