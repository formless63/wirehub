/**
 * The build sheet's stylesheet — print-first, and print-first means the base
 * rules ARE the print rules; screen is the override.
 *
 * Non-negotiables, each of them load-bearing:
 *
 * - Everything lives in `@layer cable-studio.docs`, so a host application's
 *   CSS reset cannot outrank it and it cannot outrank the host's own layers.
 * - Every class is `cs-`-prefixed and every token is a custom property on
 *   `.cs-root`, so a host restyles without forking and nothing collides.
 * - **No web fonts, no external anything.** The SPEC bans external assets and
 *   a webfont is the single biggest source of PDF drift. System stack only.
 * - `print-color-adjust: exact` — conductor colour is *information* here, and
 *   must survive a printer's ink-saving default. Everything colour says, text
 *   says too, so a monochrome photocopy still builds the cable.
 * - Row-level break control: a table row never splits, a heading never
 *   orphans, and a `thead` repeats on continuation pages. A section is NOT
 *   atomic — the test spec runs to several pages and `break-inside: avoid` on
 *   a box taller than the page cannot be honoured anyway; it only wastes the
 *   bottom of the page before it.
 *
 * `@page` cannot be scoped to a class, so it is emitted separately by
 * `renderBuildSheet` from the `paper` option — never from here.
 */

export const SHEET_STYLESHEET = `@layer cable-studio.docs{
.cs-root{
--cs-ink:#14181d;
--cs-muted:#5b6570;
--cs-faint:#98a2ac;
--cs-paper:#ffffff;
--cs-rule:#14181d;
--cs-rule-light:#c3cad1;
--cs-fill-head:#eceff2;
--cs-fill-zebra:#f7f9fa;
--cs-hazard:#8f1d1d;
--cs-hazard-fill:#fbe9e9;
--cs-caution:#7a4a00;
--cs-caution-fill:#fdf4e4;
--cs-font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--cs-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
--cs-size:8.4pt;
--cs-size-small:7.2pt;
--cs-gap:3.4mm;
--cs-cell-y:0.9mm;
--cs-cell-x:1.4mm;
box-sizing:border-box;
max-width:100%;
margin:0 auto;
color:var(--cs-ink);
background:var(--cs-paper);
font-family:var(--cs-font);
font-size:var(--cs-size);
line-height:1.35;
font-variant-numeric:tabular-nums;
print-color-adjust:exact;
-webkit-print-color-adjust:exact;
}
.cs-root *,.cs-root *::before,.cs-root *::after{box-sizing:inherit}
.cs-root p{margin:0 0 1.6mm}
.cs-root ul{margin:0 0 var(--cs-gap);padding-left:5mm}
.cs-root li{margin:0 0 0.8mm;break-inside:avoid}
.cs-root code{font-family:var(--cs-mono);font-size:var(--cs-size-small)}

.cs-titleblock{border:1.2pt solid var(--cs-rule);margin-bottom:var(--cs-gap);break-inside:avoid;break-after:avoid}
.cs-titleblock__bar{display:flex;flex-wrap:wrap;gap:2mm;justify-content:space-between;align-items:baseline;padding:1.4mm var(--cs-cell-x);border-bottom:1pt solid var(--cs-rule);background:var(--cs-fill-head)}
.cs-titleblock__kind{font-weight:700;letter-spacing:0.16em;font-size:9pt}
.cs-titleblock__doc{font-family:var(--cs-mono);font-size:var(--cs-size-small)}
.cs-titleblock__title{padding:1.4mm var(--cs-cell-x);font-size:11pt;font-weight:600;border-bottom:1pt solid var(--cs-rule-light)}
.cs-titleblock__facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(52mm,1fr));gap:0}
.cs-fact{padding:1.2mm var(--cs-cell-x);border-right:1pt solid var(--cs-rule-light);border-top:1pt solid var(--cs-rule-light)}
.cs-fact:last-child{border-right:0}
.cs-fact__k{display:block;font-size:var(--cs-size-small);letter-spacing:0.08em;text-transform:uppercase;color:var(--cs-muted)}
.cs-fact__v{display:block}

.cs-section{margin:0 0 var(--cs-gap);break-inside:auto}
.cs-section__h{font-size:10pt;font-weight:700;letter-spacing:0.06em;margin:0 0 1.4mm;padding-bottom:0.8mm;border-bottom:1pt solid var(--cs-rule);break-after:avoid}
.cs-section__h3{font-size:8.8pt;font-weight:700;margin:2.6mm 0 1.2mm;break-after:avoid}
.cs-meta{color:var(--cs-muted);font-size:var(--cs-size-small)}

.cs-table{width:100%;border-collapse:collapse;margin:0 0 2mm;font-size:var(--cs-size-small)}
.cs-table thead{display:table-header-group}
.cs-table tbody tr{break-inside:avoid}
.cs-table th,.cs-table td{border:0.5pt solid var(--cs-rule-light);padding:var(--cs-cell-y) var(--cs-cell-x);text-align:left;vertical-align:top;overflow-wrap:normal;word-break:normal;hyphens:none;min-width:3.2em}
.cs-table th{background:var(--cs-fill-head);font-weight:700;border-bottom:1pt solid var(--cs-rule)}
.cs-table tbody tr:nth-child(even){background:var(--cs-fill-zebra)}
.cs-table .cs-num{text-align:right;white-space:nowrap}

.cs-figure{margin:0 0 var(--cs-gap);break-inside:avoid}
.cs-figure__cap{font-size:var(--cs-size-small);color:var(--cs-muted);margin:0 0 1mm}
.cs-figure svg{display:block;width:100%;height:auto;max-width:100%;border:0.5pt solid var(--cs-rule-light)}
.cs-figure--cutaway svg{max-width:140mm}

.cs-caution{border-left:2pt solid var(--cs-caution);background:var(--cs-caution-fill);padding:1.2mm 2mm;color:var(--cs-caution)}
.cs-hazard{border-left:2pt solid var(--cs-hazard);background:var(--cs-hazard-fill);padding:1.2mm 2mm;color:var(--cs-hazard);font-weight:600}
.cs-notes{list-style:none;padding-left:0}
.cs-notes li{display:flex;gap:1.6mm}
.cs-footnotes{counter-reset:cs-note;list-style:none;padding-left:0}
.cs-footnotes li{display:flex;gap:1.6mm}
.cs-footnotes li::before{counter-increment:cs-note;content:counter(cs-note);flex:0 0 5mm;text-align:right;font-weight:700;color:var(--cs-muted)}
.cs-tag{font-family:var(--cs-mono);font-size:var(--cs-size-small);color:var(--cs-muted);flex:0 0 auto}
.cs-topics{font-size:var(--cs-size-small);color:var(--cs-faint);flex:0 0 auto}
.cs-foot{border-top:1pt solid var(--cs-rule-light);padding-top:1.2mm;color:var(--cs-muted);font-size:var(--cs-size-small)}

/* the drawings carry their own stylesheet inside the svg element; inline SVG
   in HTML is NOT style-scoped, so renderBuildSheet rewrites those selectors
   to sit under .cs-svg before embedding them. (No angle brackets in here: a
   style block is raw text, and a stray one confuses anything grepping the
   document for an embedded drawing.) */
.cs-svg{color:var(--cs-ink)}

@media screen{
.cs-root{padding:8mm;box-shadow:0 0 0 1px var(--cs-rule-light)}
}
}`;
