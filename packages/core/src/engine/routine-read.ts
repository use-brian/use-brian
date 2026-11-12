import { decisionUsageModelId } from '../decisions/usage.js'
import {ownsRoutineCalendarRead,withRoutineCalendarDispatch} from './routine-read-ownership.js'
import {renderHostObservation,type HostObservation} from '@use-brian/shared'
import {createToolExecutor} from './tool-executor.js'
import type {QueryEvent,QueryLoopOptions} from './query-loop.js'
import {DEFAULT_HARD_LIMIT,type LoopDetector} from './loop-detector.js'
import {safeTrace,type TurnTrace} from './turn-ledger.js'
import {z} from 'zod'
import {randomUUID} from 'node:crypto'
import {createLlmDecisionProvider,buildLlmDecisionMessages} from '../decisions/adapters/llm.js'
import {captureClassifierDecisionRuntime,registerClassifierLlmCompletion,consumeClassifierCapacityDeferral} from '../decisions/authority-ownership.js'
import {decisionCompletionInput} from '../decisions/invocation.js'
import type {DecisionExecutionPort,DecisionCompletionRoute,DecisionExecutionOperation} from '../decisions/hydra.js'
import type {DecisionResponse,DecisionQuestion} from '../decisions/types.js'
import {TYPESAFE_JEV_CAPABILITIES} from '../decisions/adapters/typesafe.js'
import type {Message,TokenUsage} from '../providers/types.js'
import {isInputAuthorityError,assertInputAuthority,ownsInputAdmission} from '../providers/input-authority.js'
import {estimateStringTokens} from '../compaction/index.js'
import {fitMessagesToBudget,resolveInputTokenLimit,MODEL_CONTEXT_FIT_RATIO,MAX_TOOL_RESULT_TOKENS} from '../providers/context-budget.js'
import type {Tool,ToolContext} from '../tools/types.js'

export type RoutineCalendarCall={name:string;input:{calendarId:string;timeMin:string;timeMax:string;maxResults:number}}
type Candidate={calls:RoutineCalendarCall[]}
type ScopeVocabulary={targets:Array<{id:string;name:string;calendarId:string}>;ranges:Array<{id:string;timeMin:string;timeMax:string;labels:string[]}>;reason?:string}
const planData=new WeakMap<object,{calls:RoutineCalendarCall[];current:()=>void}>()
type RoutineReadPlan=Readonly<{kind:'calendar_events'}>
export type RoutineReadPlanningResult={usedRequestedLlm?:boolean;plan:RoutineReadPlan|null;durationMs:number;model:string|null;usage:TokenUsage|null;path:string;scopeCounts?:{targets:number;ranges:number;questions:number};inputCounts?:Record<string,number>}
const iso=z.string().datetime({offset:true})
const callInput=z.object({calendarId:z.string().min(1).max(1024),timeMin:iso,timeMax:iso,maxResults:z.number().int().min(1).max(2500)}).strict()

function unavailable():never{throw Object.assign(new Error('The routine read context changed.'),{reason:'authority_changed',retrySafe:false})}

/** Find actual instant boundaries of the current civil day, including DST. */
function localDayRange(now:number,timeZone:string):{timeMin:string;timeMax:string}|null{
 try{
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'})
  const key=(instant:number)=>formatter.format(new Date(instant)),today=key(now),margin=2*86400_000
  if(key(now-margin)===today||key(now+margin)===today)return null
  let left=now-margin,right=now
  while(right-left>1){const middle=Math.floor((left+right)/2);if(key(middle)===today)right=middle;else left=middle}
  const start=right;left=now;right=now+margin
  while(right-left>1){const middle=Math.floor((left+right)/2);if(key(middle)===today)left=middle;else right=middle}
  if(key(start)!==today||key(start-1)===today||key(right-1)!==today||key(right)===today)return null
  return{timeMin:new Date(start).toISOString(),timeMax:new Date(right).toISOString()}
 }catch{return null}
}

