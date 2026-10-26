import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { scaffold, scaffoldFiles } from '../scaffold.js'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), require=createRequire(import.meta.url)
let temporary:string
const evidence:Record<string,unknown>={generated:{}}
const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex')
const tool=(name:string)=>require.resolve(name)
const run=(command:string,args:string[],cwd=temporary)=>execFileSync(command,args,{cwd,encoding:'utf8',stdio:'pipe',env:{...process.env,NO_COLOR:'1'}})
beforeAll(()=>{
  temporary=mkdtempSync(join(realpathSync(tmpdir()),'brian-sdk-packed-'))
  run(process.execPath,[tool('typescript/bin/tsc'),'-p',join(root,'tsconfig.json')])
  run('pnpm',['pack','--out',join(temporary,'kit.tgz')],root)
  for(const [name,path]of [['brian-app',root],['shared',resolve(root,'../shared')],['core',resolve(root,'../core')]]){
    const destination=join(temporary,'node_modules/@use-brian',name);mkdirSync(destination,{recursive:true})
    const archive=join(temporary,`${name}.tgz`)
    if(name!=='brian-app')run('pnpm',['pack','--out',archive],path)
    run('tar',['-xzf',name==='brian-app'?join(temporary,'kit.tgz'):archive,'--strip-components=1','-C',destination])
  }
  mkdirSync(join(temporary,'node_modules/@types'),{recursive:true})
  symlinkSync(dirname(tool('@types/node/package.json')),join(temporary,'node_modules/@types/node'))
  // Only installed third-party tooling/types. All Brian code is unpacked from local tarballs.
  symlinkSync(dirname(createRequire(resolve(root,'../shared/package.json')).resolve('zod/package.json')),join(temporary,'node_modules/zod'))
  writeFileSync(join(temporary,'package.json'),JSON.stringify({type:'module'}))
  writeFileSync(join(temporary,'native-schema.mjs'),`import assert from 'node:assert/strict';
import {createNativeSchemaPorts} from '@use-brian/brian-app/module';
import {createApplicationClient} from '@use-brian/brian-app/application';
const workspaceId='00000000-0000-4000-8000-000000000002',typeId='00000000-0000-4000-8000-000000000001';
const preview={id:typeId,entityTypeId:typeId,expectedSchemaVersion:1,before:[],proposed:[],affectedRecords:0,invalidRecords:0,canApply:true};
const calls=[];const schemas=createNativeSchemaPorts({apiOrigin:'https://brain.example',workspaceId,fetch:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return new Response(JSON.stringify(calls.length===1?preview:{entityTypeId:typeId,schemaVersion:2,applied:true}))}});
const client=createApplicationClient({appId:typeId,transport:async()=>{throw Error('app transport must not carry native authority')},schemas});
const review=await client.previewSchema({typeId,expectedVersion:1,properties:[]});assert.deepEqual(review,preview);
assert.deepEqual(await client.applySchema({previewId:review.id}),{entityTypeId:typeId,schemaVersion:2,applied:true});
assert.deepEqual(calls,[{url:'https://brain.example/api/applications/workspaces/'+workspaceId+'/schemas/'+typeId+'/preview',body:{expectedVersion:1,properties:[]}},{url:'https://brain.example/api/applications/workspaces/'+workspaceId+'/schema-reviews/'+typeId+'/apply',body:{}}]);
console.log(JSON.stringify({nativeSchemaRoutes:true,reviewPreserved:true,applicationTransportUsed:false}));`)
  evidence.nativeSchema=JSON.parse(run(process.execPath,['native-schema.mjs']))
  // Packing, compiling and running generated projects is fixture setup, outside per-assertion timing.
  for(const profile of ['native','connector'] as const){
    const directory=join(temporary,profile)
    run(process.execPath,[join(temporary,'node_modules/@use-brian/brian-app/bin/brian-app.js'),'scaffold','--profile',profile,directory])
    if(profile==='native')writeFileSync(join(directory,'src/query-example.ts'),`import type {ApplicationClient,ApplicationQueryResult,ApplicationSchemaPorts} from '@use-brian/brian-app/application';
export async function page(client:ApplicationClient):Promise<ApplicationQueryResult>{const result=await client.query('deal',{fields:['amount'],filters:[],sort:[],aggregate:[],limit:1});const amount:string|null|undefined=result.aggregates?.[0].value;const cursor:string|undefined=result.nextCursor;return {...result,records:result.records};}
export function preview(schemas:ApplicationSchemaPorts){return schemas.preview({typeId:'00000000-0000-4000-8000-000000000001',expectedVersion:1,properties:[]});}`)
    run('npm',['run','build'],directory)
    const contractOutput=run('npm',['run','contract'],directory)
    ;(evidence.generated as Record<string,unknown>)[profile]={compiled:true,contractOutput,files:Object.fromEntries(Object.keys(scaffoldFiles(profile)).map(path=>[path,digest(join(directory,path))]))}
    if(profile==='native'){
      const cli=join(temporary,'node_modules/@use-brian/brian-app/bin/brian-app.js')
      const generated=(evidence.generated as Record<string,Record<string,unknown>>)[profile]
      generated.typedConsumerSha256=digest(join(directory,'src/query-example.ts'))
      generated.lints=[run(process.execPath,[cli,directory]),run(process.execPath,[cli,'lint',directory])]
      // A real external type error must remain visible through packed canonical declarations.
      writeFileSync(join(directory,'src/invalid.ts'),`import type {ApplicationCommand} from '@use-brian/brian-app/application'; const command:ApplicationCommand={idempotencyKey:'x',expectedVersion:12,input:{}};`)
      try { run(process.execPath,[tool('typescript/bin/tsc'),'-p',join(directory,'tsconfig.json')]); generated.invalidTypeOutput='' }
      catch(error) { generated.invalidTypeOutput=String((error as {stdout?:unknown}).stdout) }
      rmSync(join(directory,'src/invalid.ts'))
    }
  }
},120000)
afterAll(()=>{
  if(temporary && process.env.BRIAN_SDK_CONFORMANCE_EVIDENCE){
    const path=process.env.BRIAN_SDK_CONFORMANCE_EVIDENCE
    mkdirSync(dirname(path),{recursive:true})
    writeFileSync(path,JSON.stringify({...evidence,packedSha256:digest(join(temporary,'kit.tgz')),exports:Object.keys(JSON.parse(readFileSync(join(temporary,'node_modules/@use-brian/brian-app/package.json'),'utf8')).exports)},null,2)+'\n')
  }
  if(temporary)rmSync(temporary,{recursive:true,force:true})
})
describe('[COMP:shared/brian-app-sdk] packed exports and scaffolds',()=>{
  it('K01 executes the packed browser graph without Node globals or server/runtime root imports',()=>{
    writeFileSync(join(temporary,'browser.mjs'),`import vm from 'node:vm';import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const graph=[];const context=vm.createContext({URL,URLSearchParams,TextEncoder,Uint8Array,AbortController,Response,crypto:webcrypto,btoa,setTimeout,clearTimeout,fetch:async()=>new Response(JSON.stringify({version:'opaque',fields:['title'],evidence:{source:'proof'}}))});
const cache=new Map();async function load(url){if(cache.has(url))return cache.get(url);const source=readFileSync(new URL(url),'utf8');graph.push(url);const m=new vm.SourceTextModule(source,{context,identifier:url});cache.set(url,m);await m.link(async(specifier,ref)=>{assert.ok(specifier.startsWith('./'),specifier);return load(new URL(specifier,ref.identifier).href)});return m}
const module=await load(import.meta.resolve('@use-brian/brian-app/application'));await module.evaluate();const sdk=module.namespace;
assert.equal(vm.runInContext('typeof process+typeof Buffer+typeof require+typeof localStorage',context),'undefinedundefinedundefinedundefined');
const client=sdk.createApplicationClient({appId:'00000000-0000-4000-8000-000000000001',transport:sdk.createFetchTransport({apiOrigin:'https://brain.example',credential:async()=>'oat_00000000-0000-4000-8000-000000000001_sssssssssssssssssssssssssssssssssssssssssss'})});
assert.equal((await client.catalog()).evidence.source,'proof');assert.equal((await sdk.createApplicationSignIn({apiOrigin:'https://brain.example',appId:'00000000-0000-4000-8000-000000000001',clientId:'public',redirectUri:'https://portal.example/callback'}).begin()).authorizationUrl.includes('code_challenge_method=S256'),true);
assert.ok(graph.every(path=>!path.includes('/core/')&&!path.includes('/shared/')&&!path.includes('/module.js')&&!path.includes('/connector.js')));console.log(JSON.stringify({graph,nodeGlobals:false}));`)
    const output=run(process.execPath,['--experimental-vm-modules','browser.mjs'])
    evidence.browserGraph=JSON.parse(output);expect(JSON.parse(output).graph.map((p:string)=>p.split('/').pop()).sort()).toEqual(['application.js','sign-in.js','transport.js'])
  })
  it.each(['native','connector']as const)('K05 compiles/runs %s outside the workspace using only packed public profiles',profile=>{
    const directory=join(temporary,profile)
    const generated=(evidence.generated as Record<string,Record<string,unknown>>)[profile]
    expect(generated.compiled).toBe(true)
    expect(generated.contractOutput).toContain('unconfigured boundary: unavailable')
    expect(readFileSync(join(directory,'src',profile==='native'?'module.ts':'source.ts'),'utf8')).toContain('@use-brian/brian-app/')
    if(profile==='native') {
      for(const output of generated.lints as string[])expect(output).toContain('Example application')
      expect(generated.invalidTypeOutput).toContain('TS2322')
    }
  })
  it('K02 executes native schema preview/apply through packed public profiles',()=>{
    expect(evidence.nativeSchema).toEqual({nativeSchemaRoutes:true,reviewPreserved:true,applicationTransportUsed:false})
  })
  it('K06 validates deterministic templates and refuses traversal, symlinks, unknown profiles and overwrites',()=>{
    expect(scaffoldFiles('native')).toEqual(scaffoldFiles('native'));expect(scaffoldFiles('connector')).toEqual(scaffoldFiles('connector'))
    expect(()=>scaffoldFiles('unknown'as never)).toThrow('Unknown scaffold profile')
    expect(()=>scaffold('native',`${temporary}/x/../escape`)).toThrow('Unsafe')
    const occupied=join(temporary,'occupied');mkdirSync(occupied);writeFileSync(join(occupied,'keep'),'existing')
    expect(()=>scaffold('native',occupied)).toThrow('empty');expect(readFileSync(join(occupied,'keep'),'utf8')).toBe('existing')
    const link=join(temporary,'link');symlinkSync(occupied,link);expect(()=>scaffold('connector',link)).toThrow('Unsafe')
    for(const profile of ['native','connector']as const){
      const directory=join(temporary,`${profile}-deterministic`);scaffold(profile,directory)
      for(const[path,body]of Object.entries(scaffoldFiles(profile)))expect(readFileSync(join(directory,path),'utf8')).toBe(body)
    }
  })
})
