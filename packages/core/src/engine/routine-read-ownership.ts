import {AsyncLocalStorage} from 'node:async_hooks'
import type {Tool,ToolContext} from '../tools/types.js'

// These identities certify an adapter's implementation, never source permission.
const owners=new WeakMap<Tool,{origin:Tool;execute:Tool['execute'];schema:Tool['inputSchema'];parent?:Tool}>()
export function registerCanonicalCalendarRead(tool:Tool):Tool {
 owners.set(tool,{origin:tool,execute:tool.execute,schema:tool.inputSchema});return tool
}
export function ownsRoutineCalendarRead(tool:Tool):boolean {
 const entry=owners.get(tool)
 return !!entry && tool.execute===entry.execute && tool.inputSchema===entry.schema
  && (!entry.parent || ownsRoutineCalendarRead(entry.parent))
}
export function inheritRoutineCalendarRead(source:Tool,target:Tool):Tool {
 if(source!==target&&ownsRoutineCalendarRead(source))owners.set(target,{origin:owners.get(source)!.origin,execute:target.execute,schema:target.inputSchema,parent:source})
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
 if(!ownsRoutineCalendarRead(tool))throw Object.assign(new Error('Routine read adapter changed'),{reason:'authority_changed',retrySafe:false})
 const entry={origin:owners.get(tool)!.origin,check,current,signal:context.abortSignal,token:{}}
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
 if(entry && (!ownsRoutineCalendarRead(tool)||owners.get(tool)!.origin!==entry.origin))throw Object.assign(new Error('Routine read adapter changed'),{reason:'authority_changed',retrySafe:false})
}

/** Only the audited access wrapper may derive a context inside this invocation. */
export async function withRoutineCalendarContext<T>(parent:ToolContext,child:ToolContext,operation:()=>Promise<T>):Promise<T>{
 const entry=dispatchEntry(parent)
 if(!entry)return operation()
 const keys=['executionContext','authority','scopeAccumulator','abortSignal','assertModelInputAuthority','userId','assistantId','workspaceId','sessionId','channelId','channelType'] as const
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
