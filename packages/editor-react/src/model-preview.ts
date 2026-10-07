/** Source context explicitly recorded by the converter, independent of WebGL availability. */
export function modelPreviewNote(bytes: ArrayBuffer, mime: string): string | undefined {
  if (mime !== 'model/gltf-binary' || bytes.byteLength < 20) return undefined;
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength || view.getUint32(16, true) !== 0x4e4f534a) return undefined;
  const length = view.getUint32(12, true);
  if (length > bytes.byteLength - 20) return undefined;
  try {
    const document: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)));
    if (document === null || typeof document !== 'object' || !('asset' in document)) return undefined;
    const asset = document.asset;
    if (asset === null || typeof asset !== 'object' || !('extras' in asset)) return undefined;
    const extras = asset.extras;
    if (extras === null || typeof extras !== 'object' || !('source' in extras) || extras.source !== 'kicad-assembly') return undefined;
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
