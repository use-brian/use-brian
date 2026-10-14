import {mkdtempSync,rmSync,statSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,it,expect} from 'vitest'
import {CollectorConfigSchema} from '../setup.js'
import {CaptureSpool} from '../spool.js'
import type {SelectedEvent} from '../providers/types.js'
const dirs:string[]=[]
function fixture(options:Record<string,unknown>={}){const dir=mkdtempSync(join(tmpdir(),'engineering-spool-'));dirs.push(dir);const config=CollectorConfigSchema.parse({version:1,provider:'codex',endpoint:'http://127.0.0.1:4100/api/brain/mcp',credentialEnv:'BRAIN_CAPTURE_FIXTURE_KEY',project:'/workspace/example-project',stateRoot:join(dir,'state'),...options});return {dir,config}}
const event:SelectedEvent={provider:'codex',sessionId:'fictional-session',cwd:'/workspace/example-project',role:'user',content:'  exact\n工程 ☃\n',attributionQuality:'reported_unverified'}
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true})})
describe('[COMP:engineering-capture/collector] durable local identity and privacy',()=>{
 it('EH05/EH12 survives restart, preserves ordering and distinguishes repeated submissions without source ids',()=>{
  const f=fixture(),a=new CaptureSpool(f.config),id=a.enqueue(event),second=a.enqueue(event);expect(second).not.toBe(id);a.close()
  const b=new CaptureSpool(f.config);expect(b.next()).toMatchObject({id,payload:{content:event.content}});b.accept(id,{deliveryStatus:'archived',archiveId:'opaque'});expect(b.next()?.id).toBe(second);expect(b.status()).not.toHaveProperty('payload');b.close()
  expect(statSync(join(f.config.stateRoot,'spool.sqlite')).mode&0o777).toBe(0o600);expect(statSync(f.config.stateRoot).mode&0o777).toBe(0o700)
 })
 it('EH05 stable provider ids reconcile replay and conflict on changed selected payload',()=>{
  const f=fixture(),s=new CaptureSpool(f.config),e={...event,turnId:'turn',sourceIdentity:'turn:user'}
  expect(s.enqueue(e)).toBe(s.enqueue(e));expect(()=>s.enqueue({...e,content:'changed'})).toThrow('source_event_conflict');s.close()
 })
 it('EH12 leases are exclusive across processes/handles and expire after interrupted delivery',()=>{
  const f=fixture(),a=new CaptureSpool(f.config),b=new CaptureSpool(f.config)
  expect(a.acquireLease('one',1000)).toBe(true);expect(b.acquireLease('two',1001)).toBe(false);expect(b.acquireLease('two',31001)).toBe(true)
  a.releaseLease('one');expect(b.acquireLease('two',31002)).toBe(true);b.releaseLease('two');a.close();b.close()
 })
 it('EH12 bounds queue/payload, preserves WIP on failures and suspends permanent denial',()=>{
  const f=fixture({maxEvents:1}),s=new CaptureSpool(f.config),id=s.enqueue(event)
  expect(()=>s.enqueue(event)).toThrow('queue_limit_exceeded');s.fail(id,'capture_target_unavailable',true)
  expect(s.status()).toMatchObject({suspended:true,counts:{failed:1}});s.resume();expect(s.next()?.id).toBe(id);s.close()
 })
 it('EH13 refuses repository-local state and never copies a credential into status',()=>{
  const f=fixture(),repo=join(f.dir,'repository');mkdirSync(repo);mkdirSync(join(repo,'.git'))
  expect(()=>new CaptureSpool({...f.config,stateRoot:join(repo,'state')})).toThrow('spool_inside_repository')
  const s=new CaptureSpool(f.config);s.enqueue(event);expect(JSON.stringify(s.status())).not.toContain(event.content);s.close()
 })
})
