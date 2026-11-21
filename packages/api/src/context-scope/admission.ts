/** Complete effect admission. [COMP:api/private-transcript] */
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import {
  assertModelInputAuthority,
  assertModelOutputAuthority
} from '@use-brian/agent-runtime/engine/query-loop.js'
import {
  accessCeilingContains,
  intersectAccessCeilings,
  type AccessCeiling
} from '@use-brian/agent-runtime/security/access-ceiling.js'
import { ContextScopeAccumulator, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import type { DocPageRead } from '@use-brian/core/doc/tools.js'
import type { Session } from '../db/sessions.js'
import { admitModelSourceEvidence } from '../application-platform/model-source-authority.js'
import { DeliveryAudienceUnverifiedError } from './delivery-authority.js'
import { getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import { classifySession, policyFor } from '../session-kind.js'
import { roomAudienceCeiling } from '../routes/_room-binding.js'
import { admitAttendedAudienceEvidence } from './attended-audience.js'
import { assertScopeEvidenceFitsCeiling } from './caller-evidence.js'
import { recordEvidenceParts } from './conversation-record-admission.js'
import { tryAdmitNativePageTurnDelivery, tryReadNativePageTurnAnchor } from './native-page-delivery.js'

const deliveryBrand:unique symbol=Symbol('turn-delivery-admission')
export type TurnDeliveryAdmission={
 readonly [deliveryBrand]:true
 readonly authorizeDelivery:(context:ToolContext)=>Promise<void>
 readonly authorizePageModelInput?:(context:ToolContext)=>Promise<boolean>
 readonly readPageAnchor?:(context:ToolContext,pageId:string)=>Promise<DocPageRead|null>
 readonly checkRecordPublicationFloor:(context:ToolContext)=>boolean
 dispose():void
}
const deliveryBindings=new WeakMap<TurnDeliveryAdmission,(context:ToolContext)=>boolean>()
export function ownsTurnDeliveryAdmission(admission:TurnDeliveryAdmission,context:ToolContext):boolean{
 return deliveryBindings.get(admission)?.(context)??false
}

/** One current sink admission bound to the original execution and destination.
 * It retains no allow receipt or selected-permission state. It is not read, retention, mutation,
 * or publication authority.
 * Native web Rooms, private chats and Page threads qualify. Their resolver
 * already bounds every read to the stored audience. Model input and writes
 * have independent current source and lineage checks.
 */
export function createTurnDeliveryAdmission(
  execution: ExecutionContext,
  accumulator: ContextScopeAccumulator,
  session: Session,
  legacyPageDelivery?: (evidence: ScopeEvidence) => Promise<ScopeEvidence>,
): TurnDeliveryAdmission | undefined {
  const actor = execution.security.access.userId
  const kind = classifySession(session)
  const page = kind.anchor.kind === 'doc_thread' && kind.audience === 'workspace' && legacyPageDelivery
    && session.workspaceId === execution.security.access.workspaceId && session.channelType === 'web'
    ? legacyPageDelivery : undefined
  if (execution.identity.kind !== 'attended' || execution.identity.principal.kind !== 'workspace_member'
    || execution.identity.principal.authenticationKind !== 'native_session' || execution.identity.principal.userId !== actor
    || execution.ownership.kind !== 'workspace' || execution.surface.systemRead || execution.surface.clientSelfMemory
    || execution.security.access.systemRead || getApplicationExecutionBinding(execution)
    || execution.lifecycle.channelType !== 'web' || session.channelType !== 'web'
    || execution.lifecycle.sessionId !== session.id || execution.lifecycle.channelId !== session.channelId
    || (!page && kind.surface !== 'chat') || execution.security.provenance.sources?.length) return undefined
  const shared = policyFor(session).deliveryCeiling.ceiling === 'audience'
  if ((!shared && session.userId !== actor) || shared !== !!execution.security.access.sharedAudience) return undefined
  const ceiling = execution.security.ceiling
  if (shared && !accessCeilingContains(intersectAccessCeilings(ceiling, { ...roomAudienceCeiling(ceiling.workspaceId, session),
    userId: actor, visibilityAssistantIds: ceiling.visibilityAssistantIds,
    mutationCompartments: ceiling.mutationCompartments }), ceiling)) return undefined
  const ceilingFootprint = JSON.stringify(ceiling)

  // The original actor is retained in execution. Only the recipient is anonymous
  // for a shared room, so user-private evidence can never enter that room.
  const recipient: AccessCeiling = structuredClone({ ...execution.security.ceiling,
    userId: shared ? '' : actor, visibilityAssistantIds: null })
  // Department grants identify the executing human, not an anonymous audience.
  // The recipient keeps the already intersected room labels; SQL retains the
  // original actor grant when it intersects that room with the execution.
  if (shared) delete recipient.departmentRead
  const authority = execution.security.authority
  const pageRecipient = page ? roomAudienceCeiling(ceiling.workspaceId, session) : undefined
  const destination = { workspaceId: execution.security.access.workspaceId, assistantId: execution.assistant.id,
    userId: actor, channelType: session.channelType, channelId: session.channelId, sessionId: session.id,
    recipientType: policyFor(session).deliveryCeiling.recipientType }
  let invalid = false, closed = false
  const refuse = (): never => { throw new DeliveryAudienceUnverifiedError(undefined, 'source_unverifiable') }
  const assertIdentity = (context: ToolContext) => {
    if (closed || invalid || context.executionContext !== execution || context.authority !== authority
      || execution.security.authority !== authority || context.scopeAccumulator !== accumulator
      || execution.security.ceiling !== ceiling || JSON.stringify(ceiling) !== ceilingFootprint
      || execution.lifecycle.sessionId !== destination.sessionId || execution.lifecycle.channelId !== destination.channelId
      || execution.lifecycle.channelType !== destination.channelType
      || context.abortSignal?.aborted || execution.lifecycle.abortSignal.aborted) refuse()
  }
  const superseded = (footprint: string, admitted?: ScopeEvidence) => {
    if (JSON.stringify(accumulator.evidence) === footprint) return false
    if (admitted) {
      const { sensitivity, compartments, projectIds } = admitted
      accumulator.note({ sensitivity, compartments, projectIds })
    }
    return true
  }
  const dispose=()=>{closed=true;execution.lifecycle.abortSignal.removeEventListener('abort',dispose)}
  const admission: TurnDeliveryAdmission = Object.freeze({ [deliveryBrand]:true as const,
    dispose,
    ...(pageRecipient ? { async readPageAnchor(context: ToolContext, pageId: string) {
      try {
        for (let candidate = 0; candidate < 32; candidate++) {
        assertIdentity(context)
        const footprint = JSON.stringify(accumulator.evidence)
        const captured = await tryReadNativePageTurnAnchor(execution, pageRecipient, pageId)
        assertIdentity(context)
        if (superseded(footprint, captured?.evidence)) continue
        if (!captured) return null
        accumulator.note(captured.evidence)
        return captured.page
        }
        return refuse()
      } catch (error) {
        invalid = true
        throw error
      }
    }, async authorizePageModelInput(context: ToolContext) {
      try {
        for (let candidate = 0; candidate < 32; candidate++) {
        assertIdentity(context)
        const evidence = accumulator.evidence, footprint = JSON.stringify(evidence)
        const admitted = await tryAdmitNativePageTurnDelivery(execution, evidence, pageRecipient, 'dispatch')
        assertIdentity(context)
        if (superseded(footprint, admitted ?? undefined)) continue
        if (!admitted) return false
        accumulator.note(admitted)
        return true
        }
        return refuse()
      } catch (error) {
        invalid = true
        throw error
      }
    } } : {}),
    checkRecordPublicationFloor(context: ToolContext) {
      try {
        assertIdentity(context)
        if (page) return false
        const evidence = accumulator.evidence
        if (!recordEvidenceParts(evidence)) return false
        // The publication owner still acquires the live record and its
        // destination, then validates every fresh source before it writes.
        assertScopeEvidenceFitsCeiling(evidence, recipient, 'audience')
        return true
      } catch (error) {
        invalid = true
        throw error instanceof DeliveryAudienceUnverifiedError ? error
          : Object.assign(new DeliveryAudienceUnverifiedError(undefined,'source_unverifiable',error),{cause:error})
      }
    },
    async authorizeDelivery(context: ToolContext) {
      try {
        for (let candidate = 0; candidate < 32; candidate++) {
        assertIdentity(context)
        const evidence = accumulator.evidence, footprint = JSON.stringify(evidence)
        const admitted = page && pageRecipient
          ? (await tryAdmitNativePageTurnDelivery(execution, evidence, pageRecipient, 'frame') ?? await page(evidence))
          : await admitAttendedAudienceEvidence(execution, evidence, recipient,
            { directHumanSource: !shared,turnDestinationSessionId:destination.sessionId })
        assertIdentity(context)
        if (superseded(footprint, admitted)) continue
        accumulator.note(admitted)
        return
        }
        refuse()
      } catch (error) {
        invalid = true
        throw error
      }
    },
  })
  deliveryBindings.set(admission,context=>{try{assertIdentity(context);return true}catch{return false}})
  if(execution.lifecycle.abortSignal.aborted)dispose()
  else execution.lifecycle.abortSignal.addEventListener('abort',dispose,{once:true})
  return admission
}

/** Standalone provider context uses the same lease owner as the query loop. */
export async function admitModelInput(context: ToolContext): Promise<void> {
  try { await assertModelInputAuthority({...context, admitModelInput: current => admitModelSourceEvidence(current, 'context')}) }
  catch(error) { throw modelAdmissionError(error) }
}
/** The narrowing guard runs under the source transaction, before final admission. */
export async function admitModelOutput(context: ToolContext, narrowingGuard?: () => Promise<void>): Promise<void> {
  try { await assertModelOutputAuthority({...context, admitModelOutput: current => admitModelSourceEvidence(current, 'deliver', narrowingGuard)}) }
  catch(error) { throw modelAdmissionError(error) }
}

/** Preserve the API's source diagnostic contract while core owns sticky refusal. */
function modelAdmissionError(error:unknown):SourceProtocolError {
 const cause=error instanceof Error && error.cause!==undefined ? error.cause : error
 const mapped=error instanceof SourceProtocolError ? error : cause instanceof SourceProtocolError ? cause
  : error instanceof Error && error.message==='The model context is unavailable.' && error.cause===undefined
   ? new SourceProtocolError('source_access_denied')
   : Object.defineProperty(new SourceProtocolError('source_unavailable'),'cause',{value:cause,configurable:true,writable:true,enumerable:false})
 return Object.assign(mapped,{reason:'authority_changed' as const,retrySafe:false})
}
