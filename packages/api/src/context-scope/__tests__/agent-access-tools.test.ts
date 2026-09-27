import { describe,expect,it } from 'vitest'
import { z } from 'zod'
import { buildTool,type ToolContext } from '@use-brian/core'
import { currentAgentAccess,runWithAgentAccess } from '../../db/agent-access-context.js'
import { bindToolsToAgentAccess } from '../agent-access-tools.js'

const context:ToolContext={userId:'actor',workspaceId:'workspace',assistantId:'caller',assistantKind:'standard',sessionId:'session',appId:'fixture',channelType:'web',channelId:'channel',abortSignal:new AbortController().signal}
const probe=buildTool({name:'scopeProbe',description:'Inspect execution scope.',inputSchema:z.object({}),execute:async()=>{await Promise.resolve();return {data:currentAgentAccess()}}})
const tools=new Map([[probe.name,probe]])
describe('[COMP:api/agent-access-ceiling] tool invocation boundary',()=>{
  it('pins actor and assistant visibility for the whole awaited tool call',async()=>{
    const scoped=bindToolsToAgentAccess(tools,{clearance:'internal',compartments:['product'],projectIds:[]})
    expect((await scoped.get(probe.name)!.execute({},context)).data).toEqual({userId:'actor',workspaceId:'workspace',clearance:'internal',compartments:['product'],mutationCompartments:['product'],projectIds:[],visibilityAssistantIds:['caller']})
    expect(currentAgentAccess()).toBeUndefined()
  })
  it('preserves a caller ceiling when a nested tool declares primary authority',async()=>{
    const scoped=bindToolsToAgentAccess(tools,{clearance:'confidential',compartments:null,projectIds:null})
    const result=await runWithAgentAccess({userId:'actor',workspaceId:'workspace',clearance:'internal',compartments:[],projectIds:[],visibilityAssistantIds:['caller']},()=>scoped.get(probe.name)!.execute({}, {...context,assistantId:'callee',assistantKind:'primary'}))
    expect(result.data).toMatchObject({clearance:'internal',compartments:[],projectIds:[],visibilityAssistantIds:['caller']})
  })
  it('refuses an owner substitution inside an existing actor context',async()=>{
    const scoped=bindToolsToAgentAccess(tools,{clearance:'confidential',compartments:null,projectIds:null})
    await expect(async()=>runWithAgentAccess({userId:'actor',clearance:'internal',compartments:[]},()=>scoped.get(probe.name)!.execute({}, {...context,userId:'owner'}))).rejects.toThrow('access_actor_mismatch')
  })
  it('retains the narrower mutation envelope in nested contexts even when a child omits it',async()=>{
    await runWithAgentAccess({workspaceId:'workspace',userId:'actor',clearance:'internal',compartments:['product','finance'],mutationCompartments:['product']},async()=>{
      await runWithAgentAccess({clearance:'confidential',compartments:null,mutationCompartments:null},async()=>{
        expect(currentAgentAccess()).toMatchObject({compartments:['finance','product'],mutationCompartments:['product']});
      });
      await runWithAgentAccess({clearance:'internal',compartments:['finance']},async()=>{
        expect(currentAgentAccess()).toMatchObject({compartments:['finance'],mutationCompartments:[]});
      });
    });
  })

  it('passes the narrowed mutation authority to a tool even if its supplied context claims more',async()=>{
    const receiver=buildTool({name:'contextProbe',description:'Fixture context.',inputSchema:z.object({}),execute:async(_input,ctx)=>({data:ctx.mutationCompartments})});
    const bound=bindToolsToAgentAccess(new Map([[receiver.name,receiver]]),{clearance:'internal',compartments:['product','finance'],mutationCompartments:['product'],projectIds:[]});
    expect((await bound.get(receiver.name)!.execute({},{...context,mutationCompartments:null})).data).toEqual(['product']);
  })

})
