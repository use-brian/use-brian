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

describe('[COMP:api/agent-access-ceiling] host read context forwarding',()=>{
  it.each(['complete','source','timeout','method'] as const)('preserves physical dispatch guards through actual access and MCP wrappers (%s)',async kind=>{
    const {vi}=await import('vitest')
    const {createGoogleCalendarTools,createMcpSearchTools,buildToolIndex,inheritRoutineCalendarRead,ContextScopeAccumulator,queryLoop,NOOP_TURN_LEDGER}=await import('@use-brian/core')
    const {executionFixture,fixtureDecisionProvider}=await import('../../../../core/src/decisions/__tests__/execution-fixture.js')
    const controller=new AbortController(),lease={assertCurrent:async()=>{},execute:async<T>(fn:()=>Promise<T>)=>fn()}
    const execution={security:{authority:lease,ceiling:{clearance:'internal'},provenance:{},access:{userId:'actor',workspaceId:'workspace',assistantId:'caller',clearance:'internal',compartments:[],projectIds:[]}},lifecycle:{abortSignal:controller.signal}} as unknown as NonNullable<ToolContext['executionContext']>
    let phase=false,revoked=false,physicalChecks=0,entered!:()=>void,release!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
    const input:ToolContext={...context,abortSignal:controller.signal,executionContext:execution,authority:lease,scopeAccumulator:new ContextScopeAccumulator(),assertModelInputAuthority:async()=>{
      if(!phase)return
      physicalChecks++
      if(revoked)throw new Error('Fictional source held during approval')
      if(kind==='timeout'){entered();await gate}
    }}
    const list=vi.fn(async()=>({items:[]})),canonical=createGoogleCalendarTools({listEvents:list} as unknown as import('@use-brian/core').GoogleCalendarApi).find(tool=>tool.name==='googleCalendarListEvents')!
    canonical.requiresConfirmation=true;canonical.timeoutMs=15
    const settings={getPolicy:async()=>null,setPolicy:async()=>{},recordUsage:async()=>{},recordUsageAndGetCount:async()=>({timesAllowed:0,timesDenied:0})}
    const direct=createMcpSearchTools({index:buildToolIndex([{kind:'local',serverName:'gcal',tools:[canonical]}]),settingsStore:settings,assistantId:'caller',userId:'actor',exposeLocalReadTools:true}).find(tool=>tool.name===canonical.name)!
    const bound=bindToolsToAgentAccess(new Map([[direct.name,direct]]),{clearance:'internal',compartments:[],projectIds:[]})
    inheritRoutineCalendarRead(direct,bound.get(direct.name)!)
    let compositions=0
    const events:import('@use-brian/core').QueryEvent[]=[]
    const provider:import('@use-brian/core').LLMProvider={name:'fixture',models:['fixture'],stream(){throw new Error('Unexpected stateless dispatch')},createSession:()=>({send:async function*(){compositions++;yield{type:'text_delta',text:'Fictional calendar answer'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}}})}
    const runtime=executionFixture({llm:provider,totalTimeoutMs:1000,primaryTimeoutMs:900,primary:fixtureDecisionProvider(async request=>{
      const state=request.state as unknown as {targets:Array<{id:string}>;ranges:Array<{id:string}>}
      const answers:import('@use-brian/core').DecisionAnswer[]=request.questions.map(question=>question.kind==='boolean'
        ? {kind:'boolean',questionId:question.id,value:question.id===state.targets[0].id,evidence:{source:'unavailable'}}
        : {kind:'choice',questionId:question.id,value:question.id==='routine'?'calendar':state.ranges[0].id,evidence:{source:'unavailable'}})
      return{providerId:'fixture-decision',model:request.model,answers}
    })})
    const replacement=vi.fn(async()=>({data:[]}))
    const running=(async()=>{for await(const event of queryLoop({provider,model:'fixture',systemPrompt:'Check only the chosen calendar.',messages:[{role:'user',content:'Check my calendar.'}],tools:bound,context:input,ledger:NOOP_TURN_LEDGER,maxTurns:1,
      routineCalendarRead:{runtime,llm:{provider,modelId:'fixture'},calendarTools:bound},confirmationResolver:{resolve:()=>false,waitForDecision:async()=>{
        if(kind==='source')revoked=true
        if(kind==='method')canonical.execute=replacement
        return{decision:'allow'}
      }}})){events.push(event);if(event.type==='tool_input')phase=true}})()
    const outcome=running.then(()=>({ok:true}),error=>({error}))
    if(kind==='timeout'){await started;await new Promise(resolve=>setTimeout(resolve,30));release()}
    const result=await outcome
    if(kind==='complete'){expect(result).toEqual({ok:true});expect(list).toHaveBeenCalledOnce();expect(physicalChecks).toBeGreaterThan(0)}
    else {expect(list).not.toHaveBeenCalled();expect(replacement).not.toHaveBeenCalled();if(kind!=='timeout'){
      expect('error' in result||events.some(event=>event.type==='error')).toBe(true);expect(compositions).toBe(0)
    }}
    await Promise.resolve();expect(list.mock.calls.length).toBe(kind==='complete'?1:0)
  })
})
