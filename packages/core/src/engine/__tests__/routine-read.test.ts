import {buildToolIndex,createMcpSearchTools} from '../../mcp/tool-search.js'
import {describe,it,expect,vi} from 'vitest'
import {createGoogleCalendarTools,type GoogleCalendarApi} from '../../tools/base/google-calendar.js'
import {ContextScopeAccumulator} from '../../security/context-scope.js'
import type {ToolContext,Tool} from '../../tools/types.js'
import type {LLMProvider,Message} from '../../providers/types.js'
import {executionFixture,fixtureDecisionProvider} from '../../decisions/__tests__/execution-fixture.js'
import type {DecisionRequest,DecisionAnswer} from '../../decisions/types.js'
import {planRoutineCalendarRead,executeRoutineCalendarRead,consumeHostReadObservation} from '../routine-read.js'
import {createLoopDetector} from '../loop-detector.js'
import {NOOP_TURN_LEDGER} from '../turn-ledger.js'
import {queryLoop,type QueryEvent} from '../query-loop.js'
import {inheritRoutineCalendarRead} from '../routine-read-ownership.js'

const now=Date.parse('2031-06-02T00:00:00Z')
const range={timeMin:'2031-06-02T00:00:00Z',timeMax:'2031-06-30T00:00:00Z'}
const history:Message[]=[{role:'assistant',content:[{type:'tool_use',id:'previous',name:'googleCalendarListEvents',input:{...range,calendarId:'fictional-calendar'}}]},
 {role:'user',content:[{type:'tool_result',toolUseId:'previous',name:'googleCalendarListEvents',content:'[]'}]},
 {role:'user',content:'Check that calendar for the same range again.'}]
