import type { Db } from '@wirehub/model';

/** The release already used by WireHub's board-model builder. Only metadata is queried. */
export const KICAD = {
  project: 'https://gitlab.com/kicad/libraries/kicad-packages3D',
  tag: '9.0.9.1',
  commit: '2a697f255a3654e5175e2e9b5d2abdb4ca874015',
  license: 'CC-BY-SA-4.0 with the KiCad libraries exception',
} as const;

export const DIRECTORIES = [
  'Connector_RJ.3dshapes', 'Connector_TE-Connectivity.3dshapes',
  'Connector_Molex.3dshapes', 'Connector_JST.3dshapes',
  'Connector_USB.3dshapes', 'Connector_Dsub.3dshapes',
  'Connector_Audio.3dshapes', 'Connector.3dshapes',
] as const;
export type Directory = typeof DIRECTORIES[number];
export function isDirectory(value: string): value is Directory {
  return (DIRECTORIES as readonly string[]).includes(value);
}

export interface AssetSubject { label: string; mpn?: string; manufacturer?: string }

/** Internal shop part numbers deliberately do not become manufacturer queries. */
export function subjectForRecord(db: Db, record?: { kind: string; id: string }): AssetSubject | undefined {
  if (record === undefined) return undefined;
  if (record.kind === 'components') {
    const part = db.components.find((p) => p.id === record.id);
    return part === undefined ? undefined : { label: part.label, ...(part.mpn ? { mpn: part.mpn } : {}), ...(part.manufacturer ? { manufacturer: part.manufacturer } : {}) };
  }
  const parts = record.kind === 'connectors' ? db.connectors : record.kind === 'bodies' ? db.bodies : record.kind === 'mechanicals' ? db.mechanicals : undefined;
  const part = parts?.find((p) => p.id === record.id);
  return part === undefined ? undefined : { label: part.label };
}

export interface ProviderSearch { id: string; label: string; url: string; help: string }
export function providerSearches(query: string): ProviderSearch[] {
  const q = query.trim();
  if (q.length === 0 || q.length > 120 || /[\u0000-\u001f\u007f]/.test(q)) return [];
  return [
    { id: 'te', label: 'TE Connectivity', url: `https://www.te.com/en/search.html?q=${encodeURIComponent(q)}`, help: 'Manufacturer product pages include CAD files where available; check the exact part number and download terms.' },
    { id: 'snapmagic', label: 'SnapMagic Search', url: `https://www.snapeda.com/search/?q=${encodeURIComponent(q)}`, help: 'Search external CAD models. Provider sign-in may be needed for downloads; API access is arranged with the provider.' },
    { id: 'ultralibrarian', label: 'Ultra Librarian', url: `https://app.ultralibrarian.com/search?queryText=${encodeURIComponent(q)}`, help: 'Search external CAD models. Download sign-in and integration access are managed by the provider.' },
  ];
}

export interface CadCandidate { name: string; path: string; url: string; source: string; license: string; match: 'unverified' }

/** Reject remote directory traversal, HTML and unexpected tree entries before making links. */
export function candidatesFromTree(value: unknown, directory: Directory, query: string): CadCandidate[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('The CAD provider returned an invalid file listing.');
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return value.flatMap((item: unknown) => {
    if (item === null || typeof item !== 'object') return [];
    const entry = item as { type?: unknown; path?: unknown; name?: unknown };
    if (entry.type !== 'blob' || typeof entry.name !== 'string' || typeof entry.path !== 'string') return [];
    if (!/^[A-Za-z0-9_.,+()-]+\.(step|stp)$/i.test(entry.name) || entry.name.startsWith('.') || entry.path !== `${directory}/${entry.name}`) return [];
    const name = entry.name;
    if (!words.every((word) => name.toLowerCase().includes(word))) return [];
    const path = entry.path;
    return [{ name, path, url: `${KICAD.project}/-/raw/${KICAD.commit}/${path.split('/').map(encodeURIComponent).join('/')}`, source: `KiCad packages3D ${KICAD.tag}, commit ${KICAD.commit}, ${path}; candidate not verified against the Library part`, license: KICAD.license, match: 'unverified' as const }];
  });
}
