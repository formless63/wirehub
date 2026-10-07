import {readFileSync} from 'node:fs';
import {loadDb} from '@wirehub/catalog';
import {expect,it,describe,vi,afterEach} from 'vitest';
import {handleModelRequest,type ModelDeps} from '../server/models/api.ts';
import {memoryModelLinkStore} from '../server/models/links.ts';
import {memoryDocStore} from '../server/storage/doc-store.ts';
import {memoryAssetStore} from '../server/assets.ts';
import {buildProfileOf} from '../server/models/build.ts';
import {writeGlb} from '../server/models/glb.ts';
import {parseStl} from '../server/models/mesh.ts';
afterEach(()=>vi.unstubAllEnvs());
const deps=():ModelDeps=>({loadDb:()=>loadDb(),links:memoryModelLinkStore(),assets:memoryAssetStore(),docs:memoryDocStore(),profile:'appearance',who:'Synthetic user',today:()=> '2000-01-01'});
const upload=(name:string,data:Uint8Array)=>({method:'POST',path:'/api/models/pcbas/pair-terminal-board/upload',body:{name,data:Buffer.from(data).toString('base64')},ifMatch:'*'});
const board=new Uint8Array(readFileSync(new URL('./fixtures/models/kicad/board.kicad_pcb',import.meta.url)));
it('missing configured artifact refuses source/link writes, including deferred board builds',async()=>{
 vi.stubEnv('WIREHUB_OCCT_APPEARANCE_DIR','');
 const d=deps();const response=await handleModelRequest(upload('synthetic.kicad_pcb',board),d);
 expect(response.status).toBe(422);expect(await d.links!.list()).toEqual([]);
 expect((d.docs as ReturnType<typeof memoryDocStore>).docs.size).toBe(0);
});
describe.skipIf(!process.env['WIREHUB_OCCT_APPEARANCE_DIR'])('configured native appearance import',()=>{
 it('keys deferred board imports with explicit profile and original recipe',async()=>{
 const d=deps();const response=await handleModelRequest(upload('synthetic.kicad_pcb',board),d);
 expect(response.status).toBe(200);const link=(await d.links!.list())[0]!;
 expect(buildProfileOf(link)?.boardTextureProfile).toBe('appearance');expect(link.build?.kind).toBe('assembly');
 expect(link.files?.some(f=>f.path.endsWith('.kicad_pcb.txt'))).toBe(true);
 });
 it('forwards new upload profile while uploaded GLB remains a byte-preserving format',async()=>{
 const d=deps();const bytes=new Uint8Array(readFileSync(new URL('./fixtures/models/tetra.stl',import.meta.url)));
 const glb=writeGlb([{...parseStl(bytes,'synthetic'),color:[.2,.4,.6],alpha:.4}]);
 let profile:unknown;
 d.convert=async(input,name,options)=>{expect(input).toEqual(glb);expect(name).toBe('synthetic.glb');profile=options?.boardTextureProfile;return {glb:input,format:'glb',stats:{triangles:4,sourceTriangles:4,simplified:false,parts:1,glbBytes:input.length}};};
 expect((await handleModelRequest(upload('synthetic.glb',glb),d)).status).toBe(200);
 expect(profile).toBe('appearance');const link=(await d.links!.list())[0]!;
 expect((await d.assets!.get(link.asset))?.bytes).toEqual(Buffer.from(glb));
 });
});

it('invalid import configuration cannot block reads, and stale writes refuse before profile verification',async()=>{
 vi.stubEnv('WIREHUB_MODEL_PROFILE','unsupported');
 const d=deps();delete d.profile;
 expect((await handleModelRequest({method:'GET',path:'/api/models'},d)).status).toBe(200);
 const request=upload('synthetic.kicad_pcb',board);
 expect((await handleModelRequest({...request,ifMatch:'"stale"'},d)).status).toBe(409);
 expect((await handleModelRequest(request,d)).status).toBe(422);
 expect(await d.links!.list()).toEqual([]);
});
it('GLB pass-through retains all bytes when appearance is configured without a native artifact',async()=>{
 vi.stubEnv('WIREHUB_MODEL_PROFILE','appearance');vi.stubEnv('WIREHUB_OCCT_APPEARANCE_DIR','');
 const d=deps();delete d.profile;
 const bytes=new Uint8Array(readFileSync(new URL('./fixtures/models/tetra.stl',import.meta.url)));
 const glb=writeGlb([{...parseStl(bytes,'synthetic'),color:[.2,.4,.6],alpha:.4}]);
 expect((await handleModelRequest(upload('synthetic.glb',glb),d)).status).toBe(200);
 const link=(await d.links!.list())[0]!;expect((await d.assets!.get(link.asset))?.bytes).toEqual(Buffer.from(glb));
});
