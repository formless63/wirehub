/** Original RJ45 front/rear artwork and generic PCB-jack face.
 * Separate views avoid depicting a wire-entry plug as solder cups.
 * Source facts, inferred detail and CC0 authorship are recorded in each manifest.
 */
export function networkingFaceArtFiles(): Record<string, string> {
  return {
    "modules/networking/pack/depictions/rj45-8p8c-jack/mating-face.svg": `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18mm" height="18mm">
  <title>RJ45 unshielded PCB jack — mating face</title>
  <desc>Original generic illustration; dimensions and inferred details cited in meta.json. Not manufacturer CAD.</desc>
  <g stroke="currentColor" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.38" y="2" width="15.24" height="11.5" rx="0.45" fill="currentColor" fill-opacity="0.08"/>
    <path d="M3.05 3.5 H14.95 V11.8 H10.5 V13 H7.5 V11.8 H3.05 Z" fill="none"/>
    <path d="M3.7 10.8 H7.5 M10.5 10.8 H14.3" fill="none"/>
    <rect data-pin="1" x="5.22" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="2" x="6.24" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="3" x="7.26" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="4" x="8.28" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="5" x="9.30" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="6" x="10.32" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="7" x="11.34" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <rect data-pin="8" x="12.36" y="4" width="0.42" height="2" rx="0.07" fill="#b88b32"/>
    <text x="5.43" y="1.3" font-size="1.3" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">1</text>
    <text x="12.57" y="1.3" font-size="1.3" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">8</text>
  </g>
</svg>
`,
    "modules/networking/pack/depictions/rj45-8p8c-jack/meta.json": JSON.stringify({
  "defId": "rj45-8p8c-jack",
  "views": {
    "mating-face": {
      "file": "mating-face.svg",
      "kind": "vector",
      "mmPerUnit": 1,
      "sourceKind": "hand",
      "widthUnits": 18,
      "heightUnits": 18,
      "src": "Molex SD-95501-001 revision F1, sheet 1: generic unshielded 8-position jack, 15.24 mm wide × 11.50 mm high; 1.02 mm mating pitch per IEC 60603-7. Original drawing with inferred mouth, spring-contact and latch clearance detail; not manufacturer CAD or a PCB footprint. Original WireHub drawing, CC0-1.0."
    }
  },
  "pinAnchors": {
    "1": {
      "x": 5.43,
      "y": 5
    },
    "2": {
      "x": 6.45,
      "y": 5
    },
    "3": {
      "x": 7.47,
      "y": 5
    },
    "4": {
      "x": 8.49,
      "y": 5
    },
    "5": {
      "x": 9.51,
      "y": 5
    },
    "6": {
      "x": 10.53,
      "y": 5
    },
    "7": {
      "x": 11.55,
      "y": 5
    },
    "8": {
      "x": 12.57,
      "y": 5
    }
  },
  "anchorFrame": "mating-face",
  "src": "Molex SD-95501-001 revision F1, sheet 1: generic unshielded 8-position jack, 15.24 mm wide × 11.50 mm high; 1.02 mm mating pitch per IEC 60603-7. Original drawing with inferred mouth, spring-contact and latch clearance detail; not manufacturer CAD or a PCB footprint. Original WireHub drawing, CC0-1.0.",
  "license": "CC0-1.0",
  "provenance": {
    "method": "derived",
    "sources": [
      {
        "title": "Molex SD-95501-001 revision F1, sheet 1: generic unshielded 8-position jack, 15.24 mm wide × 11.50 mm high; 1.02 mm mating pitch per IEC 60603-7. Original drawing with inferred mouth, spring-contact and latch clearance detail; not manufacturer CAD or a PCB footprint. Original WireHub drawing, CC0-1.0.",
        "url": "https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/salesdrawingpdf/955/95501/955012882_sd.pdf",
        "retrieved": "2026-10-10"
      }
    ]
  }
}, null, 2) + '\n',
    "modules/networking/pack/depictions/rj45-8p8c-plug/mating-face.svg": `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 18" width="14mm" height="18mm">
  <title>RJ45 (8P8C) plug — mating face</title>
  <desc>Original generic illustration; dimensions and inferred details cited in meta.json. Not manufacturer CAD.</desc>
  <g stroke="currentColor" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.16" y="2" width="11.68" height="8.1" rx="0.45" fill="currentColor" fill-opacity="0.06"/>
    <path d="M5.5 10.1 L5.5 14 L8.5 14 L8.5 10.1 M4.75 12.4 H9.25 V13.1 H4.75 Z" fill="none"/>
    <path d="M1.7 8.9 H12.3 M2 2.8 H12" fill="none" opacity="0.5"/>
    <rect data-pin="1" x="3.19" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="2" x="4.21" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="3" x="5.23" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="4" x="6.25" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="5" x="7.27" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="6" x="8.29" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="7" x="9.31" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <rect data-pin="8" x="10.33" y="4" width="0.48" height="2" rx="0.08" fill="#b88b32"/>
    <text x="3.43" y="1.3" font-size="1.3" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">1</text>
    <text x="10.57" y="1.3" font-size="1.3" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">8</text>
  </g>
</svg>
`,
    "modules/networking/pack/depictions/rj45-8p8c-plug/meta.json": JSON.stringify({
  "defId": "rj45-8p8c-plug",
  "views": {
    "mating-face": {
      "file": "mating-face.svg",
      "kind": "vector",
      "mmPerUnit": 1,
      "sourceKind": "hand",
      "widthUnits": 14,
      "heightUnits": 18,
      "src": "IEC 60603-7 modular plug: 11.68 mm width and 1.02 mm contact pitch. Original generic 8.1 mm-high mating-face illustration, latch down; moulded edge breaks and latch detail inferred, not traced from a vendor drawing. Optional shield attachment anchor is illustrative. Original WireHub drawing, CC0-1.0."
    },
    "solder-side": {
      "file": "solder-side.svg",
      "kind": "vector",
      "mmPerUnit": 1,
      "sourceKind": "hand",
      "widthUnits": 14,
      "heightUnits": 18,
      "src": "Generic rear wire-entry view of an insulation-piercing RJ45 plug, not solder cups. Eight conductor guides project at 1.02 mm pitch, numbers mirrored from the mating face; latch and entry shape inferred. IEC 60603-7; Molex ATS-690081124 revision E. Original WireHub drawing, CC0-1.0.",
      "mirrorOf": "mating-face",
      "mirrorAxis": "x"
    }
  },
  "pinAnchors": {
    "1": {
      "x": 3.43,
      "y": 5
    },
    "2": {
      "x": 4.45,
      "y": 5
    },
    "3": {
      "x": 5.47,
      "y": 5
    },
    "4": {
      "x": 6.49,
      "y": 5
    },
    "5": {
      "x": 7.51,
      "y": 5
    },
    "6": {
      "x": 8.53,
      "y": 5
    },
    "7": {
      "x": 9.55,
      "y": 5
    },
    "8": {
      "x": 10.57,
      "y": 5
    },
    "shell": {
      "x": 7,
      "y": 14.8
    }
  },
  "anchorFrame": "mating-face",
  "src": "IEC 60603-7 modular plug: 11.68 mm width and 1.02 mm contact pitch. Original generic 8.1 mm-high mating-face illustration, latch down; moulded edge breaks and latch detail inferred, not traced from a vendor drawing. Optional shield attachment anchor is illustrative. Original WireHub drawing, CC0-1.0.",
  "license": "CC0-1.0",
  "provenance": {
    "method": "derived",
    "sources": [
      {
        "title": "IEC 60603-7 modular plug: 11.68 mm width and 1.02 mm contact pitch. Original generic 8.1 mm-high mating-face illustration, latch down; moulded edge breaks and latch detail inferred, not traced from a vendor drawing. Optional shield attachment anchor is illustrative. Original WireHub drawing, CC0-1.0.",
        "url": "https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/applicationtoolingspecificationpdf/690/69008/ATS-690081124-001.pdf",
        "retrieved": "2026-10-10"
      }
    ]
  }
}, null, 2) + '\n',
    "modules/networking/pack/depictions/rj45-8p8c-plug/solder-side.svg": `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 14 18" width="14mm" height="18mm">
  <title>RJ45 (8P8C) plug — rear wire entry</title>
  <desc>Original generic illustration; dimensions and inferred details cited in meta.json. Not manufacturer CAD.</desc>
  <g stroke="currentColor" stroke-width="0.15" stroke-linecap="round" stroke-linejoin="round">
    <rect x="1.16" y="2" width="11.68" height="8.1" rx="0.45" fill="currentColor" fill-opacity="0.06"/>
    <rect x="2.05" y="3" width="9.9" height="5.7" rx="0.7" fill="none"/>
    <path d="M5.5 10.1 L5.5 14 L8.5 14 L8.5 10.1" fill="none"/>
    <circle data-pin="1" cx="10.57" cy="5" r="0.35" fill="none"/>
    <circle data-pin="2" cx="9.55" cy="5" r="0.35" fill="none"/>
    <circle data-pin="3" cx="8.53" cy="5" r="0.35" fill="none"/>
    <circle data-pin="4" cx="7.51" cy="5" r="0.35" fill="none"/>
    <circle data-pin="5" cx="6.49" cy="5" r="0.35" fill="none"/>
    <circle data-pin="6" cx="5.47" cy="5" r="0.35" fill="none"/>
    <circle data-pin="7" cx="4.45" cy="5" r="0.35" fill="none"/>
    <circle data-pin="8" cx="3.43" cy="5" r="0.35" fill="none"/>
    <text x="10.57" y="1.3" font-size="1.3" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">1</text>
    <text x="3.43" y="1.3" font-size="1.3" text-anchor="middle" fill="currentColor" stroke="none" font-family="sans-serif">8</text>
  </g>
</svg>
`,
  };
}
