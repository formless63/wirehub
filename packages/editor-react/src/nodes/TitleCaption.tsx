/** Full verbose names continue below the drawing, without moving its pins or artwork. */
import type { JSX } from 'react';
import type { EditorNodeData } from '../derive.ts';
import { nodeTitleCaption, type TitleCaptionGeometry } from '../layout-size.ts';

export function TitleCaption({ data }: { data: EditorNodeData }): JSX.Element | null {
  const caption = nodeTitleCaption(data);
  return <WrappedTitle caption={caption} />;
}

export function WrappedTitle({ caption }: { caption: TitleCaptionGeometry | undefined }): JSX.Element | null {
  if (caption === undefined) return null;
  return (
    <div className="cs-node-title-caption" style={{ width: caption.width, height: caption.height }} title={caption.title}>
      {caption.lines.map((line, index) => <span key={index}>{line}</span>)}
    </div>
  );
}
