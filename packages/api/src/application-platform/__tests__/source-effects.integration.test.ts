import {afterAll,describe,expect,it,vi} from 'vitest'
import {advanceWorkflowRun} from '@use-brian/core'
import {getPool,getAppPool} from '../../db/client.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
import {createDbWorkflowRunStore,createDbWorkflowStore} from '../../db/workflow-store.js'
import {resolveWorkflowRunScope} from '../../context-scope/workflow-authority.js'
import {buildWorkflowToolRegistry} from '../../workflow/mcp-bridge.js'
import {sourceServiceFixture,sourceServiceFixtureCleanups} from './fixtures/source-service.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/source-service-binding] retired host effect runtime',()=>{
 afterAll(async()=>{for(const cleanup of [...sourceServiceFixtureCleanups])await cleanup();await getAppPool().end();await getPool().end()})
 it('keeps passive command profile identity without exposing a sender, host reconciliation or ephemeral lane',async()=>{
  const f=await sourceServiceFixture({mutate:true})
  try{
   const {runtime}=await f.runtime()
   expect((await getPool().query('SELECT source_effect_binding FROM connector_source_profiles WHERE id=$1',[f.profile])).rows[0].source_effect_binding).toBe('command_v1')
   for(const key of ['effectBinding','effect','reconcile','ephemeral'])expect(Object.hasOwn(runtime,key)).toBe(false)
   expect(JSON.stringify(await runtime.read!('readRecord',{id:'order-1',fields:['description']}))).toContain('Fictional purchase')
   const reads=f.source.counters.reads
   await expect(runtime.read!('updateRecord',{id:'order-1',values:{cost:'99'}})).rejects.toBeDefined()
   expect(f.source.counters.effects).toBe(0);expect(f.source.counters.reads).toBe(reads)
  }finally{await f.cleanup()}
 })
 it('ignores advertised effect callbacks in the actual service workflow registry',async()=>{
  const f=await sourceServiceFixture(),effect=vi.fn(),reconcile=vi.fn()
  try{
   configureConnectorSourceRuntimeFactory(async input=>{const value=await f.factory(input);return value?{...value,effectBinding:'command_v1',effect,reconcile}:null},{instances:f.instances})
   const run=await createDbWorkflowRunStore().createRun({workflowId:f.workflow.id,workspaceId:f.workspace,triggeredBy:null,triggerKind:'schedule'})
   const scope=await resolveWorkflowRunScope({run,userId:f.owner,assistantId:f.assistant,workspaceId:f.workspace})
   const tools=await buildWorkflowToolRegistry({firstParty:new Map([['sourceEffect',{} as never],['sourceReconcile',{} as never]]),connectorStore:{} as never,settingsStore:{} as never},{workspaceId:f.workspace,assistantId:f.assistant,userId:f.owner,turnScope:scope.turnScope})
   expect(tools.has('readRecord')).toBe(true);expect(tools.has('sourceEffect')).toBe(false);expect(tools.has('sourceReconcile')).toBe(false)
   expect(effect).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();expect(f.source.counters.effects).toBe(0)
  }finally{await f.cleanup()}
 })

 it('refuses a copied protected read output at the canonical workflow writer',async()=>{
  const f=await sourceServiceFixture()
  try{
   const workflows=createDbWorkflowStore(),runs=createDbWorkflowRunStore(),run=await runs.createRun({workflowId:f.workflow.id,workspaceId:f.workspace,triggeredBy:null,triggerKind:'schedule'})
   const model=vi.fn(async()=>{throw new Error('No model fallback')})
   await expect(advanceWorkflowRun({abortSignal:new AbortController().signal,workflowStore:workflows,runStore:runs,resolvePrimary:async()=>f.assistant,resolveRunScope:resolveWorkflowRunScope,
    buildToolRegistry:async scope=>{const tools=await buildWorkflowToolRegistry({firstParty:new Map(),connectorStore:{} as never,settingsStore:{} as never},scope),read=tools.get('readRecord')!
     tools.set('readRecord',{...read,execute:async(input,context)=>{const value=await read.execute(input,context);return{...value,data:structuredClone(value.data)}}});return tools},
    consultTransport:{send:model},pauseRunForWait:async()=>{}},run.id)).resolves.toMatchObject({kind:'failed',error:{reason:'dispatch_threw',message:'source_access_denied'}})
   expect((await getPool().query("SELECT output FROM workflow_step_runs WHERE run_id=$1 AND step_id='read'",[run.id])).rows).toEqual([{output:null}])
   expect(f.source.counters.reads).toBe(1);expect(f.source.counters.effects).toBe(0);expect(model).not.toHaveBeenCalled()
  }finally{await f.cleanup()}
 })

})
