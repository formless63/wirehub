/**
 * The frame spec a sheet is drawn with, from what the sheet knows. One place
 * decides the defaults every sheet shares: the paper (the sheet's own, else
 * the organisation's, else A4), the title-block layout (the sheet's own, else
 * the organisation's, else the paper's convention), the issuing organisation
 * and its logo.
 */

import { registeredLogo, registeredTitleBlock } from '../drawing/assets.ts';
import type { FrameExtras, FrameLogo, RevisionRow, SheetFrameSpec } from './layout.ts';
import { PAPERS, isPaperId, isTitleBlockStandard, type Orientation, type PaperId, type TitleBlockStandard } from './paper.ts';

export interface FrameInput {
  kind: string;
  title: string;
  orientation: Orientation;
  variant?: 'full' | 'strip';
  paper?: PaperId;
  standard?: TitleBlockStandard;
  org?: string;
  pn?: string;
  rev?: string;
  state?: string;
  drawn?: string;
  checked?: string;
  date?: string;
  sheet?: string;
  revisions?: readonly RevisionRow[];
  extras?: FrameExtras;
}

/** The paper a sheet prints on: asked for, else the organisation's setting, else A4. */
export function effectivePaper(asked?: PaperId): PaperId {
  if (asked !== undefined && isPaperId(asked)) return asked;
  const set = registeredTitleBlock().paper;
  return set !== undefined && isPaperId(set) ? set : 'A4';
}

export function effectiveStandard(paper: PaperId, asked?: TitleBlockStandard): TitleBlockStandard {
  if (asked !== undefined && isTitleBlockStandard(asked)) return asked;
  const set = registeredTitleBlock().titleBlock;
  return set !== undefined && isTitleBlockStandard(set) ? set : PAPERS[paper].standard;
}

function registeredFrameLogo(): FrameLogo | undefined {
  const logo = registeredLogo();
  if (logo === undefined) return undefined;
  const [, , w, h] = logo.box;
  return h > 0 && w > 0 ? { pngBase64: logo.pngBase64, aspect: w / h } : undefined;
}

export function frameSpecFor(input: FrameInput): SheetFrameSpec {
  const paper = effectivePaper(input.paper);
  const org = input.org ?? registeredTitleBlock().organisation;
  const logo = registeredFrameLogo();
  return {
    paper,
    orientation: input.orientation,
    standard: effectiveStandard(paper, input.standard),
    variant: input.variant ?? 'full',
    kind: input.kind,
    ...(org === undefined || org === '' ? {} : { org }),
    ...(logo === undefined ? {} : { logo }),
    title: input.title,
    ...(input.pn === undefined || input.pn === '' ? {} : { pn: input.pn }),
    ...(input.rev === undefined || input.rev === '' ? {} : { rev: input.rev }),
    ...(input.state === undefined || input.state === '' ? {} : { state: input.state }),
    ...(input.drawn === undefined || input.drawn === '' || input.drawn === '—' ? {} : { drawn: input.drawn }),
    ...(input.checked === undefined || input.checked === '' ? {} : { checked: input.checked }),
    ...(input.date === undefined || input.date === '' ? {} : { date: input.date }),
    ...(input.sheet === undefined ? {} : { sheet: input.sheet }),
    ...(input.revisions === undefined ? {} : { revisions: input.revisions }),
    ...(input.extras === undefined ? {} : { extras: input.extras }),
  };
}
