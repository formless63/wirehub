import { expect, test } from 'vitest';
import { applyBoardTexture } from '../server/models/board-texture.ts';
import type { MeshPart } from '../server/models/mesh.ts';
import { assemble, IDENTITY, translation } from '../server/models/assembly.ts';
const art = { top: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="red"/></svg>', bottom: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="blue"/></svg>' };
function groups(): MeshPart[] {
  const positions = new Float32Array([0,0,0,2,0,0,2,2,0,0,2,0,0,0,1,2,0,1,2,2,1,0,2,1]);
  return [[4,5,6,4,6,7],[0,2,1,0,3,2],[0,1,5,0,5,4,1,2,6,1,6,5,2,3,7,2,7,6,3,0,4,3,4,7]].map((indices,at)=>({
    name:`Synthetic_PCB#${at+1}`,readerMeshId:'occt-mesh:0',sourceProductName:'Synthetic_PCB',sourceOccurrenceName:'Synthetic instance',sourceAssemblyPath:'/1/',
    positions,indices:Uint32Array.from(indices),color:[at/3,.2,.3] as [number,number,number],
  }));
}
function triangles(parts: readonly MeshPart[]): string[] {
  return parts.flatMap(part=>Array.from({length:part.indices.length/3},(_,t)=>Array.from(part.indices.slice(t*3,t*3+3),v=>Array.from(part.positions.slice(v*3,v*3+3))).flat()).map(v=>JSON.stringify(v))).sort();
}
test('one reader board split by colors gets both artwork views and retains every source triangle',async()=>{
  const source=groups();const before=triangles(source);
  const painted=await applyBoardTexture(source,art,'occurrence');
  expect(triangles(painted)).toEqual(before);
  expect(painted.filter(p=>p.image!==undefined)).toHaveLength(2);
  expect(painted.filter(p=>p.image!==undefined).every(p=>p.uv!==undefined&&p.readerMeshId==='occt-mesh:0')).toBe(true);
  const top=painted.find(p=>p.name.endsWith('-top'))!;
  const bottom=painted.find(p=>p.name.endsWith('-bottom'))!;
  for(const part of [top,bottom]) for(const index of part.indices){
    const x=part.positions[index*3]!/2,y=part.positions[index*3+1]!/2;
    expect(part.uv![index*2]).toBeCloseTo(part===top?x:1-x,6);
    expect(part.uv![index*2+1]).toBeCloseTo(1-y,6);
  }
  expect(source.every(p=>p.image===undefined)).toBe(true);
  expect(triangles(source)).toEqual(before);
});
test('same product and ancestry cannot join distinct reader bodies or missing identities',async()=>{
  const first=groups();
  const second=groups().map(p=>({...p,readerMeshId:'occt-mesh:1'}));
  for(const parts of [[...first,...second],first.map(p=>({...p,readerMeshId:undefined})),first.map((p,at)=>({...p,sourceProductName:at===1?'Other_PCB':p.sourceProductName}))]){
    const result=await applyBoardTexture(parts,art,'occurrence');
    expect(result).toEqual(parts);
    expect(result.every(p=>p.image===undefined)).toBe(true);
  }
});
test('placed copies of the same reader board retain separate internal identities',async()=>{
  const parts=assemble({instances:[{model:0,matrix:IDENTITY},{model:0,matrix:translation(5,0,0)}]},[groups()]);
  expect(new Set(parts.map(p=>p.readerMeshId)).size).toBe(2);
  expect(await applyBoardTexture(parts,art,'occurrence')).toEqual(parts);
});
test('appearance keeps differing source opacity groups without flattening their geometry or alpha',async()=>{
  const source=groups().map((p,i)=>({...p,alpha:i===0?.4:1}));
  const result=await applyBoardTexture(source,art,'appearance');
  expect(result).toEqual(source);expect(triangles(result)).toEqual(triangles(source));
  const uniform=groups().map(p=>({...p,alpha:.4}));
  const painted=await applyBoardTexture(uniform,art,'appearance');
  expect(triangles(painted)).toEqual(triangles(uniform));
  expect(painted.filter(p=>p.image!==undefined)).toHaveLength(2);
  expect(painted.every(p=>p.alpha===.4)).toBe(true);
});
