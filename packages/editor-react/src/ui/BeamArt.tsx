import type { JSX } from 'react';

/**
 * A quiet empty-state illustration: two terminals joined by a wire with a copper pulse travelling
 * along it. Adapted in spirit from Magic UI's "animated beam"; our own SVG, no dependency. The pulse
 * only moves when the user has not asked for reduced motion (ui.css), otherwise it rests as a short
 * copper segment. Decorative: hidden from assistive tech.
 */
export function BeamArt({ width = 160 }: { width?: number }): JSX.Element {
  return (
    <svg className="cs-ui-beam" width={width} height={Math.round(width * 0.3)} viewBox="0 0 160 48" fill="none" aria-hidden>
      <rect x="2" y="14" width="22" height="20" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <rect x="136" y="14" width="22" height="20" rx="3" stroke="currentColor" strokeWidth="1.5" />
      <path d="M24 24 C 60 24, 60 10, 80 10 S 100 24, 136 24" stroke="currentColor" strokeWidth="1.5" pathLength="100" />
      <path className="cs-ui-beam-pulse" d="M24 24 C 60 24, 60 10, 80 10 S 100 24, 136 24" strokeWidth="2.5" strokeLinecap="round" pathLength="100" />
    </svg>
  );
}
