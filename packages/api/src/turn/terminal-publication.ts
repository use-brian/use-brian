/** Invocation-private terminal binding. No lifecycle, authority cache or public constructor. [COMP:api/native-turn-frame] */
import {outputContentDigest} from '@use-brian/agent-runtime/engine/output-provenance.js'
import type {FinalizedOutputSelection} from '@use-brian/agent-runtime/engine/turn-output.js'
import type {ExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {z} from 'zod'
import type {BufferedWebPublication} from '../db/conversation-publication-recovery.js'

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/)
const member=z.object({origin:uuid,revision:z.number().int().positive().max(2147483647),snapshotDigest:digest,
 contentDigest:digest,commandOrdinal:z.number().int().min(0).max(511)}).strict()
export const terminalDescriptorSchema=z.object({version:z.literal(1),disposition:z.literal('reply'),invocationId:uuid,
 projection:z.literal('persistable_response_v1'),formatter:z.literal('turn_output_v1'),format:z.enum(['compact','channel']),
 textDigest:digest,members:z.array(member).min(1).max(512)}).strict()
export type TerminalDescriptor=z.infer<typeof terminalDescriptorSchema>
const nativeMember=member.pick({origin:true,revision:true,commandOrdinal:true}).extend({kind:z.literal('session_message'),id:uuid,
 version:z.literal('1'),frameId:uuid,derivationId:uuid,sequence:z.number().int().positive(),payloadDigest:digest}).strict()
export const terminalPublicationResultSchema=z.object({operationId:uuid,commandDigest:digest,requestedStopped:z.boolean(),stopped:z.boolean(),
 terminalDescriptor:terminalDescriptorSchema.nullable(),terminalOutputs:z.array(nativeMember).min(1).max(512).nullable()}).strict()
type Result=z.infer<typeof terminalPublicationResultSchema>
type Message={role:string;content:unknown;senderAssistantId?:string|null}
export type BoundBufferedTerminalCommand=Readonly<{readonly terminalCommand:unique symbol}>
type OwnerState = { closed: boolean; disposition: 'pending' | 'committed' | 'stopped' }
type Binding={root:BufferedWebPublication;execution:ExecutionContext;rowsDigest:string;candidate:TerminalDescriptor|null;owner:OwnerState}
const bindings=new WeakMap<BoundBufferedTerminalCommand,Binding>()
function changed():never{throw new Error('Terminal publication binding changed')}

/** Called by the real kernel owner; the route receives only its methods. */
export function createTerminalPublicationOwner(token:string,signal:AbortSignal){
 const owner: OwnerState = { closed: false, disposition: 'pending' }
 const roots=new WeakMap<BufferedWebPublication,ExecutionContext>()
 let finalized:FinalizedOutputSelection|null=null
 return {
  bindRoot(root:BufferedWebPublication,execution:ExecutionContext){
   if(owner.closed||root.turnToken!==token||signal.aborted)changed()
   const prior=roots.get(root);if(prior&&prior!==execution)changed();roots.set(root,execution)
  },
  finalize(output:FinalizedOutputSelection|null){finalized=output&&!owner.closed&&!signal.aborted?structuredClone(output):null},
  bind(root:BufferedWebPublication,execution:ExecutionContext,rows:readonly Message[],ordinals:readonly number[]|null):BoundBufferedTerminalCommand{
   if(owner.closed||roots.get(root)!==execution||root.turnToken!==token)changed()
   let candidate:TerminalDescriptor|null=null
   if(finalized&&!signal.aborted&&ordinals&&ordinals.length===finalized.members.length&&ordinals.length>0&&rows.length<=512){
    const seen=new Set<number>();let previous=-1
    candidate=terminalDescriptorSchema.parse({version:1,disposition:'reply',invocationId:finalized.invocationId,
     projection:'persistable_response_v1',formatter:finalized.formatter,format:finalized.format,textDigest:finalized.textDigest,
     members:finalized.members.map((m,index)=>{
      const ordinal=ordinals[index]!,row=rows[ordinal]
      if(!Number.isInteger(ordinal)||ordinal<=previous||seen.has(ordinal)||row?.role!=='assistant'||row.senderAssistantId!==root.assistantId
       ||!Array.isArray(row.content)||row.content.some(block=>block?.type==='tool_use'||block?.type==='host_observation')
       ||outputContentDigest(row.content)!==m.contentDigest)changed()
      previous=ordinal;seen.add(ordinal)
      return{origin:m.origin,revision:m.revision,snapshotDigest:m.digest,contentDigest:m.contentDigest,commandOrdinal:ordinal}
     })})
   }
   const handle=Object.freeze({}) as BoundBufferedTerminalCommand
   bindings.set(handle,{root,execution,rowsDigest:outputContentDigest(rows),candidate,owner});return handle
  },
  isCommitted(){return owner.disposition==='committed'&&!signal.aborted},
  isStopped(){return owner.disposition==='stopped'},
  close(){owner.closed=true;finalized=null},
 }
}
export function bufferedTerminalCandidate(handle:BoundBufferedTerminalCommand,root:BufferedWebPublication,execution:ExecutionContext,rows:readonly Message[]):TerminalDescriptor|null{
 const b=bindings.get(handle)
 if(!b||b.owner.closed||b.root!==root||b.execution!==execution||b.rowsDigest!==outputContentDigest(rows))changed()
 return b.candidate?structuredClone(b.candidate):null
}
/** The abort exception is only the original stopped-buffer operation; SQL must still prove its current state. */
export function isBoundBufferedTerminalCommand(handle:BoundBufferedTerminalCommand,execution:ExecutionContext,token:string|undefined):boolean{
 const b=bindings.get(handle);return !!b&&!b.owner.closed&&b.execution===execution&&b.root.turnToken===token
}
/** Invoked only after the existing transaction/COMMIT owner returns successfully. */
export function acceptCommittedTerminalPublication(handle:BoundBufferedTerminalCommand,root:BufferedWebPublication,execution:ExecutionContext,
 rows:readonly {id:string;sequenceNum:number}[],raw:unknown,requestedStopped:boolean):void{
 const b=bindings.get(handle),result:Result=terminalPublicationResultSchema.parse(raw)
 if(!b||b.owner.closed||b.root!==root||b.execution!==execution||result.operationId!==root.operationId||result.requestedStopped!==requestedStopped)changed()
 if(result.stopped){
  if(result.terminalDescriptor!==null||result.terminalOutputs!==null)changed()
  b.owner.disposition='stopped'
  return
 }
 if(!b.candidate){if(result.terminalDescriptor!==null||result.terminalOutputs!==null)changed();return}
 if(outputContentDigest(result.terminalDescriptor)!==outputContentDigest(b.candidate)||result.terminalOutputs?.length!==b.candidate.members.length)changed()
 for(const [index,m]of b.candidate.members.entries()){
  const actual=result.terminalOutputs![index]!,row=rows[m.commandOrdinal]
  if(actual.origin!==m.origin||actual.revision!==m.revision||actual.commandOrdinal!==m.commandOrdinal
   ||actual.id!==row?.id||actual.sequence!==row.sequenceNum)changed()
 }
 if(b.owner.disposition!=='stopped')b.owner.disposition='committed'
}
