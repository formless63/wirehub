/** Read only a GLB's bounded JSON chunk; no WebGL and no mutation of source bytes. */
export function glbDocument(bytes: ArrayBuffer, mime: string): Record<string, unknown> | undefined {
  if (mime !== 'model/gltf-binary' || bytes.byteLength < 20) return undefined;
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) return undefined;
  const length = view.getUint32(12, true);
  if (length > bytes.byteLength - 20) return undefined;
  try {
    const document: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
    return document !== null && typeof document === 'object' && !Array.isArray(document) ? document as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** Source context explicitly recorded by the converter, independent of WebGL availability. */
export function modelPreviewNote(bytes: ArrayBuffer, mime: string): string | undefined {
  try {
    const document = glbDocument(bytes, mime);
    if (document === undefined || document === null || typeof document !== 'object' || !('asset' in document)) return undefined;
    const asset = document.asset;
    if (asset === null || typeof asset !== 'object' || !('extras' in asset)) return undefined;
    const extras = asset.extras;
    if (extras === null || typeof extras !== 'object' || !('source' in extras)) return undefined;
    if (extras.source === 'parametric') return 'Generated approximation from catalog dimensions; shape and finish are illustrative. Check the source citation or attach exact manufacturer CAD.';
    if (extras.source !== 'kicad-assembly') return undefined;
    if ('unreadModels' in extras && typeof extras.unreadModels === 'string' && extras.unreadModels.trim() !== '') {
      return 'Some footprint models could not be read; this preview is incomplete.';
    }
    if ('instances' in extras && extras.instances === 0) {
      return 'This preview contains board geometry only; no footprint models were included.';
    }
  } catch {
    // A missing or malformed source annotation cannot establish preview coverage.
  }
  return undefined;
}
