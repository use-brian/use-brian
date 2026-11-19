import {AsyncLocalStorage} from 'node:async_hooks'
import type {Tool,ToolContext} from '@use-brian/agent-runtime/tools/types.js'

/** Host activator result for a lazily certified adapter. Never source permission. */
export type RoutineCalendarActivation={status:'ready';tool:Tool}|{status:'unavailable';reason?:string}
type LazyActivation={activate:(context:ToolContext)=>Promise<RoutineCalendarActivation>;origin?:Tool;pending?:Promise<RoutineCalendarActivation>}
// These identities certify an adapter's implementation, never source permission.
// A root is either a canonical read (its own origin) or a lazily activated
// adapter whose canonical origin is fixed only by its activation; every
// wrapper derives from its parent, so the origin is always read at the root.
const owners=new WeakMap<Tool,{origin?:Tool;lazy?:LazyActivation;execute:Tool['execute'];schema:Tool['inputSchema'];parent?:Tool}>()
export function registerCanonicalCalendarRead(tool:Tool):Tool {
 owners.set(tool,{origin:tool,execute:tool.execute,schema:tool.inputSchema});return tool
}
/**
 * Certify a host read adapter whose canonical Calendar read is not activated
 * yet (M3 late activation). `activate` must resolve, inside the turn's
 * current authority, to exactly the activated canonical read this adapter
 * dispatches to; `activateRoutineCalendarRead` verifies the result and the
 * dispatch fences require that origin.
 */
export function registerLazyCanonicalCalendarRead(tool:Tool,activate:LazyActivation['activate']):Tool {
 if(owners.has(tool))throw new Error('Routine read adapter is already certified')
 owners.set(tool,{lazy:{activate},execute:tool.execute,schema:tool.inputSchema});return tool
}
export function ownsRoutineCalendarRead(tool:Tool):boolean {
 const entry=owners.get(tool)
 return !!entry && tool.execute===entry.execute && tool.inputSchema===entry.schema
  && (!entry.parent || ownsRoutineCalendarRead(entry.parent))
}
function rootOf(tool:Tool){
 let entry=owners.get(tool)
 while(entry?.parent)entry=owners.get(entry.parent)
 return entry
}
/** The canonical read this certified adapter dispatches to; undefined until a lazy adapter activates. */
function originOf(tool:Tool):Tool|undefined{const root=rootOf(tool);return root?.origin??root?.lazy?.origin}
/** True when a certified adapter still needs its late activation before dispatch. */
export function routineCalendarReadNeedsActivation(tool:Tool):boolean {
 return ownsRoutineCalendarRead(tool)&&originOf(tool)===undefined
}
function adapterChanged():never{throw Object.assign(new Error('Routine read adapter changed'),{reason:'authority_changed',retrySafe:false})}
/**
 * Late activation of a certified adapter (M3). An eagerly certified adapter
 * is already activated. A lazy one runs its host activator once; the result
 * must be an owned, activated, read-only canonical read with the adapter's
 * name, and its origin becomes the adapter's dispatch origin. An unusable
 * result is `unavailable` (`not_canonical`); activator errors propagate.
 */