/** Data vocabulary only. Historical success is not current source permission. */
function scopeVocabularyFor(messages:Message[],names:string[],now:number,history:readonly RoutineCalendarCall[]=[],timeZone='UTC'):ScopeVocabulary{
 const targets=new Map<string,{name:string;calendarId:string}>(),ranges=new Map<string,{timeMin:string;timeMax:string;labels:string[]}>()
 const result=(reason?:string):ScopeVocabulary=>({targets:[...targets.values()].map((target,index)=>({id:`target_${index}`,...target})),
  ranges:[...ranges.values()].map((range,index)=>({id:`range_${index}`,...range})),...(reason?{reason}:{})})
 const successes=new Set<string>(),uses:Array<{id:string;name:string;input:Record<string,unknown>}>=[]
 for(const message of messages){
  if(typeof message.content==='string')continue
  for(const block of message.content){
   if(block.type==='image')return result('unsupported_multimodal')
   if(block.type==='tool_result'&&!block.isError)successes.add(block.toolUseId)
   if(block.type==='tool_use'){
    if(names.includes(block.name))uses.push(block)
    else if(block.name==='mcp_call'&&block.input.server==='gcal'&&typeof block.input.tool==='string'&&names.includes(block.input.tool)
     &&block.input.args&&typeof block.input.args==='object'&&!Array.isArray(block.input.args)){
     uses.push({id:block.id,name:block.input.tool,input:block.input.args as Record<string,unknown>})
    }
   }
  }
 }
 for(const [index,call] of history.entries())if(names.includes(call.name)){const id=`history_${index}`;successes.add(id);uses.push({id,name:call.name,input:call.input})}
 const addRange=(timeMin:string,timeMax:string,label:string)=>{
  const start=Date.parse(timeMin),end=Date.parse(timeMax)
  if(!iso.safeParse(timeMin).success||!iso.safeParse(timeMax).success||end<=start||end-start>366*86400_000)return
  const key=timeMin+'\n'+timeMax,existing=ranges.get(key)
  if(existing){if(!existing.labels.includes(label))existing.labels.push(label)}else ranges.set(key,{timeMin,timeMax,labels:[label]})
 }
 for(const name of names)targets.set(name+'\nprimary',{name,calendarId:'primary'})
 for(const use of uses){
  if(!successes.has(use.id))continue
  const calendarId=use.input.calendarId??'primary'
  if(typeof calendarId!=='string'||!calendarId||calendarId.length>1024)continue
  targets.set(use.name+'\n'+calendarId,{name:use.name,calendarId})
  if(typeof use.input.timeMin==='string'&&typeof use.input.timeMax==='string')addRange(use.input.timeMin,use.input.timeMax,'Historical exact window')
 }
 // Preserve every historical target; too many choices means ordinary planning,
 // never silently dropping an account/calendar from the model's vocabulary.
 if(!targets.size)return result('scope_no_targets')
 if(targets.size+2>TYPESAFE_JEV_CAPABILITIES.maxQuestions)return result('scope_question_limit')
 const historical=[...ranges.values()]
 const current=new Date(now).toISOString(),day=localDayRange(now,timeZone)
 if(!day)return result('scope_timezone')
 addRange(day.timeMin,day.timeMax,`Current local day (${timeZone})`)
 addRange(current,day.timeMax,`Remainder of today (${timeZone})`)
 addRange(current,new Date(now+7*86400_000).toISOString(),'Next 7 days from now')
 addRange(current,new Date(now+30*86400_000).toISOString(),'Next 30 days from now')
 // Existing explicit endpoints remain selectable. A contiguous union permits
 // one bounded read instead of fishing through successive date partitions.
 const old=historical
 if(old.length){
  const start=old.reduce((a,b)=>Date.parse(a.timeMin)<Date.parse(b.timeMin)?a:b).timeMin
  const end=old.reduce((a,b)=>Date.parse(a.timeMax)>Date.parse(b.timeMax)?a:b).timeMax
  addRange(start,end,'Contiguous union of historical windows')
  for(const range of old)if(Date.parse(range.timeMax)>now)addRange(current,range.timeMax,'Now to a historical window end')
 }
 if(ranges.size+1>TYPESAFE_JEV_CAPABILITIES.maxOptions)return result('scope_option_limit')
 return result()
}

