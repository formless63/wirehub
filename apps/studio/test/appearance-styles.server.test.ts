import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appearanceFactory } from '../server/models/appearance-reader.ts';
import { occurrenceFactory } from '../server/models/occurrence-reader.ts';
import { readStep } from '../server/models/step.ts';
import { convertModel } from '../server/models/convert.ts';
import { readGlbJson, writeGlb } from '../server/models/glb.ts';
import { assemble, IDENTITY, translation } from '../server/models/assembly.ts';
import { sourceKey } from '../server/models/cache.ts';
import { buildProfileOf } from '../server/models/build.ts';
import { configuredModelProfile, assertModelProfileAvailable, reprofileModelLink } from '../server/models/profile.ts';
const fixture = (name:string) => new Uint8Array(readFileSync(new URL(`./fixtures/step-styles/${name}.step`,import.meta.url)));
const dir=process.env['WIREHUB_OCCT_APPEARANCE_DIR'];
const oldDir=process.env['WIREHUB_OCCT_STYLES_DIR'];
interface RawMesh { attributes: unknown; index: unknown; alpha?:number; color?:number[]; brep_faces: {first:number;last:number;alpha?:number;color:number[]|null}[] }
interface Reader {ReadStepFile(bytes:Uint8Array,options:object):{success:boolean;meshes:RawMesh[]}}
const params={linearUnit:'millimeter',linearDeflectionType:'bounding_box_ratio',linearDeflection:.001,angularDeflection:.5};
const shape=(m:RawMesh)=>({attributes:m.attributes,index:m.index,faces:m.brep_faces.map(f=>({first:f.first,last:f.last}))});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
it('selects profiles explicitly and refuses bad configuration/artifacts without silently falling back',()=>{
 expect(configuredModelProfile({})).toBe('exporter');
 expect(configuredModelProfile({WIREHUB_MODEL_PROFILE:''})).toBe('exporter');
 expect(configuredModelProfile({WIREHUB_MODEL_PROFILE:'appearance'})).toBe('appearance');
 expect(()=>configuredModelProfile({WIREHUB_MODEL_PROFILE:'unknown'})).toThrow(/unsupported/);
 expect(()=>assertModelProfileAvailable('appearance',{})).toThrow(/unavailable/);
 expect(()=>appearanceFactory('/does-not-exist')).toThrow(/pinned manifest/);
});
it('preserves source recipe and old keys when preparing a separate profile upgrade',()=>{
 const files=[{path:'synthetic/board.kicad_pcb',sha256:'a'.repeat(64)}];
 const build={kind:'embedded' as const,name:'synthetic.step'};
 const link={record:'pcbas/synthetic',files,build,asset:sourceKey(files,150000,build),src:'synthetic example',sourceKind:'kicad-board' as const};
 const next=reprofileModelLink(link,'appearance');
 expect(next.asset).not.toBe(link.asset); expect(next.files).toBe(link.files); expect(next.build).toBe(link.build);
 expect(buildProfileOf(link)?.boardTextureProfile).toBe('exporter'); expect(buildProfileOf(next)?.boardTextureProfile).toBe('appearance');
 expect(()=>reprofileModelLink({...link,files:undefined},'appearance')).toThrow(/source recipe/);
});
it('writes supplied alpha including zero and rejects invalid opacity without inventing a finish',()=>{
 const part={name:'synthetic',positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2]),color:[.2,.4,.6] as [number,number,number]};
 for(const alpha of [0,.4,1]){
 const material=(readGlbJson(writeGlb([{...part,alpha}]))!['materials'] as {alphaMode?:string;pbrMetallicRoughness:{baseColorFactor:number[];metallicFactor:number;roughnessFactor:number}}[])[0]!;
 expect(material.pbrMetallicRoughness.baseColorFactor).toEqual([.2,.4,.6,alpha]);
 expect(material.alphaMode).toBe(alpha<1?'BLEND':undefined);
 expect(material.pbrMetallicRoughness.metallicFactor).toBe(0);expect(material.pbrMetallicRoughness.roughnessFactor).toBe(.7);
 }
 for(const alpha of [NaN,Infinity,-.1,1.1])expect(()=>writeGlb([{...part,alpha}])).toThrow(/opacity/);
});
it('retains supplied opacity through placed assembly transforms and refuses merging unequal alpha',()=>{
 const base={name:'synthetic',positions:new Float32Array([0,0,0,1,0,0,0,1,0]),indices:new Uint32Array([0,1,2]),color:[.2,.4,.6] as [number,number,number]};
 const plan={instances:[{model:0,matrix:IDENTITY},{model:1,matrix:translation(5,0,0)}]};
 const parts=assemble(plan,[[{...base,alpha:.25}],[{...base,alpha:.75}]]);
 expect(parts).toHaveLength(2);expect(parts.map(p=>p.alpha).sort()).toEqual([.25,.75]);
 expect(parts.reduce((n,p)=>n+p.indices.length,0)).toBe(6);
});
describe.skipIf(!dir || !oldDir)('pinned source RGBA reader',()=>{
 it('retains exact raw geometry and RGB while recovering occurrence/face opacity',async()=>{
 const old=await occurrenceFactory(oldDir!)() as Reader,next=await appearanceFactory(dir!)() as Reader;
 for(const name of ['occurrence-alpha','product-alpha','nested-location-colors','named-board-coatings']){
 const before=old.ReadStepFile(fixture(name),params),after=next.ReadStepFile(fixture(name),params);
 expect(before.success&&after.success).toBe(true);expect(after.meshes.map(shape)).toEqual(before.meshes.map(shape));
 expect(after.meshes.map(m=>m.color)).toEqual(before.meshes.map(m=>m.color));
 expect(after.meshes.map(m=>m.brep_faces.map(f=>f.color))).toEqual(before.meshes.map(m=>m.brep_faces.map(f=>f.color)));
 }
 const product=next.ReadStepFile(fixture('product-alpha'),params).meshes[0]!;
 expect(product.alpha).toBeCloseTo(.4,6);expect(product.brep_faces.every(f=>Math.abs(f.alpha!-.4)<.000001)).toBe(true);
 const meshes=next.ReadStepFile(fixture('occurrence-alpha'),params).meshes;
 expect(meshes.map(m=>m.alpha)).toEqual([.25,.75]);
 expect(meshes.every(m=>m.brep_faces[0]!.alpha===0&&m.brep_faces.slice(1).every(f=>f.alpha===m.alpha))).toBe(true);
 });
 it('splits identical-RGB faces by source alpha and embeds actual BLEND materials through the child',async()=>{
 const bytes=fixture('occurrence-alpha'),parts=await readStep(bytes,.001,false,'appearance');
 expect(parts).toHaveLength(4);expect(new Set(parts.map(p=>p.alpha))).toEqual(new Set([0,.25,.75]));
 const next=await convertModel(bytes,'synthetic.step',{boardTextureProfile:'appearance',maxTriangles:150000});
 const json=readGlbJson(next.glb)!;
 const mats=json['materials'] as {alphaMode:string;pbrMetallicRoughness:{baseColorFactor:number[]}}[];
 expect(mats).toHaveLength(4);expect(mats.every(m=>m.alphaMode==='BLEND')).toBe(true);
 expect(mats.map(m=>m.pbrMetallicRoughness.baseColorFactor[3]).sort()).toEqual([0,0,.25,.75]);
 },30000);
 it('does not change legacy cold bytes when both artifact directories are mounted',async()=>{
 const old=await convertModel(fixture('nested-location-colors'),'synthetic.step',{maxTriangles:150000,boardTextureProfile:'legacy'});
 expect(hash(old.glb)).toBe('f408e38efb3f087aef841ee58dee29f6c51f9cc7842a37bf7ac234f1dc96e508');
 const bytes=fixture('occurrence-alpha');
 const before=await convertModel(bytes,'synthetic.step',{maxTriangles:150000,boardTextureProfile:'occurrence'});
 const again=await convertModel(bytes,'synthetic.step',{maxTriangles:150000,boardTextureProfile:'occurrence'});
 expect(again.glb).toEqual(before.glb);
 expect(hash(before.glb)).toBe('e9f60c51506e581eddee5ee6d63a8c729ffe21a8b6f4063c693133878cc57a1d');
 expect((readGlbJson(before.glb)!['materials'] as {pbrMetallicRoughness:{baseColorFactor:number[]}}[]).every(m=>m.pbrMetallicRoughness.baseColorFactor[3]===1)).toBe(true);
 },30000);
});