export async function activateRoutineCalendarRead(tool:Tool,context:ToolContext):Promise<RoutineCalendarActivation>{
 if(!ownsRoutineCalendarRead(tool))adapterChanged()
 const root=rootOf(tool)!,lazy=root.lazy
 if(!lazy)return{status:'ready',tool:root.origin!}
 const pending=lazy.pending??=lazy.activate(context).finally(()=>{if(lazy.pending===pending)lazy.pending=undefined})
 const outcome=await pending
 if(!ownsRoutineCalendarRead(tool)||rootOf(tool)!==root)adapterChanged()
 if(outcome.status!=='ready')return outcome
 const activated=outcome.tool,origin=originOf(activated)
 if(!origin||!ownsRoutineCalendarRead(activated)||rootOf(activated)?.lazy||activated.name!==tool.name||!activated.isReadOnly||activated.hiddenFromModel)
  return{status:'unavailable',reason:'not_canonical'}
 if(lazy.origin&&lazy.origin!==origin)adapterChanged()
 lazy.origin=origin
 return{status:'ready',tool:activated}
}
export function inheritRoutineCalendarRead(source:Tool,target:Tool):Tool {
 if(source!==target&&ownsRoutineCalendarRead(source))owners.set(target,{execute:target.execute,schema:target.inputSchema,parent:source})
 return target
}
type Dispatch={origin:Tool;check:()=>Promise<void>;current:()=>void;signal:AbortSignal;token:object}
const dispatches=new WeakMap<ToolContext,Dispatch>()
const activeDispatch=new AsyncLocalStorage<object>()
function dispatchEntry(context:ToolContext):Dispatch|undefined{
 const entry=dispatches.get(context),token=activeDispatch.getStore()
 if(!entry&&!token)return undefined
 if(!entry||!token||entry.token!==token)throw Object.assign(new Error('Routine read context was not forwarded'),{reason:'authority_changed',retrySafe:false})
 return entry
}
export async function withRoutineCalendarDispatch<T>(tool:Tool,context:ToolContext,check:()=>Promise<void>,current:()=>void,operation:()=>Promise<T>):Promise<T>{
 if(!ownsRoutineCalendarRead(tool))adapterChanged()
 // A lazily certified adapter dispatches only after its late activation fixed the origin.
 const origin=originOf(tool)
 if(!origin)throw Object.assign(new Error('Routine read adapter was not activated'),{reason:'authority_changed',retrySafe:false})
 const entry={origin,check,current,signal:context.abortSignal,token:{}}
 if(dispatches.has(context))throw new Error('Routine read invocation already active')
 dispatches.set(context,entry)
 try{return await activeDispatch.run(entry.token,operation)}finally{dispatches.delete(context)}
}
/** Called by the canonical Calendar implementation after inner approvals. */
export function assertRoutineCalendarDispatch(tool:Tool,context:ToolContext):Promise<()=>void>|undefined{
 const entry=dispatchEntry(context)
 if(!entry)return
 if(entry.origin!==tool||!ownsRoutineCalendarRead(tool))throw Object.assign(new Error('Routine read adapter changed'),{reason:'authority_changed',retrySafe:false})
 const fence=()=>{
  if(entry.signal.aborted)throw entry.signal.reason instanceof Error?entry.signal.reason:new Error('Routine read dispatch aborted')
  if(dispatches.get(context)!==entry||context.abortSignal!==entry.signal||!ownsRoutineCalendarRead(tool))throw Object.assign(new Error('Routine read dispatch changed or aborted'),{reason:'authority_changed',retrySafe:false})
  entry.current()
 }
 fence()
 return entry.check().then(()=>{fence();return fence})
}

/** Synchronous fence at the local dispatcher after its approval await. */
export function assertRoutineCalendarAdapterCurrent(context:ToolContext,tool:Tool):void{
 const entry=dispatchEntry(context)
 if(entry && (!ownsRoutineCalendarRead(tool)||originOf(tool)!==entry.origin))throw Object.assign(new Error('Routine read adapter changed'),{reason:'authority_changed',retrySafe:false})
}

/** Only the audited access wrapper may derive a context inside this invocation. */
export async function withRoutineCalendarContext<T>(parent:ToolContext,child:ToolContext,operation:()=>Promise<T>):Promise<T>{
 const entry=dispatchEntry(parent)
 if(!entry)return operation()
 const keys=['executionContext','authority','scopeAccumulator','abortSignal','admitModelInput','userId','assistantId','workspaceId','sessionId','channelId','channelType'] as const
 const captured=keys.map(key=>[key,parent[key]] as const)
 const current=()=>{
  if(dispatches.get(parent)!==entry||captured.some(([key,value])=>parent[key]!==value||child[key]!==value))throw Object.assign(new Error('Routine read derived context changed'),{reason:'authority_changed',retrySafe:false})
  entry.current()
 }
 current()
 if(dispatches.has(child))throw new Error('Routine read derived context already active')
 dispatches.set(child,{...entry,current})
 try{return await operation()}finally{dispatches.delete(child)}
}
