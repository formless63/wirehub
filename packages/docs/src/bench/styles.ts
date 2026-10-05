/**
 * The bench build sheet's and BOM's own rules, layered on `SHEET_STYLESHEET`:
 * the owner's drawing-sheet title block (ruled cells, small upper-case labels
 * over large values, black hairlines), one page per bench stage, the numbered
 * landing lists and the check tables. Same house rules: `cs-`-prefixed, in
 * the `wirehub.docs` layer, system fonts, `print-color-adjust: exact`.
 */

export const BENCH_STYLESHEET = `@layer wirehub.docs{
.cs-bench{--cs-accent:#c2602a;--cs-ok:#1f7a45;font-family:Helvetica,Arial,var(--cs-font);font-size:8.6pt}
.cs-tb{border:1pt solid #000;margin:0 0 3mm;break-inside:avoid}
.cs-tb__row{display:flex;border-top:0.6pt solid #000}
.cs-tb__row--top{border-top:0}
.cs-tb__kind{writing-mode:vertical-rl;transform:rotate(180deg);font-size:6.4pt;font-weight:700;letter-spacing:0.14em;padding:1mm 0.8mm;border-right:0.6pt solid #000;background:#000;color:#fff;text-align:center}
.cs-tb__cell{flex:1 1 0;min-width:0;padding:0.9mm 1.6mm 1.1mm;border-left:0.6pt solid #000;display:flex;flex-direction:column;gap:0.3mm}
.cs-tb__row .cs-tb__cell:first-child,.cs-tb__kind+.cs-tb__cell{border-left:0}
.cs-tb__rights{border-top:0.6pt solid #000;padding:0.6mm 1.6mm;font-size:6pt;letter-spacing:0.04em}
.cs-tb__title{flex:3 1 0}
.cs-tb__pncell{flex:1.6 1 0}
.cs-tb__rev{flex:0.9 1 0}
.cs-tb__k{font-size:5.6pt;letter-spacing:0.08em;text-transform:uppercase;color:#000}
.cs-tb__v{font-size:9.4pt;line-height:1.2;overflow-wrap:normal;word-break:normal;hyphens:none}
.cs-tb__title .cs-tb__v{font-size:11.5pt;font-weight:700}
.cs-tb__pn{font-size:12pt;font-weight:700;letter-spacing:0.02em;display:block}
.cs-tb__pns{display:flex;flex-wrap:wrap;gap:0.6mm 2.4mm;font-weight:700;font-size:9pt}
.cs-tb__sub{display:block;font-size:6.6pt;color:var(--cs-muted);letter-spacing:0.04em}
.cs-tb__none{font-size:9pt;font-weight:700;color:var(--cs-hazard)}
.cs-tb__mono .cs-tb__v{font-family:var(--cs-mono);font-size:7.6pt}
.cs-tb__cell.cs-is-flag .cs-tb__v{font-weight:700;color:var(--cs-hazard);font-size:7.6pt;overflow-wrap:normal}
.cs-badge{display:inline-block;margin-top:0.6mm;padding:0.2mm 1.2mm;border:0.8pt solid currentColor;border-radius:0.6mm;font-size:6.4pt;font-weight:700;letter-spacing:0.1em;width:max-content}
.cs-badge.cs-is-released{color:var(--cs-ok)}
.cs-badge.cs-is-unreleased{color:var(--cs-hazard)}
.cs-run{display:flex;gap:4mm;justify-content:space-between;border-bottom:0.8pt solid #000;padding:0 0 0.8mm;margin:0 0 2.6mm;font-size:6.8pt}
.cs-run__pn{font-weight:700}
.cs-run__stage{font-weight:700;letter-spacing:0.1em;text-transform:uppercase}
.cs-page{break-before:page}
.cs-page:first-of-type{break-before:auto}
.cs-stage{display:flex;align-items:baseline;gap:2.4mm;margin:0 0 2mm;border-bottom:1.2pt solid #000;padding-bottom:0.8mm;break-after:avoid}
.cs-stage__n{display:inline-flex;align-items:center;justify-content:center;width:6mm;height:6mm;border-radius:50%;background:#000;color:#fff;font-weight:700;font-size:9pt;flex:0 0 auto}
.cs-stage__h{font-size:12pt;font-weight:700;margin:0}
.cs-stage__sub{color:var(--cs-muted);font-size:8pt}
.cs-cols{display:grid;grid-template-columns:1fr 1fr;gap:4mm;align-items:start}
.cs-block{margin:0 0 3mm;break-inside:avoid}
.cs-block__h{font-size:7.2pt;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 1.2mm;color:#000}
.cs-steps{margin:0;padding:0;list-style:none;counter-reset:cs-step}
.cs-steps li{display:flex;gap:1.8mm;margin:0 0 1mm;break-inside:avoid}
.cs-steps li::before{counter-increment:cs-step;content:counter(cs-step);flex:0 0 4.2mm;height:4.2mm;border:0.7pt solid #000;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:6.4pt;font-weight:700;margin-top:0.2mm}
.cs-steps .cs-src{display:block;color:var(--cs-faint);font-size:6pt}
.cs-check{display:inline-block;width:3.2mm;height:3.2mm;border:0.7pt solid #000;border-radius:0.4mm;vertical-align:-0.5mm}
.cs-pull td:first-child{width:5mm}
.cs-sku{font-family:var(--cs-mono);font-weight:700;white-space:nowrap}
.cs-desc{font-weight:600}
.cs-jumpers{display:block;color:var(--cs-accent);font-weight:700;font-size:6.8pt}
.cs-flag{display:inline-block;padding:0 1mm;border:0.8pt solid var(--cs-hazard);color:var(--cs-hazard);font-weight:700;font-size:6.2pt;letter-spacing:0.08em;border-radius:0.5mm}
.cs-proposal{display:block;color:var(--cs-muted);font-size:6.6pt;margin-top:0.4mm}
.cs-table tr.cs-is-unmapped{background:var(--cs-hazard-fill)}
.cs-callout{border:0.8pt solid var(--cs-hazard);color:var(--cs-hazard);padding:1.2mm 2mm;margin:0 0 3mm;font-weight:600}
.cs-bench-fig,.cs-bench-strip{display:block;max-width:100%;height:auto}
.cs-bench-fig{width:100%}
.cs-figwrap{margin:0 0 2.4mm;break-inside:avoid}
.cs-figwrap__cap{font-size:7.2pt;font-weight:700;margin:0 0 0.8mm}
.cs-figwrap__cap .cs-meta{font-weight:400}
.cs-chips{display:flex;flex-wrap:wrap;gap:1mm 1.6mm;margin:0 0 2mm}
.cs-chip{border:0.7pt solid #000;border-radius:0.8mm;padding:0.2mm 1.2mm;font-size:7pt;white-space:nowrap}
.cs-chip.cs-is-closed{border-color:var(--cs-accent);color:var(--cs-accent);font-weight:700}
.cs-chip.cs-is-open{border-style:dashed;color:var(--cs-muted)}
.cs-chip.cs-is-omit{border-style:dashed;color:var(--cs-hazard);text-decoration:line-through}
.cs-landlist{list-style:none;margin:0 0 2mm;padding:0;columns:2;column-gap:5mm}
.cs-landlist--one{columns:1}
.cs-landlist li{display:flex;gap:1.6mm;align-items:baseline;break-inside:avoid;margin:0 0 0.8mm}
.cs-n{display:inline-flex;align-items:center;justify-content:center;flex:0 0 4.4mm;height:4.4mm;border-radius:50%;background:#000;color:#fff;font-size:6.6pt;font-weight:700}
.cs-swatch{display:inline-block;width:2.4mm;height:2.4mm;border:0.5pt solid #000;border-radius:0.4mm;vertical-align:-0.3mm;margin-right:0.8mm}
.cs-cut{border-collapse:collapse;width:100%;font-size:7.6pt;margin:0 0 2mm}
.cs-cut th,.cs-cut td{border:0.5pt solid #000;padding:0.7mm 1.4mm;text-align:left}
.cs-cut th{font-size:6pt;letter-spacing:0.08em;text-transform:uppercase;background:#f1f2f3}
.cs-cut .cs-num{text-align:right}
.cs-matrix{border-collapse:collapse;font-size:6.4pt;margin:0 0 2mm}
.cs-matrix th,.cs-matrix td{border:0.5pt solid #9aa2aa;padding:0.3mm 0.6mm;text-align:center;min-width:4.2mm}
.cs-matrix th{font-weight:600;background:#f1f2f3;white-space:nowrap}
.cs-matrix th.cs-rowh{text-align:left}
.cs-matrix td.cs-is-open{color:var(--cs-ok);font-weight:700}
.cs-matrix td.cs-is-same{background:#e7f1ea}
.cs-matrix td.cs-is-common{background:#fdf4e4;color:var(--cs-caution);font-weight:700}
.cs-matrix td.cs-is-bad{background:var(--cs-hazard-fill);color:var(--cs-hazard);font-weight:700}
.cs-matrix td.cs-is-diag{background:#e4e7ea}
.cs-legend{font-size:6.6pt;color:var(--cs-muted);margin:0 0 2mm}
.cs-bomtable td:nth-child(2){width:32mm}
.cs-bomtable td:nth-child(4){width:40mm}
.cs-refs{display:block;font-family:var(--cs-mono);font-size:6pt;color:var(--cs-faint)}
.cs-bomtable td:nth-child(1){width:12mm}
.cs-variations{width:auto;min-width:80mm}
@media screen{
.cs-page{margin-top:10mm;padding-top:8mm;border-top:1px dashed var(--cs-rule-light)}
.cs-page:first-of-type{margin-top:0;padding-top:0;border-top:0}
}
}`;
