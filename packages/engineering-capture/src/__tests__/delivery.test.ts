import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,it,expect,vi} from 'vitest'
import {CollectorConfigSchema} from '../setup.js'
import {CaptureSpool} from '../spool.js'
import {flushCapture,type CaptureTransport} from '../delivery.js'
const dirs:string[]=[]
function fixture(){const dir=mkdtempSync(join(tmpdir(),'engineering-delivery-'));dirs.push(dir);const config=CollectorConfigSchema.parse({version:1,provider:'codex',endpoint:'http://127.0.0.1:4100/api/brain/mcp',credentialEnv:'BRAIN_CAPTURE_FIXTURE_KEY',project:'/workspace/example-project',stateRoot:dir});const spool=new CaptureSpool(config);spool.enqueue({provider:'codex',sessionId:'fictional-session',cwd:'/workspace/example-project',role:'user',content:'original',attributionQuality:'reported_unverified'});return {config,spool}}
const configReceipt={connectionId:'fixture-connection',contractVersion:1,receiptContractVersion:1,ready:true,processingPurpose:'archive_only',profileId:'11111111-1111-4111-8111-111111111111',profileRevision:'1',permittedEventKinds:['user','assistant'],audience:[{kind:'department',id:'fixture',label:'Engineering'}],limits:{maxEventBytes:262144,maxExportEvents:100},localEmitterObserved:false}
const archiveReceipt={contractVersion:1,processingPurpose:'archive_only',outcome:'archived',receiptStatus:'completed',deliveryStatus:'archived',indexStatus:'ready',archiveId:'22222222-2222-4222-8222-222222222222',fileId:'22222222-2222-4222-8222-222222222222'}
const transport=(configuration:unknown=configReceipt,receipt:unknown=archiveReceipt):CaptureTransport=>({configuration:async()=>configuration,deliver:vi.fn(async()=>receipt),close:async()=>{}})
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
describe('[COMP:engineering-capture/collector] typed delivery and replay',()=>{
 it('EH12 offline failure retains original id; restart delivers only a typed archived receipt',async()=>{
  const f=fixture(),id=f.spool.next()!.id
  expect(await flushCapture(f.config,f.spool,async()=>{throw new Error('offline')})).toMatchObject({failureCode:'capture_transport_unavailable'})
  expect(f.spool.next(Number.MAX_SAFE_INTEGER)?.id).toBe(id);f.spool.resume()
  // Force a due retry without changing identity or text.
  f.spool.fail(id,'retry',true);f.spool.resume()
  expect(await flushCapture(f.config,f.spool,async()=>transport())).toMatchObject({delivered:1})
  expect(f.spool.next()).toBeNull();expect(f.spool.status()).toMatchObject({counts:{archived:1}});f.spool.close()
 })
 it.each([{...configReceipt,processingPurpose:'extract'},{...configReceipt,contractVersion:2},{...configReceipt,ready:false,failureCode:'capture_target_unavailable'}])('EH03/EH12 rejects incompatible configuration before any ingest call',async configuration=>{
  const f=fixture(),t=transport(configuration);expect((await flushCapture(f.config,f.spool,async()=>t)).suspended).toBe(true);expect(t.deliver).not.toHaveBeenCalled();expect(f.spool.status()).toMatchObject({counts:{failed:1}});f.spool.close()
 })
 it('EH08 rejects a prose success or incomplete archived receipt without deleting WIP',async()=>{
  const f=fixture();expect((await flushCapture(f.config,f.spool,async()=>transport(configReceipt,'success'))).suspended).toBe(true);expect(f.spool.status()).toMatchObject({counts:{failed:1}});f.spool.close()
 })
 it('EH12 keeps queued acknowledgement pending rather than counting it as archived',async()=>{
  const f=fixture();await flushCapture(f.config,f.spool,async()=>transport(configReceipt,{...archiveReceipt,outcome:'duplicate',receiptStatus:'queued',deliveryStatus:'pending',indexStatus:'pending'}))
  expect(f.spool.status()).toMatchObject({counts:{pending:1}});expect(f.spool.next(Number.MAX_SAFE_INTEGER)?.payload.content).toBe('original');f.spool.close()
 })
 it('EH12 permanent HTTP authentication denial suspends without logging provider text',async()=>{
  const f=fixture();expect(await flushCapture(f.config,f.spool,async()=>{throw Object.assign(new Error('secret provider text'),{code:401})})).toMatchObject({suspended:true});expect(JSON.stringify(f.spool.status())).not.toContain('secret provider text');f.spool.close()
 })
})
