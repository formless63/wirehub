import { definitionNoun, parseSubject, type HistoryTouch } from './types.ts';

const LIBRARY: Readonly<Record<string, string>> = { connectors: 'Connectors', bodies: 'Connector bodies', interfaces: 'Pinouts', components: 'Components', wires: 'Wire stocks', pcbas: 'Boards', mechanicals: 'Shells and hardware', kits: 'Kits' };
const PART: Readonly<Record<string, string>> = { drawing: 'drawing details', versions: 'saved versions', photo: 'photo', '3D model': '3D model', record: '', design: '' };
const title = (value: string): string => value.replace(/[-_]+/g, ' ');

/** Display record keys readably without substituting today's name for a historical name. */
export function historyTouchLabel(touch: HistoryTouch): string {
  const subject = parseSubject(touch.subject);
  const suffix = touch.part === undefined ? '' : PART[touch.part] ?? title(touch.part);
  if (subject?.type === 'design') return `Design: ${title(subject.id)}${suffix === '' ? '' : ` · ${suffix}`}`;
  if (subject?.type === 'definition') return `${definitionNoun(subject.kind)}: ${title(subject.id)}${suffix === '' ? '' : ` · ${suffix}`}`;
  if (touch.subject.startsWith('other:definitions:')) {
    const kind = touch.subject.slice('other:definitions:'.length).replace(/\.json$/, '');
    return `${LIBRARY[kind] ?? title(kind)} library`;
  }
  if (subject?.type === 'vocab') return `Vocabulary: ${title(subject.list)}`;
  if (subject?.type === 'build') return `Board build: ${title(subject.name)}`;
  if (touch.subject.startsWith('other:doc:')) {
    const name = touch.subject.slice('other:doc:'.length).split('/').pop()?.replace(/\.json$/, '') ?? 'hub';
    return `Settings: ${title(name)}`;
  }
  return touch.label;
}