/** Full prepared-context inference. No decision result is an execution grant. */
export async function planRoutineCalendarRead(input:{runtime:DecisionExecutionPort;llm:DecisionCompletionRoute;workspaceId?:string;
 systemPrompt:string;messages:Message[];tools:ReadonlyMap<string,Tool>;calendarTools:ReadonlyMap<string,Tool>;
 context:ToolContext;assertInputAuthority:()=>Promise<void>;now?:number;historyCalls?:readonly RoutineCalendarCall[]}):Promise<RoutineReadPlanningResult>{
 const started=Date.now(),empty=(path:string):RoutineReadPlanningResult=>({plan:null,durationMs:Date.now()-started,model:null,usage:null,path})
 const context=input.context,execution=context.executionContext,authority=context.authority,assertCurrent=authority?.assertCurrent
 const scope=context.scopeAccumulator,signal=context.abortSignal,full=input.assertInputAuthority
 const sourceHook=context.assertModelInputAuthority,executeAuthority=authority?.execute,timeZone=context.userTimezone,planningNow=input.now??started
 if(!execution||!authority||!assertCurrent||!scope||signal.aborted)return empty('unowned')
 const tools=new Map(input.calendarTools),methods=new Map([...tools].map(([name,tool])=>[name,{...tool}]))
 if(!tools.size||[...tools].some(([name,tool])=>input.tools.get(name)!==tool||!tool.isReadOnly||!ownsRoutineCalendarRead(tool)||tool.hiddenFromModel))return empty('unavailable_tools')
 const snapshot=structuredClone({systemPrompt:input.systemPrompt,messages:input.messages})
 const vocabulary=scopeVocabularyFor(snapshot.messages,[...tools.keys()],planningNow,structuredClone(input.historyCalls??[]),timeZone??'UTC')
 const scopeCounts={targets:vocabulary.targets.length,ranges:vocabulary.ranges.length,questions:vocabulary.targets.length+2}
 if(vocabulary.reason)return{...empty(vocabulary.reason),scopeCounts}
 const {targets,ranges}=vocabulary
 const state={...snapshot,now:new Date(planningNow).toISOString(),timeZone:timeZone??'UTC',
  tools:[...tools.values()].map(tool=>({name:tool.name,description:tool.description})),targets,ranges}
 const originalMessages=JSON.stringify(input.messages),originalHistory=JSON.stringify(input.historyCalls??[]),originalToolCount=input.tools.size
 const originalCeiling=JSON.stringify(execution.security.ceiling),originalProvenance=JSON.stringify(execution.security.provenance)
 const sourceKeys=()=>new Set((scope.evidence.sources??[]).map(source=>JSON.stringify([source.workspaceId,source.resourceKind,source.resourceId,source.version])))
 const originalSources=sourceKeys()
 const current=()=>{
  if(JSON.stringify(input.messages)!==originalMessages||JSON.stringify(input.historyCalls??[])!==originalHistory||input.tools.size!==originalToolCount
   ||context.assertModelInputAuthority!==sourceHook||context.userTimezone!==timeZone||authority.execute!==executeAuthority
   ||context.executionContext!==execution||context.authority!==authority||authority.assertCurrent!==assertCurrent||execution.security.authority!==authority||context.scopeAccumulator!==scope
   ||context.abortSignal!==signal||signal.aborted||execution.lifecycle.abortSignal.aborted
   ||JSON.stringify(execution.security.ceiling)!==originalCeiling||JSON.stringify(execution.security.provenance)!==originalProvenance
   ||[...originalSources].some(key=>!sourceKeys().has(key))
   ||[...tools].some(([name,tool])=>input.tools.get(name)!==tool||input.calendarTools.get(name)!==tool||!ownsRoutineCalendarRead(tool)||Object.entries(methods.get(name)!).some(([key,value])=>(tool as unknown as Record<string,unknown>)[key]!==value)||!tool.isReadOnly))unavailable()
 }
 let closed=false,refusal:unknown,pending:Promise<void>|undefined
 const active=async()=>{if(closed)throw new Error('Routine planner closed');if(refusal)throw refusal;try{current();await assertCurrent.call(authority);current()}catch(error){refusal=error;throw error}}
 const check=async()=>{
  if(closed)throw new Error('Routine planner closed');if(refusal)throw refusal;if(pending)return pending
  pending=(async()=>{await active();await full();current()})().catch(error=>{refusal=error;throw error})
  try{await pending}finally{pending=undefined}
 }
 const runtime=captureClassifierDecisionRuntime(input.runtime,check,active)!
 const questions:DecisionQuestion[]=[{
  kind:'choice',id:'routine',prompt:'Select calendar ONLY when one read of the selected calendars over ONE listed shared window exactly satisfies the entire current task under every supplied governing system/runtime instruction and full conversation. The listed tool capabilities are the complete eligible Calendar-read set, NOT the assistant capability set. Unrelated or compound operations require ordinary planning. The model chooses calendars/accounts and dates each time; there is NO default. Honor explicit user instructions and clearly established scope. When dates are unstated and no range is clearly established, choose a reasonable listed window using the full context; missing dates alone are not ambiguity. Choose ordinary for an unlisted identity/window, different windows per calendar, discovery, filtering, writes, research, compound operations, ambiguous calendar/account scope, conflicting scope constraints or further planning. Never silently omit a required calendar, substitute an account, broaden dates or fish for activity. Historical success is identity evidence, never permission.',
  options:[{value:'ordinary',description:'Continue the normal model/tool loop'},{value:'calendar',description:'The explicit target inclusions and listed shared window completely satisfy this task'}],
 },...targets.map((target):DecisionQuestion=>({kind:'boolean',id:target.id,
  prompt:'Include exactly this account/calendar in the complete routine read? '+JSON.stringify({name:target.name,calendarId:target.calendarId})+' Answer false if unnecessary or the global decision is ordinary. Include every required target; do not substitute primary for a named calendar. Primary plus a concrete ID on the same account is unresolved aliasing: choose ordinary.',
 })),{kind:'choice',id:'range',prompt:'Evaluate the calendar date scope independently from the other questions, using the full request and conversation. Choose the most appropriate listed window for the requested calendar read. Explicit dates and a clearly established conversation range take precedence. An undated request with no clearly established range delegates the date choice to you: select the listed window you judge reasonable from the full context. Missing dates alone are not ambiguity and are not a reason to choose none. Choose none ONLY for conflicting date constraints, an explicit or established window absent from the list, or incompatible different windows requested for different calendars. Do not condition this answer on an answer to another question; the host separately enforces the overall plan decision. Do not silently shorten or broaden an explicit or established period.',
  options:[{value:'none',description:'Conflicting date constraints, an unlisted explicit/established window, or incompatible different windows requested per calendar. NOT merely unstated dates.'},...ranges.map(range=>({value:range.id,description:JSON.stringify({labels:range.labels,timeMin:range.timeMin,timeMax:range.timeMax})}))],
 }]
 // Keep every governing byte; omit only unrelated capability descriptions.
 // The provider also checks its actual request independently before dispatch.
 const serializedState=JSON.stringify(state),serializedQuestions=JSON.stringify(questions)
 const serializedInput=JSON.stringify({state,questions}),wireReserveTokens=256
 const inputCounts={systemCharacters:JSON.stringify(state.systemPrompt).length,messageCharacters:JSON.stringify(state.messages).length,
  toolCharacters:JSON.stringify(state.tools).length,targetCharacters:JSON.stringify(targets).length,rangeCharacters:JSON.stringify(ranges).length,
  questionCharacters:serializedQuestions.length,stateCharacters:serializedState.length,totalCharacters:serializedInput.length,
  toolCount:state.tools.length,messageCount:state.messages.length,wireReserveTokens,
  estimatedTokens:estimateStringTokens(serializedInput)+wireReserveTokens,adapterEstimatedTokens:Math.ceil(serializedInput.length/4),
  maxEstimatedTokens:50_000,providerMaxInputTokens:TYPESAFE_JEV_CAPABILITIES.maxInputTokens}
 if(inputCounts.estimatedTokens>inputCounts.maxEstimatedTokens||inputCounts.adapterEstimatedTokens+wireReserveTokens>inputCounts.providerMaxInputTokens)
  return{...empty('context_limit'),scopeCounts,inputCounts}
 const decodedPlans=new WeakMap<Candidate,{calls:RoutineCalendarCall[];bytes:string}>()
 const decode=(response:DecisionResponse):Candidate|null=>{
  if(response.answers.length!==questions.length)return null
  const answers=new Map(response.answers.map(answer=>[answer.questionId,answer]))
  if(answers.size!==questions.length)return null
  for(const question of questions){
   const answer=answers.get(question.id)
   if(!answer||answer.kind!==question.kind)return null
   if(question.kind==='boolean'&&(answer.kind!=='boolean'||typeof answer.value!=='boolean'))return null
   if(question.kind==='choice'&&(answer.kind!=='choice'||!question.options.some(option=>option.value===answer.value)))return null
  }
  const routine=answers.get('routine'),rangeAnswer=answers.get('range')
  if(routine?.kind!=='choice'||routine.value!=='calendar'||rangeAnswer?.kind!=='choice')return null
  const range=ranges.find(value=>value.id===rangeAnswer.value)
  const selected=targets.filter(target=>{const answer=answers.get(target.id);return answer?.kind==='boolean'&&answer.value})
  if(!range||!selected.length||selected.some(target=>target.calendarId==='primary'&&selected.some(other=>other.name===target.name&&other.calendarId!=='primary')))return null
  const result={calls:selected.map(target=>({name:target.name,input:{calendarId:target.calendarId,timeMin:range.timeMin,timeMax:range.timeMax,maxResults:2500}}))}
  decodedPlans.set(result,{calls:structuredClone(result.calls),bytes:JSON.stringify(result.calls)});return result
 }
 const validatePlan=(result:Candidate|null)=>{
  if(result===null)return result
  const snapshot=decodedPlans.get(result)
  if(!snapshot||snapshot.bytes!==JSON.stringify(result.calls))throw new Error('Unbound routine plan')
  if(!Array.isArray(result.calls)||!result.calls.length||new Set(result.calls.map(call=>call.name+'\n'+call.input.calendarId)).size!==result.calls.length)throw new Error('Invalid routine plan')
  const first=result.calls[0].input
  if(!ranges.some(range=>range.timeMin===first.timeMin&&range.timeMax===first.timeMax))throw new Error('Invalid routine window')
  for(const call of result.calls){callInput.parse(call.input);if(call.input.maxResults!==2500||call.input.timeMin!==first.timeMin||call.input.timeMax!==first.timeMax||!targets.some(target=>target.name===call.name&&target.calendarId===call.input.calendarId))throw new Error('Invalid routine target')}
  if(result.calls.some(call=>call.input.calendarId==='primary'&&result.calls.some(other=>other.name===call.name&&other.input.calendarId!=='primary')))throw new Error('Ambiguous routine target')
  return result
 }
 let usage:TokenUsage|null=null,model:string|null=null
 try{
  await active()
  const operation=registerClassifierLlmCompletion<DecisionExecutionOperation<Candidate|null>>({assertInputAuthority:check,decide:response=>({kind:'complete',result:decode(response)}),
    validateResult:validatePlan,safeFailure:()=>null,
    async completeWithLlm(completion){
     const response=await createLlmDecisionProvider({provider:completion.llm.provider}).evaluate({...completion.request,
      model:{catalogId:completion.llm.modelId,wireId:completion.llm.modelId},...decisionCompletionInput(completion,{signal,assertInputAuthority:check})})
     usage=response.usage??null;model=response.model.wireId
     return{result:decode(response),providerId:response.providerId,model:response.model,usage:response.usage}
    }},(route,request)=>ownsInputAdmission(route.provider,{
     model:route.modelId,messages:buildLlmDecisionMessages(request),allowProviderFallback:false,
    }),{inputCapacityFallback:true})
  const result=await runtime.run<Candidate|null>({workspaceId:input.workspaceId,llm:input.llm,request:{runId:randomUUID(),
   operation:{id:'chat.tool-selection',version:'3',stateVersion:'3',questionVersion:'3'},state:JSON.parse(JSON.stringify(state)),signal,questions},operation})
  if(consumeClassifierCapacityDeferral(operation,result)){
   await active();current();closed=true
   return{...empty('capacity_deferred'),scopeCounts,inputCounts}
  }
  // Capture the private model-selected bytes before the final authority await.
  // A runtime hook cannot replace or mutate its returned object into new scope.
  const selected=validatePlan(result.result)
  const selectedCalls=selected?structuredClone(decodedPlans.get(selected)!.calls):null
  await check();current()
  if(!selectedCalls)return{...empty(result.path),usedRequestedLlm:result.usedRequestedLlm,scopeCounts,inputCounts,model:model??(result.primaryResponse?decisionUsageModelId(result.primaryResponse.model):null),usage}
  const calls=selectedCalls
  const plan:RoutineReadPlan=Object.freeze({kind:'calendar_events'})
  planData.set(plan,{calls,current})
  return{plan,durationMs:Date.now()-started,model:model??(result.primaryResponse?decisionUsageModelId(result.primaryResponse.model):null),usage,path:result.path,usedRequestedLlm:result.usedRequestedLlm,scopeCounts,inputCounts}
 }catch(error){if(refusal)throw refusal;if(isInputAuthorityError(error)||signal.aborted)throw error;return{...empty('unavailable'),scopeCounts,inputCounts}}
 finally{closed=true;if(pending)await pending}
}

