import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { advanceWorkflowRun, buildTool } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture(manual: boolean) {
  const workspaceId=randomUUID(), ownerId=randomUUID(), userId=randomUUID(), assistantId=randomUUID()
  for(const id of [ownerId,userId])await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Synthetic discovery workspace',$2,false)",[workspaceId,ownerId])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product')",[workspaceId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance,compartments)
    VALUES($1,$2,'owner','confidential',NULL),($1,$3,'member','internal',ARRAY['product'])`,[workspaceId,ownerId,userId])
  await pool.query(`INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance,compartments)
    VALUES($1,'Synthetic discovery assistant',$2,$3,'primary','confidential',NULL)`,[assistantId,ownerId,workspaceId])
  const authoringAuthority=await captureAuthoringAuthoritySystem({workspaceId,userId,assistantId})
  const workflows=createDbWorkflowStore(),runs=createDbWorkflowRunStore()
  const workflow=await workflows.create({workspaceId,userId,name:'Synthetic discovery workflow',authoringAuthority,
    definition:{startStepId:'effect',steps:[{id:'effect',type:'tool_call',toolName:'syntheticEffect',arguments:{}}]},
  })
  const run=await runs.createRun({workspaceId,workflowId:workflow.id,triggeredBy:manual?userId:null,triggerKind:manual?'manual':'schedule'})
  const changePolicy=()=>pool.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,userId]).then(()=>undefined)
  const effect=vi.fn(async()=>({data:{ok:true}}))
  const tool=buildTool({name:'syntheticEffect',description:'Synthetic discovery effect',inputSchema:z.object({}),execute:effect})
  const discovery=vi.fn(async()=>new Map([[tool.name,tool]]))
  const advance=async(options:{beforeDiscovery?:()=>Promise<void>;duringDiscovery?:()=>Promise<void>}={})=>{
    const result=await advanceWorkflowRun({
      workflowStore:workflows,runStore:runs,resolvePrimary:async()=>assistantId,
      resolveRunScope:async input=>{
        const scope=await resolveWorkflowRunScope(input)
        await options.beforeDiscovery?.()
        return scope
      },
      buildToolRegistry:async input=>{
        expect(input).toMatchObject({workspaceId,userId,assistantId})
        const tools=await discovery()
        await options.duringDiscovery?.()
        return tools
      },
      consultTransport:{async send(){throw new Error('Unexpected consult')}},
    },run.id)
    const steps=(await pool.query('SELECT id FROM workflow_step_runs WHERE run_id=$1',[run.id])).rows
    return {result,steps}
  }
  return {advance,changePolicy,effect,discovery}
}

describe('[COMP:api/application-lifecycle] actual workflow discovery authority',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it.each([true,false])('unchanged authorized work discovers and executes exactly once (manual=%s)',async manual=>{
    const f=await fixture(manual),{result,steps}=await f.advance()
    expect(result).toMatchObject({kind:'completed'})
    expect(f.discovery).toHaveBeenCalledTimes(1)
    expect(f.effect).toHaveBeenCalledTimes(1)
    expect(steps).toHaveLength(1)
  })
  it.each([true,false])('refuses before discovery after invocation policy changes (manual=%s)',async manual=>{
    const f=await fixture(manual),{result,steps}=await f.advance({beforeDiscovery:f.changePolicy})
    expect(result).toMatchObject({kind:'failed',error:{reason:'authority_changed'},stepCount:0})
    expect(f.discovery).not.toHaveBeenCalled()
    expect(f.effect).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })
  it.each([true,false])('withholds discovery results after an awaited policy change before creating steps (manual=%s)',async manual=>{
    const f=await fixture(manual),{result,steps}=await f.advance({duringDiscovery:f.changePolicy})
    expect(result).toMatchObject({kind:'failed',error:{reason:'authority_changed'},stepCount:0})
    expect(f.discovery).toHaveBeenCalledTimes(1)
    expect(f.effect).not.toHaveBeenCalled()
    expect(steps).toEqual([])
  })
})