function setup(options:{page?:unknown;choose?:(request:DecisionRequest)=>string;extra?:Partial<Tool>}={}){
 const lease=vi.fn(async()=>{}),full=vi.fn(async()=>{}),controller=new AbortController()
 const authority={assertCurrent:lease,execute:async<T>(fn:()=>Promise<T>)=>fn()}
 const execution={security:{authority,ceiling:{clearance:'public'},provenance:{}},lifecycle:{abortSignal:controller.signal}} as unknown as NonNullable<ToolContext['executionContext']>
 const context:ToolContext={userId:'fictional-user',assistantId:'fictional-assistant',sessionId:'fictional-session',appId:'fixture',channelType:'web',channelId:'fixture',
  abortSignal:controller.signal,authority,executionContext:execution,scopeAccumulator:new ContextScopeAccumulator(),assertModelInputAuthority:full}
 const list=vi.fn(async(_input:unknown)=>options.page??{items:[]})
 const canonical=createGoogleCalendarTools({listEvents:list} as unknown as GoogleCalendarApi).find(tool=>tool.name==='googleCalendarListEvents')!
 const tool=options.extra?inheritRoutineCalendarRead(canonical,{...canonical,...options.extra}):canonical
 const tools=new Map([[tool.name,tool]])
 const stream=vi.fn(async function*(){yield{type:'text_delta' as const,text:'No events in the requested scope.'};yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1}}})
 const provider:LLMProvider={name:'fixture',models:['fixture'],stream,createSession:vi.fn(()=>({send:stream}))}
 const evaluate=vi.fn(async(request:DecisionRequest)=>{
  const state=request.state as unknown as {targets:Array<{id:string;calendarId:string}>;ranges:Array<{id:string;timeMax:string}>}
  const choice=options.choose?.(request)??'calendar'
  const selectedRange=state.ranges.find(value=>value.timeMax===range.timeMax)??state.ranges[0]
  const answers:DecisionAnswer[]=request.questions.map(question=>question.kind==='boolean'
   ? {kind:'boolean',questionId:question.id,value:choice==='all_concrete'?state.targets.some(target=>target.id===question.id&&target.calendarId!=='primary'):state.targets.some(target=>target.id===question.id&&target.calendarId==='fictional-calendar'),evidence:{source:'unavailable'}}
   : {kind:'choice',questionId:question.id,value:question.id==='routine'?(choice==='all_concrete'?'calendar':choice):selectedRange.id,evidence:{source:'unavailable'}})
  return{providerId:'fixture-decision',model:request.model,answers}
 })
 const runtime=executionFixture({primary:fixtureDecisionProvider(evaluate),llm:provider,totalTimeoutMs:1000,primaryTimeoutMs:900})
 const config={runtime,llm:{provider,modelId:'fixture'},calendarTools:tools}
 const input={...config,systemPrompt:'Honor all fictional instructions.',messages:structuredClone(history),tools,context,assertInputAuthority:full,now}
 return{input,config,context,execution,tools,tool,canonical,list,lease,full,evaluate,provider,stream,controller}
}
async function runHost(f:ReturnType<typeof setup>,onEvent?:(event:QueryEvent)=>void,extra:Partial<import('../query-loop.js').QueryLoopOptions>={}){
 const options={provider:f.provider,model:'fixture',systemPrompt:f.input.systemPrompt,messages:f.input.messages,tools:f.tools,context:f.context,
  ledger:NOOP_TURN_LEDGER,routineCalendarRead:f.config,maxTurns:1,...extra}
 const iterator=executeRoutineCalendarRead({options,tools:f.tools,loopDetector:createLoopDetector({hardLimit:10}),deniedTools:new Set(),
  ledger:NOOP_TURN_LEDGER.startTrace({actor:'assistant_turn',model:'fixture',systemPrompt:'',messages:[]}),assertInputAuthority:f.full})
 const events:QueryEvent[]=[]
 while(true){const result=await iterator.next();if(result.done)return{events,result:result.value};events.push(result.value);onEvent?.(result.value)}
}
describe('[COMP:engine/routine-read] full-context host calendar reads',()=>{
 it('retains the complete prepared context while excluding unrelated capability descriptions',async()=>{
  const f=setup(),catalog=new Map(f.tools)
  catalog.set('fictionalOther',{...f.tool,name:'fictionalOther',description:'Unrelated capability metadata. '.repeat(10_000)})
  const messages:Message[]=[...history,{role:'user',content:'Fictional prior context. '.repeat(4_300)}]
  const systemPrompt='Fictional governing context. '.repeat(1_500)
  const result=await planRoutineCalendarRead({...f.input,tools:catalog,systemPrompt,messages})
  expect(result.plan).not.toBeNull()
  const state=f.evaluate.mock.calls[0][0].state as unknown as {systemPrompt:string;messages:Message[];tools:Array<{name:string;description:string}>}
  expect(state.systemPrompt).toBe(systemPrompt);expect(JSON.stringify(state.messages)).toBe(JSON.stringify(messages))
  expect(state.tools).toEqual([{name:f.tool.name,description:f.tool.description}])
  expect(result.inputCounts).toMatchObject({toolCount:1,messageCount:messages.length,maxEstimatedTokens:50_000,providerMaxInputTokens:64_000})
  expect(result.inputCounts!.estimatedTokens).toBeLessThan(50_000)
  expect(result.inputCounts!.questionCharacters).toBeGreaterThan(0)
  expect(JSON.stringify(result.inputCounts)).not.toContain('Fictional')
  expect(f.list).not.toHaveBeenCalled()
 })
 it('includes all question and option bytes in the conservative input bound',async()=>{
  const f=setup(),baseline=await planRoutineCalendarRead(f.input)
  const padding=4*49_900-baseline.inputCounts!.stateCharacters
  f.evaluate.mockClear()
  const result=await planRoutineCalendarRead({...f.input,systemPrompt:f.input.systemPrompt+'x'.repeat(padding)})
  expect(result.inputCounts!.stateCharacters/4).toBeLessThan(50_000)
  expect(result.inputCounts!.estimatedTokens).toBeGreaterThan(50_000)
  expect(result.path).toBe('context_limit');expect(result.plan).toBeNull()
  expect(f.evaluate).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled()
 })
 it.each([7,30])('preserves the model-chosen %s-day window for an undated request without imposing a default',async days=>{
  const f=setup(),original=f.evaluate.getMockImplementation()!
  f.input.messages=[...history.slice(0,2),{role:'user',content:'Check that calendar now.'}]
  let selectedWindow:{timeMin:string;timeMax:string}|undefined
  f.evaluate.mockImplementation(async request=>{
   const response=await original(request)
   const state=request.state as unknown as {now:string;ranges:Array<{id:string;timeMin:string;timeMax:string}>}
   const selectedEnd=new Date(Date.parse(state.now)+days*86_400_000).toISOString()
   const selected=state.ranges.find(value=>value.timeMin===state.now&&value.timeMax===selectedEnd)!
   selectedWindow={timeMin:selected.timeMin,timeMax:selected.timeMax}
   expect(selected).toBeDefined()
   for(const id of ['routine','range'])expect(request.questions.find(question=>question.id===id)?.prompt.toLowerCase()).toContain('missing dates alone are not ambiguity')
   expect(request.questions.find(question=>question.id==='range')?.prompt).not.toMatch(/global ordinary|EVERY selected/)
   expect(request.questions.find(question=>question.id==='range')?.prompt).toContain('independently from the other questions')
   response.answers[response.answers.length-1]={kind:'choice',questionId:'range',value:selected.id,evidence:{source:'unavailable'}}
   return response
  })
  const {result}=await runHost(f)
  expect(result.complete).toBe(true)
  expect(f.list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({calendarId:'fictional-calendar',...selectedWindow,maxResults:2500}))
 })
 it('retains ordinary planning for an explicit unrepresented period rather than substituting an available window',async()=>{
  const f=setup({choose:()=> 'ordinary'})
  f.input.messages=[...history.slice(0,2),{role:'user',content:'Check that calendar only from 2032-08-11T09:15:00Z to 2032-08-11T10:45:00Z.'}]
  const result=await planRoutineCalendarRead(f.input)
  expect(result.plan).toBeNull();expect(f.list).not.toHaveBeenCalled()
  const rangeQuestion=f.evaluate.mock.calls[0][0].questions.find(question=>question.id==='range')!
  expect(rangeQuestion.prompt).toContain('Explicit dates and a clearly established conversation range take precedence')
 })
 it('represents all historical calendar targets without enumerating subsets',async()=>{
  const f=setup(),historyCalls=Array.from({length:5},(_,index)=>({name:f.tool.name,input:{...range,calendarId:`fictional-calendar-${index}`,maxResults:2500}}))
  const result=await planRoutineCalendarRead({...f.input,historyCalls})
  expect(result.plan).not.toBeNull();expect(result.scopeCounts).toMatchObject({targets:7,questions:9})
  const request=f.evaluate.mock.calls[0][0],state=request.state as unknown as {targets:Array<{calendarId:string}>}
  expect(request.operation).toMatchObject({version:'3',stateVersion:'3',questionVersion:'3'})
  expect(state.targets.map(target=>target.calendarId)).toEqual(expect.arrayContaining(['primary','fictional-calendar',...historyCalls.map(call=>call.input.calendarId)]))
  expect(request.questions).toHaveLength(9);expect(request.state).not.toHaveProperty('candidates')
 })
 it('keeps more than twelve distinct historical windows within the real option bound',async()=>{
  const f=setup(),historyCalls=Array.from({length:15},(_,index)=>({name:f.tool.name,input:{calendarId:'fictional-calendar',timeMin:new Date(Date.UTC(2031,0,1,index)).toISOString(),timeMax:new Date(Date.UTC(2031,0,1,index+1)).toISOString(),maxResults:2500}}))
  const result=await planRoutineCalendarRead({...f.input,historyCalls})
  expect(result.plan).not.toBeNull()
  const state=f.evaluate.mock.calls[0][0].state as unknown as {ranges:unknown[]}
  for(const call of historyCalls)expect(state.ranges).toContainEqual(expect.objectContaining({timeMin:call.input.timeMin,timeMax:call.input.timeMax}))
 })
 it.each(['questions','options'] as const)('declines actual provider %s overflow without dropping scope',async kind=>{
  const f=setup(),historyCalls=Array.from({length:kind==='questions'?62:255},(_,index)=>({name:f.tool.name,input:{calendarId:kind==='questions'?`fictional-calendar-${index}`:'fictional-calendar',timeMin:new Date(Date.UTC(2031,0,1,index)).toISOString(),timeMax:new Date(Date.UTC(2031,0,1,index+1)).toISOString(),maxResults:2500}}))
  const result=await planRoutineCalendarRead({...f.input,historyCalls})
  expect(result.plan).toBeNull();expect(result.path).toBe(kind==='questions'?'scope_question_limit':'scope_option_limit')
  expect(f.evaluate).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled()
 })
 it.each(['missing','duplicate','unknown','wrong_type','empty','primary_alias','range_none'] as const)('rejects %s scope answers rather than inventing a complete plan',async kind=>{
  const f=setup(),original=f.evaluate.getMockImplementation()!
  f.evaluate.mockImplementation(async request=>{
   const response=await original(request)
   if(kind==='missing')response.answers.pop()
   if(kind==='duplicate')response.answers[response.answers.length-1]=response.answers[0]
   if(kind==='unknown')response.answers[response.answers.length-1]={kind:'choice',questionId:'range',value:'unknown-window',evidence:{source:'unavailable'}}
   if(kind==='wrong_type')response.answers[1]={kind:'choice',questionId:response.answers[1].questionId,value:'true',evidence:{source:'unavailable'}}
   if(kind==='empty'||kind==='primary_alias')for(const answer of response.answers)if(answer.kind==='boolean')answer.value=kind==='primary_alias'
   if(kind==='range_none')response.answers[response.answers.length-1]={kind:'choice',questionId:'range',value:'none',evidence:{source:'unavailable'}}
   return response
  })
  expect((await planRoutineCalendarRead(f.input)).plan).toBeNull();expect(f.list).not.toHaveBeenCalled()
 })
 it.each(['mutate','replace'] as const)('keeps exact decoded scope when a runtime tries to %s its result during final admission',async kind=>{
  const f=setup(),run=f.config.runtime.run.bind(f.config.runtime)
  let returned:{result:{calls:Array<{name:string;input:{calendarId:string;timeMin:string;timeMax:string;maxResults:number}}>}}|undefined
  f.config.runtime.run=async options=>{const result=await run(options);returned=result as unknown as typeof returned;return result}
  let changed=false
  f.full.mockImplementation(async()=>{
   if(!returned||changed)return
   await Promise.resolve();changed=true
   if(kind==='mutate')returned.result.calls[0].input.calendarId='primary'
   else returned.result={calls:[{name:f.tool.name,input:{...range,calendarId:'primary',maxResults:2500}}]}
  })
  const {result}=await runHost(f)
  expect(changed).toBe(true);expect(result.complete).toBe(true)
  expect(f.list).toHaveBeenCalledWith(expect.objectContaining({calendarId:'fictional-calendar',...range}))
 })
 it('declines a selected scope that cannot fit the remaining real tool budget before I/O',async()=>{
  const f=setup();const result=await runHost(f,undefined,{maxToolCalls:1})
  expect(result.result.calls).toBe(0);expect(f.list).not.toHaveBeenCalled()
 })

 it('declines host execution when capped observations cannot fit the smaller model retry budget',async()=>{
  const f=setup();const {result}=await runHost(f,undefined,{inputTokenLimit:128_000})
  expect(result.calls).toBe(0);expect(result.complete).toBe(false);expect(f.list).not.toHaveBeenCalled()
 })
 it('reserves the full governing system/runtime instructions before host execution',async()=>{
  const f=setup();const {result}=await runHost(f,undefined,{inputTokenLimit:400_000,runtimeSystemContext:'x'.repeat(120_000)})
  expect(result.calls).toBe(0);expect(f.list).not.toHaveBeenCalled()
 })
 it('does not reactively summarize complete observations after an unexpected provider overflow',async()=>{
  const f=setup();f.stream.mockImplementation(async function*(){throw new Error('context length exceeded')})
  const events:QueryEvent[]=[]
  for await(const event of queryLoop({provider:f.provider,model:'fixture',systemPrompt:f.input.systemPrompt,messages:f.input.messages,tools:f.tools,context:f.context,
    ledger:NOOP_TURN_LEDGER,routineCalendarRead:f.config,maxTurns:2,compactModel:'fixture'}))events.push(event)
  expect(f.list).toHaveBeenCalledOnce();expect(f.stream).toHaveBeenCalledOnce()
  expect(events.some(event=>event.type==='error')).toBe(true)
  expect(events.some(event=>event.type==='assistant_turn')).toBe(false)
 })

 it.each([
  ['2026-03-08T12:00:00Z','2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z'],
  ['2026-11-01T12:00:00Z','2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z'],
 ])('offers the actual local day and its remainder across DST at %s',async(instant,start,end)=>{
  const f=setup();f.context.userTimezone='America/New_York'
  await planRoutineCalendarRead({...f.input,now:Date.parse(instant)})
  const state=f.evaluate.mock.calls[0][0].state as unknown as {ranges:Array<{timeMin:string;timeMax:string}>}
  const scopes=state.ranges
  expect(scopes).toContainEqual(expect.objectContaining({timeMin:start,timeMax:end,labels:expect.arrayContaining(['Current local day (America/New_York)'])}))
  expect(scopes).toContainEqual(expect.objectContaining({timeMin:new Date(instant).toISOString(),timeMax:end,labels:expect.arrayContaining(['Remainder of today (America/New_York)'])}))
 })
 it('offers the true union of historical partitions without imposing it as a default',async()=>{
  const f=setup({choose:()=> 'ordinary'})
  await planRoutineCalendarRead({...f.input,historyCalls:[{name:f.tool.name,input:{calendarId:'fictional-calendar',timeMin:'2031-06-01T00:00:00Z',timeMax:'2031-06-10T00:00:00Z',maxResults:2500}}]})
  const state=f.evaluate.mock.calls[0][0].state as unknown as {ranges:Array<{timeMin:string;timeMax:string}>}
  expect(state.ranges).toContainEqual(expect.objectContaining({timeMin:'2031-06-01T00:00:00Z',timeMax:range.timeMax}))
  expect(f.list).not.toHaveBeenCalled()
 })
 it('sends the complete governing context and preserves the exact model-selected calendar/window',async()=>{
  const f=setup();const plan=await planRoutineCalendarRead(f.input)
  expect(plan.plan).not.toBeNull();expect(f.evaluate).toHaveBeenCalledOnce()
  const state=f.evaluate.mock.calls[0][0].state as unknown as Record<string,unknown>
  expect(state.systemPrompt).toBe(f.input.systemPrompt);expect(state.messages).toEqual(history)
  expect(f.list).not.toHaveBeenCalled()
 })
 it.each(['lease','source','final'] as const)('never converts plain %s authority failure to ordinary fallback',async where=>{
  const f=setup(),error=new Error('Fictional permission withdrawn')
  if(where==='lease')f.lease.mockRejectedValue(error)
  if(where==='source')f.full.mockRejectedValue(error)
  if(where==='final')f.evaluate.mockImplementation(async request=>{f.full.mockRejectedValue(error);return{providerId:'fixture-decision',model:request.model,answers:[{kind:'choice',questionId:'routine',value:'ordinary',evidence:{source:'unavailable'}}]}})
  await expect(planRoutineCalendarRead(f.input)).rejects.toBe(error)
  expect(f.list).not.toHaveBeenCalled()
 })
 it('rejects an uncertified same-name read adapter before planning',async()=>{
  const f=setup(),fake={...f.tool,execute:vi.fn(async()=>({data:[],meta:{calendarReadComplete:true}}))};f.tools.set(fake.name,fake)
  expect((await planRoutineCalendarRead(f.input)).plan).toBeNull();expect(f.evaluate).not.toHaveBeenCalled()
 })
 it('retains typed host-history vocabulary without reading replay prose',async()=>{
  const f=setup();f.input.messages=[{role:'user',content:'Check the same calendar.'}]
  const result=await planRoutineCalendarRead({...f.input,historyCalls:[{name:f.tool.name,input:{...range,calendarId:'fictional-calendar',maxResults:2500}}]})
  expect(result.plan).not.toBeNull()
 })
 it('rejects replacement of an exact adapter while planning is pending',async()=>{
  const f=setup();f.lease.mockImplementationOnce(async()=>{f.tool.execute=vi.fn(async()=>({data:[]}))})
  await expect(planRoutineCalendarRead(f.input)).rejects.toMatchObject({reason:'authority_changed'});expect(f.list).not.toHaveBeenCalled()
 })
 it('executes through the real tool and mints only an execution-bound, single-use durable receipt',async()=>{
  const f=setup();const {events,result}=await runHost(f)
  expect(f.list).toHaveBeenCalledOnce();expect(f.list.mock.calls[0][0]).toMatchObject({...range,calendarId:'fictional-calendar',maxResults:2500})
  expect(result.complete).toBe(true)
  const event=events.find(event=>event.type==='tool_result') as Extract<QueryEvent,{type:'tool_result'}>
  expect(()=>consumeHostReadObservation({...event.hostRead!},f.execution)).toThrow()
  expect(()=>consumeHostReadObservation(event.hostRead!,{} as typeof f.execution)).toThrow()
  expect(consumeHostReadObservation(event.hostRead!,f.execution)).toMatchObject([{type:'host_observation',name:f.tool.name,input:{...range,calendarId:'fictional-calendar'}}])
  expect(()=>consumeHostReadObservation(event.hostRead!,f.execution)).toThrow()
  expect(JSON.stringify(result.messages)).not.toContain('providerSignature')
 })
 it('checks fresh source authority after the tool_input consumer before the actual read',async()=>{
  const f=setup();await expect(runHost(f,event=>{if(event.type==='tool_input')f.full.mockRejectedValue(new Error('Source held'))})).rejects.toMatchObject({reason:'authority_changed'})
  expect(f.list).not.toHaveBeenCalled()
 })
 it.each([{items:[],nextPageToken:'fictional-next'},[]])('keeps partial/unverified observations for ordinary continuation',async page=>{
  const f=setup({page});const {result}=await runHost(f)
  expect(result.complete).toBe(false);expect(f.list).toHaveBeenCalledOnce();expect(JSON.stringify(result.messages)).toContain('incomplete or failed')
 })
 it('uses the executor cap rather than a connector completeness claim',async()=>{
  const f=setup({page:{items:[{summary:'x'.repeat(400)}]},extra:{maxResultSizeChars:80}})
  const {result,events}=await runHost(f);expect(result.complete).toBe(false)
  expect(events.find(event=>event.type==='tool_result')).toMatchObject({metaByToolUseId:expect.objectContaining({[result.records[0].id]:expect.objectContaining({outputTruncated:true})})})
 })
 it('declines multimodal and unknown/unrepresented scopes',async()=>{
  const f=setup({choose:()=> 'not-listed'});expect((await planRoutineCalendarRead(f.input)).plan).toBeNull()
  f.evaluate.mockClear();f.input.messages.push({role:'user',content:[{type:'image',mimeType:'image/png',data:'fictional'}]})
  expect((await planRoutineCalendarRead(f.input)).plan).toBeNull();expect(f.evaluate).not.toHaveBeenCalled()
 })
 it.each(['source','steer','method'] as const)('rechecks %s after an inner MCP approval before physical dispatch',async kind=>{
  const f=setup();f.canonical.requiresConfirmation=true
  const settings={getPolicy:async()=>null,setPolicy:async()=>{},recordUsage:async()=>{},recordUsageAndGetCount:async()=>({timesAllowed:0,timesDenied:0})}
  const direct=createMcpSearchTools({index:buildToolIndex([{kind:'local',serverName:'gcal',tools:[f.canonical]}]),settingsStore:settings,assistantId:'fictional-assistant',userId:'fictional-user',exposeLocalReadTools:true}).find(tool=>tool.name===f.tool.name)!
  f.tools.set(direct.name,direct)
  let pending=false
  const replacement=vi.fn(async()=>({data:[]}))
  const running=runHost(f,undefined,{turnInbox:{peek:()=>({pending,steer:pending}),drain:()=>[]},confirmationResolver:{resolve:()=>false,waitForDecision:async()=>{
   if(kind==='source')f.full.mockRejectedValue(new Error('Source held during approval'))
   if(kind==='steer')pending=true
   if(kind==='method')f.canonical.execute=replacement
   return{decision:'allow'}
  }}})
  if(kind==='steer')expect((await running).result.complete).toBe(false)
  else await expect(running).rejects.toMatchObject({reason:'authority_changed'})
  expect(f.list).not.toHaveBeenCalled();expect(replacement).not.toHaveBeenCalled()
 })
 it('declines a plan when user steering arrives while planning is pending',async()=>{
  const f=setup();let pending=false
  const original=f.evaluate.getMockImplementation()!
  f.evaluate.mockImplementation(async request=>{const response=await original(request);pending=true;return response})
  const {result}=await runHost(f,undefined,{turnInbox:{peek:()=>({pending,steer:pending}),drain:()=>[]}})
  expect(result.records).toEqual([]);expect(f.list).not.toHaveBeenCalled()
 })
 it('declines approval-resume contexts before inference or execution',async()=>{
  const f=setup();const {result}=await runHost(f,undefined,{resumeContext:{approvalId:'fictional-approval',suspendedToolName:f.tool.name,loopStepIndex:2} as never})
  expect(result.records).toEqual([]);expect(f.evaluate).not.toHaveBeenCalled();expect(f.list).not.toHaveBeenCalled()
 })
 it('blocks provider tool calls even if a composer emits a remembered tool name',async()=>{
  const f=setup();f.stream.mockImplementation(async function*(){
   yield{type:'tool_use_start' as const,id:'unsolicited',name:f.tool.name} as never
   yield{type:'tool_use_delta' as const,id:'unsolicited',input:JSON.stringify({...range,calendarId:'other-calendar'})} as never
   yield{type:'tool_use_end' as const,id:'unsolicited'} as never
   yield{type:'message_end',stopReason:'tool_use',usage:{inputTokens:1,outputTokens:1}} as never
  })
  const events:QueryEvent[]=[]
  for await(const event of queryLoop({provider:f.provider,model:'fixture',systemPrompt:'Read only the planned scope.',messages:f.input.messages,tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,routineCalendarRead:f.config,maxTurns:1}))events.push(event)
  expect(f.list).toHaveBeenCalledOnce()
  expect(JSON.stringify(events)).toContain('Unknown tool')
 })
 it.each(['timeout','abort'] as const)('never starts Calendar I/O after a delayed dispatch proof outlives %s',async kind=>{
  const f=setup({extra:{timeoutMs:15}})
  let release!:()=>void,started!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{started=resolve})
  const running=runHost(f,event=>{if(event.type==='tool_input')f.full.mockImplementation(async()=>{started();await gate})})
  const outcome=running.then(value=>({value}),error=>({error}))
  await entered
  if(kind==='abort')f.controller.abort(new Error('Fictional stopped turn'))
  else await new Promise(resolve=>setTimeout(resolve,30))
  release()
  const settled=await outcome
  if('value' in settled)expect(settled.value.result.complete).toBe(false)
  else expect(settled.error).toBeInstanceOf(Error)
  await Promise.resolve();await Promise.resolve()
  expect(f.list).not.toHaveBeenCalled()
 })
 it('fences steering queued between the async dispatch proof and physical Calendar continuation',async()=>{
  const f=setup();let proofDone=false,queued=false,pending=false
  const {result}=await runHost(f,event=>{if(event.type==='tool_input')f.full.mockImplementation(async()=>{proofDone=true})},
   {turnInbox:{peek:()=>{
    if(proofDone&&!queued){queued=true;queueMicrotask(()=>{pending=true})}
    return{pending,steer:pending}
   },drain:()=>[]}})
  expect(f.list).not.toHaveBeenCalled();expect(result.complete).toBe(false)
 })
 it('rejects an unforwarded context clone instead of silently losing active dispatch admission',async()=>{
  const f=setup(),execute=f.canonical.execute
  const clone=inheritRoutineCalendarRead(f.canonical,{...f.canonical,execute:(args,context)=>execute(args,{...context})})
  f.tools.set(clone.name,clone)
  await expect(runHost(f)).rejects.toMatchObject({reason:'authority_changed'})
  expect(f.list).not.toHaveBeenCalled()
 })
 it('closes pending dispatch when the consumer returns during a second host call',async()=>{
  const f=setup({choose:()=> 'all_concrete'})
  f.input.messages.push({role:'assistant',content:[{type:'tool_use',id:'other',name:f.tool.name,input:{...range,calendarId:'second-fictional-calendar'}}]},
    {role:'user',content:[{type:'tool_result',toolUseId:'other',name:f.tool.name,content:'[]'}]})
  let entered!:()=>void,release!:()=>void
  const started=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
  const options={provider:f.provider,model:'fixture',systemPrompt:f.input.systemPrompt,messages:f.input.messages,tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,routineCalendarRead:f.config,maxTurns:1}
  const iterator=executeRoutineCalendarRead({options,tools:f.tools,loopDetector:createLoopDetector({hardLimit:10}),deniedTools:new Set(),ledger:NOOP_TURN_LEDGER.startTrace({actor:'assistant_turn',model:'fixture',systemPrompt:'',messages:[]}),assertInputAuthority:f.full})
  expect((await iterator.next()).value).toMatchObject({type:'tool_start'})
  expect((await iterator.next()).value).toMatchObject({type:'tool_input'})
  f.full.mockImplementation(async()=>{entered();await gate})
  expect((await iterator.next()).value).toMatchObject({type:'tool_start'})
  await started
  await iterator.return({messages:[],complete:false,records:[],calls:0})
  release();await new Promise(resolve=>setTimeout(resolve,10))
  expect(f.list).not.toHaveBeenCalled()
 })
 it('performs one main composition after fresh reads and removes execution tools as well as schemas',async()=>{
  const f=setup(),events:QueryEvent[]=[]
  for await(const event of queryLoop({provider:f.provider,model:'fixture',systemPrompt:f.input.systemPrompt,messages:f.input.messages,tools:f.tools,context:f.context,ledger:NOOP_TURN_LEDGER,routineCalendarRead:f.config,maxTurns:1}))events.push(event)
  expect(f.list).toHaveBeenCalledOnce();expect(f.stream).toHaveBeenCalledOnce()
  expect(f.provider.createSession).toHaveBeenCalledWith(expect.objectContaining({tools:undefined}))
  expect(JSON.stringify(f.stream.mock.calls)).toContain('Host-executed read observation')
  expect(events.some(event=>event.type==='assistant_turn')).toBe(true)
 })
})