/** Private plan identity and synchronous handoff; still no source permission. */
function consumeRoutineReadPlan(plan:RoutineReadPlan):{calls:RoutineCalendarCall[];current:()=>void}{
 const captured=planData.get(plan);if(!captured)unavailable()
 captured.current();planData.delete(plan)
 return{calls:structuredClone(captured.calls),current:captured.current}
}


export type RoutineReadOptions={runtime:DecisionExecutionPort;llm:DecisionCompletionRoute;workspaceId?:string;
 calendarTools:ReadonlyMap<string,Tool>;historyCalls?:readonly RoutineCalendarCall[];
 onResult?:(result:RoutineReadPlanningResult)=>void|Promise<void>}
export type HostReadReceipt=Readonly<{kind:'host_read'}>
const observations=new WeakMap<object,{execution:NonNullable<ToolContext['executionContext']>;values:HostObservation[]}>()
const authoredCarriers=new WeakMap<object,{execution:NonNullable<ToolContext['executionContext']>;bytes:string}>()
function bindCarrier(values:HostObservation[],execution:NonNullable<ToolContext['executionContext']>):HostObservation[]{
 authoredCarriers.set(values,{execution,bytes:JSON.stringify(values)});return values
}
export function assertHostObservationPublication(content:unknown,execution:NonNullable<ToolContext['executionContext']>):void{
 if(!Array.isArray(content)||!content.some(block=>block?.type==='host_observation'))return
 const authored=authoredCarriers.get(content)
 if(!authored||authored.execution!==execution||authored.bytes!==JSON.stringify(content))throw new Error('Host observations require an original executor carrier')
}
export function combineHostReadObservations(batches:readonly HostObservation[][],execution:NonNullable<ToolContext['executionContext']>):HostObservation[]{
 for(const batch of batches){const entry=authoredCarriers.get(batch);if(!entry||entry.execution!==execution||entry.bytes!==JSON.stringify(batch))throw new Error('Host observations require original executor batches')}
 return bindCarrier(structuredClone(batches.flat()),execution)
}
/** Authorship only: no allow decision or source permission is retained here. */
export function consumeHostReadObservation(receipt:HostReadReceipt,execution:NonNullable<ToolContext['executionContext']>):HostObservation[]{
 const entry=observations.get(receipt)
 if(!entry||entry.execution!==execution)unavailable()
 observations.delete(receipt)
 return bindCarrier(structuredClone(entry.values),execution)
}

