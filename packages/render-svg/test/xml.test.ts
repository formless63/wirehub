import { describe, expect, it } from 'vitest';

import { byAttr, byClass, parseXml, textOf, XmlError } from './xml.ts';

describe('the test XML parser', () => {
  it('parses elements, attributes and text', () => {
    const root = parseXml('<a x="1"><b class="k m">hi &amp; bye</b><c/></a>');
    expect(root.name).toBe('a');
    expect(root.attrs['x']).toBe('1');
    expect(root.children).toHaveLength(2);
    expect(textOf(root)).toBe('hi & bye');
    expect(byClass(root, 'm')).toHaveLength(1);
    expect(byAttr(root, 'class')).toHaveLength(1);
  });

  it('rejects malformed documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlError);
    expect(() => parseXml('<a x=1/>')).toThrow(XmlError);
    expect(() => parseXml('<a>tom & jerry</a>')).toThrow(XmlError);
    expect(() => parseXml('<a></a><b></b>')).toThrow(XmlError);
    expect(() => parseXml('<a x="1" x="2"/>')).toThrow(XmlError);
  });
});
