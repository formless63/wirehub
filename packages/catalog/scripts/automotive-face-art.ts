/** Original colored diagnostic and synthetic sealed connector face/rear artwork. */
type Anchors = Record<string, { x: number; y: number }>;

export function automotiveFaceArtFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const xml = (title: string, w: number, h: number, inside: string): string => `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}mm" height="${h}mm">\n  <title>${title}</title>\n  <desc>Original WireHub illustration, CC0-1.0; geometry and colors approximate, not manufacturer CAD.</desc>\n${inside}\n</svg>\n`;
  function depiction(id: string, w: number, h: number, anchors: Anchors, face: string, rear: string, src: string): void {
   const dir = `modules/automotive/pack/depictions/${id}`;
   out[`${dir}/mating-face.svg`] = xml(`${id} — mating face`,w,h,face);
   out[`${dir}/solder-side.svg`] = xml(`${id} — rear termination side`,w,h,rear);
   out[`${dir}/meta.json`] = JSON.stringify({defId:id,views:{'mating-face':{file:'mating-face.svg',kind:'vector',mmPerUnit:1,sourceKind:'hand',widthUnits:w,heightUnits:h,src},'solder-side':{file:'solder-side.svg',kind:'vector',mmPerUnit:1,sourceKind:'hand',widthUnits:w,heightUnits:h,src,mirrorOf:'mating-face',mirrorAxis:'x'}},pinAnchors:anchors,anchorFrame:'mating-face',src,license:'CC0-1.0',provenance:{method:'derived',sources:[{title:src}]}}, null, 2) + '\n';
  }
  for (const gender of ['male', 'female']) {
   const w = 40;
   const h = 18;
   const id = `obd2-16-${gender}`;
   const anchors: Anchors = {};
   for(let i=1;i<=16;i++) anchors[i]={x:gender==='male'?34-((i-1)%8)*4:6+((i-1)%8)*4,y:i<=8?5.8:10.2};
   const contact = ([pin,{x,y}]: [string, {x:number; y:number}],rear=false)=> `    <rect data-pin="${pin}" x="${x-1.05}" y="${y-1.2}" width="2.1" height="2.4" rx="0.3" fill="#111318" stroke="#9a9da3" stroke-width="0.2"/>\n    <rect x="${x-(gender === 'male' && !rear ? 0.38 : 0.7)}" y="${y-.85}" width="${gender === 'male' && !rear ? 0.76 : 0.3}" height="1.7" rx="0.12" fill="#cbd0d7"/>\n    <text x="${x}" y="${y+(iRow(pin)?-1.55:2.55)}" font-size="1.2" text-anchor="middle" fill="#e5e7eb" font-family="sans-serif">${pin}</text>`;
   const outline = '    <path d="M2 2 Q2 1.5 2.7 1.5 H37.3 Q38 1.5 38 2 L34.5 13.8 Q34.3 14.5 33.6 14.5 H6.4 Q5.7 14.5 5.5 13.8 Z" fill="#262a30" stroke="#8d929c" stroke-width="0.28"/>\n    <path d="M3.7 3 H36.3 L33.4 13 H6.6 Z" fill="#15171c" stroke="#6c737d" stroke-width="0.2"/>';
   const face = outline+'\n'+Object.entries(anchors).map(entry=>contact(entry)).join('\n');
   const rear = outline+'\n'+Object.entries(anchors).map(([pin,pos])=>contact([pin,{x:w-pos.x,y:pos.y}],true)).join('\n');
   const src = 'Original WireHub SAE J1962 type-A illustration: vehicle receptacle 1–8 above 9–16 left-to-right, mating plug mirrored; rear view mirrors the pin anchors. Trapezoid, terminal proportions and display colors approximate/inferred, not a manufacturer drawing; CC0-1.0.';
   depiction(id,w,h,anchors,face,rear,src);
  }
  function iRow(pin: string): boolean { return Number(pin) <= 8; }
  for (const gender of ['male', 'female']) {
   const id = `sealed-3-${gender}`;
   const w = 24;
   const h = 17;
   const anchors: Anchors = {};
   for(let i=1;i<=3;i++) anchors[i]={x:gender==='male'?18-(i-1)*6:6+(i-1)*6,y:8.5};
   const frame = '    <rect x="1" y="2" width="22" height="13" rx="2.4" fill="#54595d" stroke="#b4b8bb" stroke-width="0.28"/>\n    <path d="M8 2 V0.7 H16 V2" fill="#6b7176" stroke="#a4aaaf" stroke-width="0.3"/>';
   const pins = (rear: boolean): string => Object.entries(anchors).map(([pin,pos])=>{const x=rear?w-pos.x:pos.x;const y=pos.y;return `    <circle data-pin="${pin}" cx="${x}" cy="${y}" r="2" fill="${rear?'#a74d34':'#111318'}" stroke="${rear?'#dc8064':'#7f858b'}" stroke-width="0.6"/>\n    <circle cx="${x}" cy="${y}" r="${gender === 'male' && !rear ? 0.8 : 1.25}" fill="${rear?'#111318':gender==='male'?'#c3c8ce':'#25282b'}" stroke="#c3c8ce" stroke-width="0.22"/>\n    <text x="${x}" y="13.5" font-size="1.7" text-anchor="middle" fill="#f1f2f4" font-family="sans-serif">${pin}</text>`;}).join('\n');
   const src = 'Original generic sealed 3-way mating/rear illustration; synthetic example, 24 × 17 mm frame, 6 mm cavity spacing and colors inferred. Male mating face mirrors female, rear pins mirror the mating anchors. Not a manufacturer product or dimensional drawing; CC0-1.0.';
   depiction(id,w,h,anchors,frame+'\n'+pins(false),frame+'\n'+pins(true),src);
  }

  return out;
}
