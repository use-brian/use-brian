import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { parseArguments, readToken, checkReadiness, validateReport } from '../native-computer-readiness.mjs'
const id='00000000-0000-4000-8000-000000000000'
const args=['--non-production','--api','https://test.example','--token-file','-',...['workspace','assistant','conversation','task'].flatMap(k=>[`--${k}-id`,id]),'--device-id','qa-device']
const report={protocol:'native-computer-v1',ready:false,blockers:['runtime_not_checked'],warnings:['live_model_unverified']}
test('requires explicit destination, nonproduction acknowledgement and exact context',()=>{
 assert.equal(parseArguments(args).endpoint.href,'https://test.example/api/native-computer/readiness')
 for(const bad of [args.slice(1),[...args,'--token','secret'],[...args,'--api','https://other.example']]) assert.throws(()=>parseArguments(bad))
 for(const url of ['http://remote.example','https://user:secret@test.example','https://test.example?token=secret','https://test.example/#fragment','https://test.example/path']) {
  const bad=[...args];bad[2]=url;assert.throws(()=>parseArguments(bad))
 }
})
test('protected file only; rejects symlink, loose modes, oversized and malformed credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-readiness-'))
 try {
  const file=join(dir,'token');await writeFile(file,'synthetic.token\n',{mode:0o600})
  assert.equal(await readToken(file),'synthetic.token')
  await symlink(file,join(dir,'link'));await assert.rejects(readToken(join(dir,'link')))
  await chmod(file,0o644);await assert.rejects(readToken(file));await chmod(file,0o600)
  for(const value of ['x'.repeat(8193),'token\nheader: injected','']) { await writeFile(file,value);await assert.rejects(readToken(file)) }
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('stdin bounded and no echoed terminal credentials',async()=>{
 assert.equal(await readToken('-',Readable.from(['synthetic.token\n'])),'synthetic.token')
 await assert.rejects(readToken('-',Readable.from(['x'.repeat(8193)])))
 const stream=Readable.from(['token']);stream.isTTY=true;await assert.rejects(readToken('-',stream))
})
test('uses one nonredirecting bounded metadata request and never returns arbitrary content',async()=>{
 let calls=0
 const result=await checkReadiness(parseArguments(args),'synthetic.token',async(url,options)=>{
  calls++;assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.ok(options.signal instanceof AbortSignal)
  assert.equal(options.headers.authorization,'Bearer synthetic.token');assert.equal(JSON.parse(options.body).deviceId,'qa-device')
  return new Response(JSON.stringify(report))
 })
 assert.deepEqual(result,report);assert.equal(calls,1)
 for(const response of [new Response('secret',{status:401}),new Response('x'.repeat(8193)),new Response(JSON.stringify({...report,secret:'private'})),new Response(JSON.stringify({...report,blockers:['private']}))]) {
  await assert.rejects(checkReadiness(parseArguments(args),'synthetic.token',async()=>response))
 }
 assert.throws(()=>validateReport({...report,ready:true}))
})
test('CLI failure output never includes credentials, URL or provider error',async(t)=>{
 const { main }=await import('../native-computer-readiness.mjs')
 const dir=await mkdtemp(join(tmpdir(),'native-readiness-'))
 try {
  const file=join(dir,'token');await writeFile(file,'synthetic.secret',{mode:0o600})
  const input=[...args];input[4]=file
  const output=[]
  t.mock.method(console,'error',message=>output.push(message))
  t.mock.method(console,'log',message=>output.push(message))
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('synthetic.secret https://test.example provider-content')})
  assert.equal(await main(input),1)
  assert.equal(output.length,1)
  assert.doesNotMatch(output[0],/synthetic\.secret|test\.example|provider-content/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('stdin timeout closes a stalled input without echoing it',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const stream=new Readable({read(){}})
 const pending=assert.rejects(readToken('-',stream))
 t.mock.timers.tick(5000)
 await pending
 assert.equal(stream.destroyed,true)
})

test('accepts bounded precise image/adapter warnings but not identifiers or legacy default-budget claims',()=>{
 const value={...report, warnings:['jwt_compatibility_unverified','live_model_unverified','mac_verification_pending',
  'vision_image_unsupported','vision_approval_mismatch','vision_budget_insufficient','native_strict_adapter_unverified']}
 assert.deepEqual(validateReport(value),value)
 for(const warning of ['vision_default_budget_insufficient','https://private-provider.example','model:gpt-5.2']) {
  assert.throws(()=>validateReport({...report,warnings:[warning]}))
 }
 assert.throws(()=>validateReport({...report,warnings:Array(9).fill('live_model_unverified')}))
})