/** Exact executor output, with first-page exhaustion and the executor's own cap. */
function isCompleteRoutineRead(call:RoutineCalendarCall,block:Extract<import('../providers/types.js').ContentBlock,{type:'tool_result'}>,meta:import('../tools/types.js').ToolResultMeta|undefined):boolean{
 return !block.isError && meta?.calendarReadComplete===true && meta.outputTruncated===false
  && meta.calendarReadCalendarId===call.input.calendarId && meta.calendarReadTimeMin===call.input.timeMin
  && meta.calendarReadTimeMax===call.input.timeMax && meta.calendarReadQuery===undefined && meta.calendarReadPageToken===undefined
}

/** Match both provider fitting passes; reserve full governing instructions too. */
function compositionFits(options:QueryLoopOptions,messages:Message[],reservedTokens=0):boolean{
 const limit=options.inputTokenLimit??resolveInputTokenLimit(options.model)
 const budget=Math.floor(Math.floor(limit*MODEL_CONTEXT_FIT_RATIO)/2)
  -estimateStringTokens(options.systemPrompt+'\n'+(options.runtimeSystemContext??''))-reservedTokens-4096
 return Number.isFinite(budget)&&budget>0&&!fitMessagesToBudget(messages,budget).trimmed
}

export async function* executeRoutineCalendarRead(input:{options:QueryLoopOptions;tools:Map<string,Tool>;loopDetector:LoopDetector;
 deniedTools:Set<string>;ledger:TurnTrace;assertInputAuthority:()=>Promise<void>}):AsyncGenerator<QueryEvent,{messages:Message[];complete:boolean;records:HostObservation[];calls:number}> {
 const {options,tools}=input,config=options.routineCalendarRead
 if(!config||options.resumeContext||options.turnInbox?.peek().pending)return{messages:[],complete:false,records:[],calls:0}
 const planned=await planRoutineCalendarRead({...config,systemPrompt:options.systemPrompt+'\n'+(options.runtimeSystemContext??''),
  messages:options.messages,tools,context:options.context,assertInputAuthority:input.assertInputAuthority})
 await config.onResult?.(planned)
 if(!planned.plan||options.turnInbox?.peek().pending)return{messages:[],complete:false,records:[],calls:0}
 const {calls,current}=consumeRoutineReadPlan(planned.plan),queued:QueryEvent[]=[]
 // JSON escaping can expand one input character to six characters. Reserve
 // the whole executor cap, never a guessed event count, before any read.
 const observationReserve=calls.reduce((total,call)=>total+6*MAX_TOOL_RESULT_TOKENS+estimateStringTokens(JSON.stringify(call))*2+1024,0)
 if(calls.length+input.loopDetector.totalToolCalls>=(options.maxToolCalls??DEFAULT_HARD_LIMIT)){
  console.debug('[routine-read] execution declined',{reason:'tool_budget',calls:calls.length});return{messages:[],complete:false,records:[],calls:0}
 }
 if(!compositionFits(options,options.messages,observationReserve)){
  console.debug('[routine-read] execution declined',{reason:'input_budget',calls:calls.length});return{messages:[],complete:false,records:[],calls:0}
 }
 let closed=false
 try{
 // Freeze dispatch methods now; async confirmations cannot replace the chosen adapter.
 const executionTools=new Map([...tools].map(([name,tool])=>{
  const execute=tool.execute
  const dispatchCurrent=()=>{if(closed)throw new Error('Routine read phase closed');current();if(options.turnInbox?.peek().pending)throw new Error('New chat input arrived before routine dispatch')}
  return[name,Object.freeze({...tool,execute:(args:unknown,context:ToolContext)=>withRoutineCalendarDispatch(tool,context,async()=>{
   dispatchCurrent();await assertInputAuthority(input.assertInputAuthority);dispatchCurrent()
  },dispatchCurrent,()=>execute.call(tool,args,context))})] as const
 }))
 const executor=createToolExecutor({tools:executionTools,context:options.context,loopDetector:input.loopDetector,deniedTools:input.deniedTools,
  confirmationResolver:options.confirmationResolver,confirmationTimeoutMs:options.confirmationTimeoutMs,
  onConfirmationRequired:request=>queued.push({type:'tool_confirmation_required',request}),
  onAwaitingApproval:event=>queued.push({type:'awaiting_approval',...event,loopStepIndex:byId.size})})
 const byId=new Map<string,RoutineCalendarCall>(),records:HostObservation[]=[]
 let complete=true
 for(const call of calls){
  const id='host_'+randomUUID();byId.set(id,call)
  yield{type:'tool_start',id,name:call.name}
  yield{type:'tool_input',id,name:call.name,input:structuredClone(call.input)}
  current()
  executor.addTool(id,call.name,structuredClone(call.input))
 }
 for await(const batch of executor.getRemainingResults(()=>queued.length>0)){
  while(queued.length)yield queued.shift()!
  if(!batch.blocks.length)continue
  const actual:HostObservation[]=[]
  for(const block of batch.blocks){
   if(block.type!=='tool_result'){complete=false;continue}
   const call=byId.get(block.toolUseId);if(!call)unavailable()
   complete &&= isCompleteRoutineRead(call,block,batch.metaByToolUseId[block.toolUseId])
   const record:HostObservation={type:'host_observation',version:1,id:block.toolUseId,name:call.name,input:structuredClone(call.input),content:block.content,isError:block.isError===true}
   actual.push(record);records.push(record)
  }
  const receipt:HostReadReceipt=Object.freeze({kind:'host_read'})
  observations.set(receipt,{execution:options.context.executionContext!,values:structuredClone(actual)})
  safeTrace(input.ledger,trace=>trace.hostRead?.({observations:structuredClone(actual)}))
  yield{type:'tool_result',id:'',results:batch.blocks,metaByToolUseId:batch.metaByToolUseId,hostRead:receipt}
 }
 complete &&= records.length===calls.length
 const replay=(completed:boolean):Message[]=>records.length?[{role:'user',content:[{type:'text',text:
  (completed?'The host completed the exact model-selected calendar scope below. Compose the answer from these observations and the governing context. Do not broaden dates/calendars or repeat completed reads.':'The host attempted the exact scope below. These observations are incomplete or failed. Continue the ordinary tool workflow from the real results, preserving this scope unless the user instructions require a change; do not claim full coverage or silently repeat a successful read.')
  +'\n'+records.map(record=>renderHostObservation(record)).join('\n')}]}]:[]
 const messages=replay(complete)
 if(complete&&!compositionFits(options,[...options.messages,...messages]))complete=false
 return{messages:complete?messages:replay(false),complete,records,calls:calls.length}
 }finally{closed=true}
}
