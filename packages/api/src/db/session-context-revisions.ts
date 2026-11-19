import {markAuthorityOperationUncertain} from '../context-scope/authority-lease.js'
import { privateMemoryCredential } from '../brain-mcp/private-memory-tools.js'
import {isBoundBufferedTerminalCommand,type BoundBufferedTerminalCommand} from '../turn/terminal-publication.js'
import {admitRetainedGoalWorkflowWrite} from '../workspace-access/goal-source-admission.js'
import { nativeSessionQueryContextSources } from '../application-platform/session-query-context.js'
import { beginClosureAdmission } from '../context-scope/admission-closure.js'
import {admitTurnConversationRecords,assertConversationFloor,recordEvidenceParts} from '../context-scope/conversation-record-admission.js'
import { z } from 'zod'
import { SourceProtocolError } from '@use-brian/brian-app/connector'
import { createMemory } from './memories.js'
import { pinPublicMemberConversationPublication, type PublicTurnConversationBinding } from './public-conversation.js'
/** Immutable session-context storage. [COMP:api/application-persistence] */
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { isTopicIdentity } from '@use-brian/core/memory/topic-identity.js'
import {
  intersectAccessCeilings,
  accessCeilingContains,
  pinAccessCeiling,
} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {
  ContextScopeAccumulator,
  scopeGrantContains,
  type ScopeEvidence,
} from '@use-brian/agent-runtime/security/context-scope.js'
import {
  DerivedScopeError,
  deriveWriteScope,
  resourceScopeKey,
  type DerivedWriteEvidence,
  type ResourceScope,
  type ScopeSource,
} from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { RANK } from '@use-brian/agent-runtime/security/sensitivity.js'
import {
  bindScopeSource,
  boundScopeSources,
} from '@use-brian/agent-runtime/security/source-evidence.js'
import {
  workspaceCredentialDelegation,
} from '@use-brian/agent-runtime/security/workspace-delegation.js'
import { applyRLSGucs, getAppPool, getPool, rollbackAndRelease, runWithAgentAccess } from './client.js'
import { recordDerivedResource, validateDerivedWriteInputs } from './derived-scope-store.js'
import { assertPreparedConversationCohortEvidence, scopeEvidenceFailureOf, validateCallerScopeEvidence,readValidatedNativeTitleGroup,readValidatedNativePublicationCohorts } from '../context-scope/caller-evidence.js'
import type {NativeTitleHead} from '../application-platform/native-title-group-evidence.js'
import { readConversationPreparation } from '../application-platform/conversation-evidence.js'
import {captureConversationQuery,conversationCaptureSources,type ConversationSelection,type ConversationCaptures} from './conversation-store.js'
import { conversationReadersActive } from './conversation-visibility.js'
import { readExternalSourceAncestors } from '../application-platform/external-source-ancestry.js'
import { readApplicationFieldAncestors } from '../application-platform/field-evidence.js'
import { getSharedRetainedSourceAuthority } from '../application-platform/source-runtime.js'
import { applyApplicationRLSContext, getApplicationExecutionBinding, releaseApplicationTransactionBinding } from '../application-platform/execution-context.js'
import { assertPreparedExternalSourceAuthorityCurrent, pinPreparedExternalSourceAuthority,
  type PreparedExternalSourceAuthority } from '../application-platform/retained-source-authority.js'

export type SessionContextKind = 'session_state' | 'episodic_memory' | 'compact_summary' | 'message_annotation' | 'session_title'
export type SessionContextRevision = {
  id: string; parentId: string; sessionId: string; source: ScopeSource; content: Record<string, unknown>
  userId: string; assistantId: string; createdAt: Date; lastAccessedAt: Date; accessCount: number; survivalCount: number
}
type Prepare = (execution: ExecutionContext, sources: readonly ScopeSource[], action: 'context' | 'retain') => Promise<PreparedExternalSourceAuthority>
type PublicationMeasure=<T>(counter:string,run:()=>Promise<T>)=>Promise<T>
const retainedHosts = new WeakMap<ExecutionContext, Prepare>()
const programmaticPublications = new WeakSet<ExecutionContext>()
/** Identity of a host-bound workspace invocation, never a serialized source grant. */
export function hasWorkspaceMcpRetainedAuthority(execution: ExecutionContext): boolean {
 return programmaticPublications.has(execution)
}
/** Host-only binding after durable workspace MCP operation admission. */
export function bindWorkspaceMcpPublication(execution: ExecutionContext): void {
 const {identity,security,ownership,surface}=execution
 if(identity.kind!=='programmatic'||!['brain_key','assistant_key','oauth_token'].includes(identity.principal.kind)
   ||identity.principal.actorUserId!==security.access.userId||ownership.kind!=='workspace'
   ||ownership.workspaceId!==security.access.workspaceId||!security.access.sharedAudience
   ||execution.lifecycle.sessionPersisted===false||surface.readOnly||surface.systemRead||surface.clientSelfMemory
   ||security.access.systemRead||getApplicationExecutionBinding(execution))missing()
 programmaticPublications.add(execution)
}

/** Canonical workflow resolver only: machine work keeps its native source
 * admission without becoming an attended human or a persisted chat session. */
export function bindWorkspaceMcpWorkflowPublication(execution: ExecutionContext): void {
 const {identity,security,ownership,surface}=execution
 const parent=workspaceCredentialDelegation(execution),source=security.authority.snapshotSource?.()
 if(!parent||identity.kind!=='system'||identity.purpose!=='workflow'||source?.kind!=='workflow'
   ||source.runId!==identity.jobId||source.authorityUserId!==security.access.userId
   ||source.workspaceId!==security.access.workspaceId||source.executingAssistantId!==execution.assistant.id
   ||ownership.kind!=='workspace'||ownership.workspaceId!==security.access.workspaceId
   ||!security.access.sharedAudience||surface.readOnly||surface.systemRead||surface.clientSelfMemory
   ||security.access.systemRead||getApplicationExecutionBinding(execution))missing()
 programmaticPublications.add(execution)
}

/** R4 supplies its real invocation's prepared operation; no service/creator impersonation. */
export function bindSessionContextRetainedAuthority(execution: ExecutionContext, prepare: Prepare): void {
  retainedHosts.set(execution, prepare)
}
function missing(): never { throw new DerivedScopeError('scope_evidence_missing') }
function changed(cause?:unknown): never { throw Object.assign(new DerivedScopeError('scope_source_changed'),cause===undefined?{}:{cause}) }
function requireAuthority(authority: SessionContextAuthority | undefined): SessionContextAuthority {
  if (!authority?.execution || !(authority.accumulator instanceof ContextScopeAccumulator)) missing()
  return authority
}
/** Only the original current native delegated member can enter this host port. */
function nativeDelegatedSessionPublication(execution:ExecutionContext):boolean{
 const {identity,security,ownership,surface}=execution,access=security.access
 return identity.kind==='delegated'&&ownership.kind==='workspace'&&ownership.workspaceId===access.workspaceId
  &&identity.actorUserId===access.userId&&identity.parentCeiling.userId===access.userId
  &&identity.parentCeiling.workspaceId===access.workspaceId&&access.assistantId===execution.assistant.id
  &&!surface.readOnly&&!surface.systemRead&&!surface.clientSelfMemory&&!access.systemRead
  &&!getApplicationExecutionBinding(execution)
}
async function transaction<T>(authority: SessionContextAuthority, sources: readonly ScopeSource[], action: 'context' | 'retain',
  run: (client: PoolClient, checked:ScopeEvidence,annotationChecked?:ScopeEvidence) => Promise<T>, writeSessionId?: string, stoppedTurnToken?:string, activeTurnToken?:string,nativeMutation=false,
  scalarFloor?:Pick<ScopeEvidence,'sensitivity'|'compartments'|'projectIds'>,measure?:PublicationMeasure,annotationFloor?:ScopeEvidence,
  bufferedCommand?:BoundBufferedTerminalCommand, publicConversation?:PublicTurnConversationBinding): Promise<T> {
  const time:PublicationMeasure=measure??((_counter,run)=>run())
  const floor=scalarFloor===undefined?{}:structuredClone({sensitivity:scalarFloor.sensitivity,compartments:scalarFloor.compartments,projectIds:scalarFloor.projectIds})
  const pendingFloor=annotationFloor===undefined?undefined:structuredClone(annotationFloor)
  let publicationAttempted=false
  const publicationState:{outcome:'not_attempted'|'unknown'|'committed'|'rolled_back'}={outcome:'not_attempted'}
  try {
    const { execution, accumulator } = requireAuthority(authority), before = JSON.stringify(accumulator.evidence)
    let finalizing=!!stoppedTurnToken&&action==='retain'&&!!writeSessionId
      &&execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member'
    const buffered=!!bufferedCommand&&isBoundBufferedTerminalCommand(bufferedCommand,execution,activeTurnToken??stoppedTurnToken)
    if(bufferedCommand&&!buffered)changed()
    if (execution.lifecycle.abortSignal.aborted&&!finalizing&&!buffered || sources.some(source => source.workspaceId !== execution.security.access.workspaceId)) changed()
    const recordParts=recordEvidenceParts({...floor,sources:[...sources]})
    if(recordParts&&(action!=='retain'||writeSessionId!==execution.lifecycle.sessionId||!activeTurnToken&&!stoppedTurnToken))changed()
    if(!recordParts)await execution.security.authority.assertCurrent()
    const freshSources=recordParts?.fresh.sources??sources
    const hasDirectExternal=freshSources.some(source=>source.resourceKind==='external_source')
    // This admission's view of its turn's admission closure (one witness read).
    // A publication transaction holds the session's publication lock, so its
    // view reads the witness before the transaction and never during it.
    const closure=freshSources.length?beginClosureAdmission(execution,{locked:!!writeSessionId||nativeMutation}):undefined
    const discoverAncestry=async()=>{
    if(!freshSources.length)return {externalAncestors:[],fields:[]}
    const ancestry=await Promise.allSettled([
      hasDirectExternal?Promise.resolve([]):time('publication_external_ancestry',()=>readExternalSourceAncestors(execution.security.access.workspaceId,freshSources)),
      time('publication_field_ancestry',()=>readApplicationFieldAncestors(execution.security.access.workspaceId,freshSources)),
    ])
    for(const result of ancestry)if(result.status==='rejected')throw result.reason
    const [externalAncestors,fields]=ancestry.map(result=>result.status==='fulfilled'?result.value:[])
    return {externalAncestors,fields}
    }
    // Ancestry discovery is metadata; the turn's closure may hold this exact
    // input's result while every source it relies on is unchanged.
    const {externalAncestors,fields}=closure&&!hasDirectExternal?await closure.discover('session-context',[...freshSources],discoverAncestry,
     value=>value.externalAncestors.length?null:[...freshSources,...value.fields]):await discoverAncestry()
    const external = hasDirectExternal || externalAncestors.length > 0
    const wiring = getSharedRetainedSourceAuthority(), host = retainedHosts.get(execution)
    const prepare = host ?? (wiring ? (e: ExecutionContext, s: readonly ScopeSource[], a: 'context' | 'retain') => wiring.coordinator.prepare(e,s,a) : undefined)
    const discoverCohort=()=>time('publication_query_context',()=>nativeSessionQueryContextSources(execution, freshSources, prepare))
    const cohort = !fields.length ? { sources:freshSources, independent: false } : closure ? await closure.discover('session-context-cohort',[...freshSources],discoverCohort,
     value=>value.independent?null:[...freshSources,...value.sources]) : await discoverCohort()
    const lockRecord=recordParts && !external && !cohort.independent && !nativeMutation && !!writeSessionId
    if(recordParts&&!lockRecord)await execution.security.authority.assertCurrent()
    if ((external || cohort.independent) && !prepare) changed()
    let contextProof: PreparedExternalSourceAuthority | undefined
    let prepared: PreparedExternalSourceAuthority | undefined
    await closure?.ready()
    const client = await time('publication_pool_wait',()=>getAppPool().connect())
    let result: T
    let committed=false, released=false, publicationTransactionId:string|undefined
    try {
      result = await runWithAgentAccess(execution.security.access, async () => {
        await client.query('BEGIN')
        // The workspace and destination locks are shared by both the record
        // proof and native source capture. Independent source owners still
        // establish their own transaction context and current pins below.
        const preparation=recordParts&&lockRecord ? await time('publication_record_prepare',()=>admitTurnConversationRecords(execution,
          recordParts.records,finalizing?'stopped_publication':'publication',client,{buffered})) : undefined
        if(preparation?.locked){
          publicationTransactionId=preparation.locked.transactionId
          finalizing=finalizing||preparation.locked.state==='stopping'||preparation.locked.state==='stopped'
          if(execution.lifecycle.abortSignal.aborted&&!finalizing)changed()
        }else{
          {
            const role = (await client.query<{ bypass: boolean }>(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
              FROM pg_roles r JOIN pg_class c ON c.oid='session_context_revision_contents'::regclass WHERE r.rolname=current_user`)).rows[0]
            if (role?.bypass !== false) changed()
          }
          // Native publication pins its original assistant in the same context
          // statement, including legacy department policy. This does not enable v2.
          const nativeAssistant=execution.identity.kind === 'attended' && execution.identity.principal.kind === 'workspace_member'
            ||nativeDelegatedSessionPublication(execution)||programmaticPublications.has(execution)
            ||execution.identity.kind==='system'&&execution.identity.purpose==='workflow'&&execution.security.authority.snapshotSource?.().kind==='workflow'
          await applyRLSGucs(client, execution.security.access.userId,nativeAssistant?execution.assistant.id:undefined)
          // Native admission takes workspace SHARE locks too. Pin that row before
          // any source/parent reader can lock a session: a reader holding a session
          // while waiting for promotion's workspace lock otherwise forms a cycle.
          // NO KEY UPDATE permits the trusted source pin's separate FK insert;
          // createMemory upgrades only after those pin inserts have committed.
          if(writeSessionId&&!nativeMutation){
            const lock=await time('publication_lock',()=>client.query<{transactionId:string}>('SELECT lock_native_session_context_publication($1,$2),pg_current_xact_id()::text AS "transactionId"',[execution.security.access.workspaceId,writeSessionId]))
            publicationTransactionId=lock.rows[0]?.transactionId
          }
          else {
            const selected=action==='retain' ? 'id,pg_current_xact_id()::text AS "transactionId"' : 'id'
            const locked=await client.query<{id:string;transactionId?:string}>(`SELECT ${selected} FROM workspaces WHERE id=$1 FOR ${nativeMutation?'NO KEY UPDATE':'SHARE'}`,[execution.security.access.workspaceId])
            publicationTransactionId=locked.rows[0]?.transactionId
            if(nativeMutation&&locked.rows.length!==1)changed()
          }
          if(buffered){
            const state=(await client.query<{state:string}>('SELECT native_session_turn_publication_state($1,$2,$3) AS state',
              [execution.security.access.workspaceId,writeSessionId,activeTurnToken??stoppedTurnToken])).rows[0]?.state
            if(!['active','stopping','stopped'].includes(state??''))changed()
            finalizing=finalizing||state==='stopping'||state==='stopped'
            if(execution.lifecycle.abortSignal.aborted&&!finalizing)changed()
          } else if (finalizing || activeTurnToken) {
            const admitted=(await client.query<{allowed:boolean}>('SELECT native_session_turn_publication_allowed($1,$2,$3,$4) AS allowed',
              [execution.security.access.workspaceId,writeSessionId,activeTurnToken??stoppedTurnToken,finalizing])).rows[0]?.allowed
            if(admitted!==true)changed()
          }
          await applyApplicationRLSContext(client, execution)
          // Take the publication lock before any native source reader takes a
          // parent SHARE lock. Two simultaneous upgrades otherwise deadlock.
          if(writeSessionId&&nativeMutation)await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE',[writeSessionId])
        }
        let publicWriteFloor:Awaited<ReturnType<typeof pinPublicMemberConversationPublication>>|undefined
        if(publicConversation){
          if(!activeTurnToken||recordParts||nativeMutation||buffered
           ||publicConversation.sessionId!==writeSessionId||publicConversation.sessionId!==execution.lifecycle.sessionId
           ||execution.lifecycle.channelType!=='api'||execution.identity.kind!=='attended'
           ||execution.identity.principal.kind!=='workspace_member'
           ||execution.identity.principal.authenticationKind!=='credential_attribution'
           ||publicConversation.memberUserId!==execution.identity.principal.userId
           ||publicConversation.userId!==execution.security.access.userId||publicConversation.assistantId!==execution.assistant.id)changed()
          publicWriteFloor=await pinPublicMemberConversationPublication(client,publicConversation,activeTurnToken)
        }
        // Source receipts are short-lived. Acquire each after native lock
        // waits and immediately before the boundary that consumes it.
        contextProof = external || cohort.independent ? await prepare!(execution, cohort.sources, 'context') : undefined
        if (contextProof) await pinPreparedExternalSourceAuthority(client, execution, contextProof)
        const validation=await time('publication_validate',async()=>{
          const evidence={...floor,sources:[...sources]}
          if(recordParts){
            const admitted=preparation??await admitTurnConversationRecords(execution,recordParts.records,finalizing?'stopped_publication':'publication',client)
            const annotationParts=pendingFloor&&recordEvidenceParts(pendingFloor)
            const cohorts=annotationParts&&!external&&!cohort.independent
              ?await readValidatedNativePublicationCohorts([recordParts.fresh,annotationParts.fresh],execution.security.ceiling,client):null
            const fresh=cohorts?.[0]??await validateCallerScopeEvidence(recordParts.fresh,execution.security.ceiling,client,undefined,closure)
            const checked=new ContextScopeAccumulator(fresh)
            checked.note({sources:admitted.sources})
            assertConversationFloor(checked.evidence,admitted.destination)
            if(!annotationParts)return [checked.evidence]
            const annotation=cohorts?.[1]??await validateCallerScopeEvidence(annotationParts.fresh,execution.security.ceiling,client,undefined,closure)
            const annotationChecked=new ContextScopeAccumulator(annotation)
            annotationChecked.note({sources:annotationParts.records})
            assertConversationFloor(annotationChecked.evidence,admitted.destination)
            return [checked.evidence,annotationChecked.evidence]
          }
          const cohorts=pendingFloor&&!external&&!cohort.independent
            ?await readValidatedNativePublicationCohorts([evidence,pendingFloor],execution.security.ceiling,client):null
          return cohorts??[await validateCallerScopeEvidence(evidence,execution.security.ceiling,client,undefined,closure)]
        })
        const [checked,annotationChecked]=validation
        if(publicWriteFloor)assertConversationFloor(checked,{
          sensitivity:publicWriteFloor.cap,compartments:publicWriteFloor.compartments,projectIds:publicWriteFloor.projectIds,
          generation:publicWriteFloor.version,
        })
        prepared = external && action==='retain' ? await prepare!(execution, freshSources, 'retain') : undefined
        if (prepared) await pinPreparedExternalSourceAuthority(client, execution, prepared)
        const value = await time('publication_write',()=>run(client,checked,annotationChecked))
        // COMMIT's deferred-trigger phase can outlive statement_timeout while
        // retaining the session lock needed by heartbeat/Stop. Flush the exact
        // same checks as a bounded statement, then recheck live authority and
        // cancellation before allowing the transaction to commit.
        if (writeSessionId) await time('publication_constraints',()=>client.query('SET CONSTRAINTS ALL IMMEDIATE'))
        await execution.security.authority.assertCurrent()
        if (execution.lifecycle.abortSignal.aborted&&!finalizing || JSON.stringify(accumulator.evidence) !== before
          || host !== retainedHosts.get(execution) || !host && wiring !== getSharedRetainedSourceAuthority()) changed()
        if(action==='retain'){publicationAttempted=true;publicationState.outcome='unknown'}
        try {
          await time('publication_commit',()=>client.query('COMMIT'))
          committed=true;publicationState.outcome='committed'
        } catch(error) {
          // An acknowledgement failure is not an aborted write. Never execute
          // run() again. Discard the connection before inspecting its transaction.
          client.release(true);released=true
          if(!publicationAttempted || !publicationTransactionId)throw error
          let status:unknown
          try { status=(await getPool().query<{status:string|null}>('SELECT pg_xact_status($1::xid8) AS status',[publicationTransactionId])).rows[0]?.status }
          catch { throw error }
          if(status==='aborted')publicationState.outcome='rolled_back'
          if(status!=='committed')throw error
          committed=true;publicationState.outcome='committed'
        }
        return value
      })
    } finally {
      releaseApplicationTransactionBinding(client)
      if(!released){if(committed)client.release();else await rollbackAndRelease(client)}
    }
    if (contextProof) await assertPreparedExternalSourceAuthorityCurrent(execution, contextProof)
    if (prepared) await assertPreparedExternalSourceAuthorityCurrent(execution, prepared)
    await execution.security.authority.assertCurrent()
    return result
  } catch (error) {
    if(publicationAttempted&&publicationState.outcome==='rolled_back'){
      throw Object.assign(error instanceof Error?error:new Error('scope_source_changed'),{retrySafe:false,operationMayHaveExecuted:false,publicationOutcome:publicationState.outcome})
    }
    if(publicationAttempted){
      markAuthorityOperationUncertain(authority.execution.security.authority)
      throw Object.assign(error instanceof Error?error:new Error('scope_source_changed'),{retrySafe:false,operationMayHaveExecuted:true,publicationOutcome:publicationState.outcome})
    }
    const sql = error as { code?: unknown; message?: unknown } | null
    if (sql && (['P0001','42501','22023'].includes(String(sql.code)) && sql.message === 'scope_source_changed'
      // A deferred frame-pair check runs after the writer has returned. The
      // canonical writer never retries construction through a legacy path.
      || (nativeMutation || writeSessionId !== undefined) && sql.code === 'PNT02' && sql.message === 'native_turn_construction_unavailable')) {
      throw Object.assign(new DerivedScopeError('scope_source_changed'), { cause: error })
    }
    if (error instanceof SourceProtocolError) {
      if (error.code === 'source_access_denied') changed(error)
      // Unavailability, malformed proof and uncertain source effects must not
      // become a normal storage failure. Preserve their code and retry policy.
      throw Object.assign(error, { reason: 'authority_changed' as const })
    }
    if (typeof error === 'object' && error !== null && 'reason' in error
      && error.reason === 'caller_evidence_unavailable') changed(error)
    throw error
  }
}

/** Current retained read using the original lease and the complete canonical validator.
 * The callback receives exactly the non-owner transaction carrying fresh source pins.
 * No session query floor or serialized source identifier can create this authority.
 */
export function readRetainedContextFrame<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<T>):Promise<T>{
 return transaction(authority,structuredClone(sources),'context',capture)
}

/** Optional identity-only native acquisition. Its SQL reader proves the whole
 * closed source set before selecting payloads; the original caller validator
 * checks that same proof inside this frame. Null leaves the full retained path
 * responsible for independent-source preparation and ordinary fallback. */
export function readNativeTitleGroupFrame(authority:SessionContextAuthority,heads:readonly NativeTitleHead[],
 sources:readonly ScopeSource[]):Promise<unknown[]|null>{
 const {execution}=requireAuthority(authority)
 // SQL admits payload before the host inspects its proof packet. An access
 // context broader than the original caller ceiling must therefore retain
 // the original pre-payload caller-validation path, not this consolidation.
 if(!accessCeilingContains(execution.security.ceiling,pinAccessCeiling(execution.security.access)))return Promise.resolve(null)
 const identities=structuredClone(heads),evidence={sources:structuredClone([...sources])}
 return transaction(authority,[],'context',async client=>{
  const captured=await readValidatedNativeTitleGroup(identities,evidence,authority.execution.security.ceiling,client)
  return captured?.titles??null
 })
}

/** Native durable publication uses the original retained operation and non-owner connection. */
export function writeRetainedContextFrame<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],
 publish:(client:PoolClient)=>Promise<T>):Promise<T>{
 const {execution}=requireAuthority(authority)
 if((execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member')&&!programmaticPublications.has(execution)
  ||execution.ownership.kind!=='workspace'||execution.surface.readOnly||execution.surface.systemRead
  ||execution.lifecycle.abortSignal.aborted)missing()
 return transaction(authority,structuredClone(sources),'retain',publish,undefined,undefined,undefined,true)
}

/** A standard user OAuth connection has no persisted chat session. Admit
 * only its own new private memory, under the same RLS transaction and live
 * authority checks as native writes. Derived content needs its original frame. */
export function writeMemoryCreateFrame<T>(authority: SessionContextAuthority, sources: readonly ScopeSource[],
  ownerId: string | null, publish: (client: PoolClient, explicitSave: boolean) => Promise<T>): Promise<T> {
  const { execution, accumulator } = requireAuthority(authority)
  const current = privateMemoryCredential(execution, 'saveMemory')
  if (!current) return writeRetainedContextFrame(authority, sources, client => publish(client, false))
  const { workspaceId, userId } = execution.security.access
  if (!ownerId || ownerId !== userId || sources.length || accumulator.evidence.sources?.length) missing()
  return transaction(authority, [], 'retain', async client => {
    await applyRLSGucs(client, ownerId, execution.assistant.id)
    const member = await client.query(
      "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin') FOR SHARE",
      [workspaceId, ownerId])
    if (member.rowCount !== 1 || !await current()) changed()
    // An explicit client-authored save remains retrievable when the workspace
    // enables memory learning. There is no Brian model observation to confirm.
    return publish(client, true)
  }, undefined, undefined, undefined, true)
}

/** Current native query frame. Physical metadata grants nothing: only genuine
 * source denials exclude candidates, and one fresh operation pins the admitted
 * cohort after native lock waits. Original caller/lease validation brackets it.
 */
export async function readRetainedQueryFrame<T>(authority:SessionContextAuthority,rawRoots:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<{value:T;sources:readonly ScopeSource[]}>):Promise<T>{
 const {execution}=requireAuthority(authority),roots=structuredClone(rawRoots)
 await execution.security.authority.assertCurrent()
 if(roots.some(root=>root.workspaceId!==execution.security.access.workspaceId))changed()
 const wiring=getSharedRetainedSourceAuthority(),host=retainedHosts.get(execution)
 const prepare=host??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'retain')=>wiring.coordinator.prepare(e,s,a)):undefined)
 const admitted:ScopeSource[]=[]
 for(const root of roots){
  if(root.resourceKind!=='external_source'&&!(await readExternalSourceAncestors(root.workspaceId,[root])).length)continue
  if(!prepare)changed()
  try{await prepare(execution,[root],'context');admitted.push(root)}
  catch(error){if(!(error instanceof SourceProtocolError)||error.code!=='source_access_denied')throw error}
 }
 const assertWiring=()=>{if(host!==retainedHosts.get(execution)||!host&&wiring!==getSharedRetainedSourceAuthority())changed()}
 const captured=await transaction(authority,[],'context',async client=>{
  assertWiring()
  const proof=admitted.length?await prepare!(execution,admitted,'context'):undefined
  if(proof)await pinPreparedExternalSourceAuthority(client,execution,proof)
  const result=await capture(client)
  assertWiring()
  if(admitted.length){
   const refreshed=await prepare!(execution,admitted,'context')
   await pinPreparedExternalSourceAuthority(client,execution,refreshed)
  }
  await validateCallerScopeEvidence({sources:[...result.sources]},execution.security.ceiling,client,undefined,beginClosureAdmission(execution))
  assertWiring();return result
 })
 if(admitted.length){
  let current:PreparedExternalSourceAuthority|undefined
  await transaction(authority,[],'context',async client=>{
   assertWiring();current=await prepare!(execution,admitted,'context')
   await pinPreparedExternalSourceAuthority(client,execution,current)
   await validateCallerScopeEvidence({sources:[...captured.sources]},execution.security.ceiling,client,undefined,beginClosureAdmission(execution))
   assertWiring()
  })
  if(!current)changed()
  await assertPreparedExternalSourceAuthorityCurrent(execution,current)
 }
 assertWiring();await execution.security.authority.assertCurrent();return captured.value
}

const queryFloor=z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.null(),
 sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict()
async function pinNativeSessionQueryFloor(authority:SessionContextAuthority,client:PoolClient){
 const {execution}=authority,actor=execution.security.access.userId,workspaceId=execution.security.access.workspaceId
 const scope=(await client.query<{scope:unknown}>('SELECT read_native_session_query_floor($1,$2) AS scope',[workspaceId,execution.lifecycle.sessionId])).rows[0]?.scope
 if(scope==null)changed()
 const floor=queryFloor.parse(scope)
 if(floor.workspaceId!==workspaceId||floor.userId!==null&&floor.userId!==actor)changed()
 if(floor.userId===null&&execution.security.access.sharedAudience){
  const maximum={workspaceId,userId:actor,clearance:floor.sensitivity,compartments:floor.compartments,mutationCompartments:[],
   projectIds:floor.projectIds,visibilityAssistantIds:execution.security.ceiling.visibilityAssistantIds}
  const bounded=intersectAccessCeilings(execution.security.ceiling,maximum)
  await runWithAgentAccess({...execution.security.access,...bounded,sharedAudience:true},()=>applyRLSGucs(client,actor))
  return floor
 }
 return null
}

/** Internal current-reader frame for original session queries, including empty collections. */
export async function readSessionQueryFrame<T>(authority:SessionContextAuthority,rawRoots:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<{value:T;sources:readonly ScopeSource[]}>):Promise<T> {
 return sessionQueryFrame(authority,rawRoots,capture)
}

/** The conversation query has one acquisition operation inside the source frame. */
export function readJointSessionQueryFrame(authority:SessionContextAuthority,roots:readonly ScopeSource[],
 selection:ConversationSelection):Promise<ConversationCaptures>{
 const selector=structuredClone(selection),{execution}=requireAuthority(authority)
 if(selector.sessionId!==execution.lifecycle.sessionId||execution.lifecycle.sessionPersisted===false
  ||![selector.throughSequence,selector.topicThroughSequence].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647))missing()
 return sessionQueryFrame(authority,roots,async client=>{
  const value=await captureConversationQuery(client,execution.security.access.workspaceId,selector)
  return{value,sources:conversationCaptureSources(value,execution.security.access.workspaceId)}
 })
}

async function sessionQueryFrame<T>(authority:SessionContextAuthority,rawRoots:readonly ScopeSource[],
 capture:(client:PoolClient)=>Promise<{value:T;sources:readonly ScopeSource[]}>):Promise<T>{
 try{
 const {execution}=requireAuthority(authority),roots=structuredClone(rawRoots)
 await execution.security.authority.assertCurrent()
 const wiring=getSharedRetainedSourceAuthority(),host=retainedHosts.get(execution)
 const prepare=host??(wiring?((e:ExecutionContext,s:readonly ScopeSource[],a:'context'|'retain')=>wiring.coordinator.prepare(e,s,a)):undefined)
 // Discover immutable metadata only. Native-only reads need no additional
 // floor transaction; their acquisition frame applies it before any payload.
 const externalRoots:ScopeSource[]=[]
 if(roots.some(root=>root.workspaceId!==execution.security.access.workspaceId))changed()
 let hasExternal=true
 if(!roots.some(root=>root.resourceKind==='external_source')){
  try{hasExternal=(await readExternalSourceAncestors(execution.security.access.workspaceId,roots)).length>0}
  // Conflicting historical observations across different roots, or an
  // unavailable batch, keep the original independent per-root decisions.
  catch{hasExternal=true}
 }
 if(hasExternal)for(const root of roots){
  if(root.resourceKind==='external_source'||(await readExternalSourceAncestors(root.workspaceId,[root])).length)externalRoots.push(root)
 }
 const floor=externalRoots.length?await transaction(authority,[],'context',client=>pinNativeSessionQueryFloor(authority,client)):null
 const admittedRoots:ScopeSource[]=[]
 for(const root of externalRoots){
  if(floor&&(root.userId!==null||RANK[root.sensitivity]>RANK[floor.sensitivity]
   ||!scopeGrantContains(floor.compartments,root.compartments)||!scopeGrantContains(floor.projectIds,root.projectIds)))continue
  if(!prepare)changed()
  try{await prepare(execution,[root],'context');admittedRoots.push(root)}
  catch(error){if(!(error instanceof SourceProtocolError)||error.code!=='source_access_denied')throw error}
 }
 // One real source operation binds all admitted roots; separate operation IDs
 // must never replace one another's transaction-scoped source pins.
 let proof:PreparedExternalSourceAuthority|undefined
 const assertWiring=()=>{if(host!==retainedHosts.get(execution)||!host&&wiring!==getSharedRetainedSourceAuthority())changed()}
 assertWiring()
 const captured=await transaction(authority,[],'context',async client=>{
  await pinNativeSessionQueryFloor(authority,client)
  proof=admittedRoots.length?await prepare!(execution,admittedRoots,'context'):undefined
  assertWiring()
  if(proof)await pinPreparedExternalSourceAuthority(client,execution,proof)
  const result=await capture(client)
  await validateCallerScopeEvidence({sources:[...result.sources]},execution.security.ceiling,client,undefined,beginClosureAdmission(execution))
  assertWiring()
  return result
 })
 if(proof){
  // The acquisition frame may consume a short receipt's lifetime. A fresh
  // source decision plus real SQL revalidation qualifies the return value;
  // expired acquisition permission is never treated as current authority.
  let currentProof:PreparedExternalSourceAuthority|undefined
  assertWiring()
  await transaction(authority,[],'context',async client=>{
   await pinNativeSessionQueryFloor(authority,client)
   currentProof=await prepare!(execution,admittedRoots,'context')
   assertWiring()
   await pinPreparedExternalSourceAuthority(client,execution,currentProof)
   await validateCallerScopeEvidence({sources:[...captured.sources]},execution.security.ceiling,client,undefined,beginClosureAdmission(execution))
   assertWiring()
  })
  if(!currentProof)changed()
  await assertPreparedExternalSourceAuthorityCurrent(execution,currentProof)
 }
 assertWiring();await execution.security.authority.assertCurrent()
 const value=captured.value
 return value
 }catch(error){
  // Stored-entry transactions keep their holding normalization. A query
  // caller still receives the authentic current source protocol refusal.
  const cause=error instanceof DerivedScopeError&&error.code==='scope_source_changed'&&'cause'in error?error.cause:undefined
  if(cause instanceof SourceProtocolError&&cause.code==='source_access_denied'){
   throw Object.assign(cause,{reason:'authority_changed' as const,retrySafe:false})
  }
  throw error
 }
}

const messagePublications=new WeakMap<object,{authority:SessionContextAuthority;pending?:PendingSessionContextRevision;checked?:ScopeEvidence;annotationPublished:boolean}>()
type PendingSessionContextRevision={
 authority:SessionContextAuthority;execution:ExecutionContext;
 command:Omit<SessionContextRevisionInput,'authority'>;id:string;parentId:string;
 evidence:DerivedWriteEvidence;floor:ScopeEvidence;
}
const pendingContextRevisions=new WeakMap<object,PendingSessionContextRevision>()
/** Atomic native transcript batch; the callback never receives an owner connection. */
export async function withSessionMessagePublication<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],
 run:(client:PoolClient)=>Promise<T>,options?:{turnToken?:string;stoppedTurnToken?:string;measure?:PublicationMeasure;pendingAnnotation?:object;
  bufferedCommand?:BoundBufferedTerminalCommand;publicConversation?:PublicTurnConversationBinding}):Promise<T>{
 const {execution}=requireAuthority(authority)
 const pending=options?.pendingAnnotation?pendingContextRevisions.get(options.pendingAnnotation):undefined
 if(options?.pendingAnnotation&&(!pending||pending.command.kind!=='message_annotation'||pending.execution!==execution||pending.command.sessionId!==execution.lifecycle.sessionId))missing()
 const combined=new ContextScopeAccumulator({sources:structuredClone([...sources])})
 if(pending)combined.note({sources:structuredClone([...(pending.floor.sources??[])])})
 const turnToken=options?.turnToken,stoppedTurnToken=options?.stoppedTurnToken
 const time:PublicationMeasure=options?.measure??((_counter,run)=>run())
 if(turnToken&&stoppedTurnToken)changed()
 if(execution.lifecycle.sessionPersisted===false||!(execution.identity.kind==='attended'&&execution.identity.principal.kind==='workspace_member')
  &&!nativeDelegatedSessionPublication(execution)&&!programmaticPublications.has(execution))changed()
 // The annotation is admitted inside the locked publication transaction: its
 // closure view reads the witness here, before any lock is taken.
 const annotationClosure=pending?beginClosureAdmission(execution,{locked:true}):undefined
 await annotationClosure?.ready()
 return transaction(authority,combined.evidence.sources??[],'retain',async(client,_checked,annotationChecked)=>{
  const checked=pending?(annotationChecked??await time('publication_annotation_validate',()=>validateCallerScopeEvidence(pending.floor,execution.security.ceiling,client,undefined,annotationClosure))):undefined
  const frame={authority,pending,checked,annotationPublished:false}
  messagePublications.set(client,frame)
  try{
   const result=await run(client)
   if(pending&&!frame.annotationPublished)changed()
   return result
  }finally{messagePublications.delete(client)}
 },execution.lifecycle.sessionId,stoppedTurnToken,turnToken,false,undefined,options?.measure,pending?.floor,options?.bufferedCommand,
 options?.publicConversation ? structuredClone(options.publicConversation) : undefined)
}
/** A JSON descriptor, owner transaction or retained callback cannot mint a live frame. */
export function assertSessionMessagePublicationFrame(client:object,authority:SessionContextAuthority):{
 parentId:string;id:string;content:Record<string,unknown>;producer:string;sources:ScopeSource[];expectedRevision:string|null;expectedGeneration:string|null
}|undefined{
 const frame=messagePublications.get(client)
 if(frame?.authority!==authority)missing()
 if(!frame.pending)return undefined
 if(frame.annotationPublished||frame.pending.execution!==authority.execution||!frame.checked)changed()
 const {pending,checked}=frame
 return structuredClone({parentId:pending.parentId,id:pending.id,content:pending.command.content,producer:pending.evidence.producer,
  sources:checked.sources??[],expectedRevision:pending.command.expectedRevision??null,expectedGeneration:pending.command.expectedGeneration??null})
}
/** The transaction owns result validation and requires its pending effect exactly once. */
export function acceptSessionMessagePublicationAnnotation(client:object,authority:SessionContextAuthority,result:unknown):void{
 const frame=messagePublications.get(client)
 if(frame?.authority!==authority||!frame.pending||!frame.checked||frame.annotationPublished)missing()
 if(!decodePreparedSessionContextRevision(frame.pending,frame.checked,result as ContextRevisionPublicationResult))changed()
 frame.annotationPublished=true
}

const REVISION_COHORT_SIZE = 8
type RevisionHead = Omit<SessionContextRevision,'content'>

/** Each native proof remains specific to its own current revision. */
async function readRevisionCohort(authority: SessionContextAuthority, candidates: RevisionHead[]) {
  const { execution } = authority
  const { workspaceId } = execution.security.access
  return readRetainedContextFrame(authority, [], async client => {
    const { cohorts } = await readConversationPreparation(client, workspaceId, {
      cohorts: candidates.map(c => [c.source]),
    })
    const readable: string[] = []
    const independent = new Set<string>()
    for (let i = 0; i < candidates.length; i++) {
      const {id, source} = candidates[i]
      const proof = cohorts[i]
      if (proof === null) { independent.add(id); continue }
      if (proof.kind === 'refused') continue
      if (proof.kind !== 'complete' || !proof.current.some(current =>
        current.resourceKind===source.resourceKind && current.resourceId===source.resourceId
        && current.version===source.version && resourceScopeKey(current)===resourceScopeKey(source))) changed()
      try { assertPreparedConversationCohortEvidence({sources:[source]}, execution.security.ceiling, proof) }
      catch (error) {
        const failure = scopeEvidenceFailureOf(error)
        if (failure && ['user_visibility','assistant_visibility','clearance','teams','projects'].includes(failure)) continue
        throw error
      }
      readable.push(id)
    }
    const payloads = readable.length ? (await client.query<{id:string; content:Record<string,unknown>|null}>(
      `SELECT revision.id,public.read_session_context_revision($1,revision.id) AS content
        FROM unnest($2::uuid[]) AS revision(id)`, [workspaceId,readable])).rows : []
    return { independent, payloads: new Map(payloads.map(row => [row.id,row.content])) }
  })
}

/** Discover immutable metadata only. Historical plaintext is never selected. */
export async function readSessionContextRevisions(sessionId: string, kind: SessionContextKind,
  authority?: SessionContextAuthority, options?: { includePromoted?: boolean; parentId?: string }): Promise<SessionContextRevision[]> {
  if (!authority) return []
  const { execution } = requireAuthority(authority)
  await execution.security.authority.assertCurrent()
  const workspaceId = execution.security.access.workspaceId
  const discovered = (await getPool().query<RevisionHead>(`SELECT r.id,r.parent_id AS "parentId",r.session_id AS "sessionId",
    read_scope_source(r.workspace_id,'session_context_revision',r.id) AS source,s.user_id AS "userId",s.assistant_id AS "assistantId",
    r.created_at AS "createdAt",coalesce(e.last_accessed_at,r.created_at) AS "lastAccessedAt",
    coalesce(e.access_count,0) AS "accessCount",coalesce(e.survival_count,0) AS "survivalCount"
    FROM session_context_scope_revisions r JOIN sessions s ON s.workspace_id=r.workspace_id AND s.id=r.session_id
    LEFT JOIN session_state st ON r.parent_kind='session_state' AND st.id=r.parent_id AND st.scope_revision_id=r.id AND st.session_id=r.session_id
    LEFT JOIN episodic_memories e ON r.parent_kind='episodic_memory' AND e.id=r.parent_id AND e.scope_revision_id=r.id AND e.session_id=r.session_id
    LEFT JOIN session_message_annotation_heads annotation ON r.parent_kind='message_annotation' AND annotation.message_id=r.parent_id AND annotation.scope_revision_id=r.id AND annotation.workspace_id=r.workspace_id AND annotation.session_id=r.session_id
    LEFT JOIN session_title_heads title ON r.parent_kind='session_title' AND title.scope_revision_id=r.id AND title.workspace_id=r.workspace_id AND title.session_id=r.session_id
    WHERE r.workspace_id=$1 AND r.session_id=$2 AND r.parent_kind=$3 AND ($5::uuid IS NULL OR r.parent_id=$5)
      AND (title.session_id IS NOT NULL OR annotation.message_id IS NOT NULL OR st.id IS NOT NULL OR e.id IS NOT NULL AND ($4::boolean OR e.promoted_memory_id IS NULL) OR r.parent_kind='compact_summary' AND s.compact_scope_revision_id=r.id)
    ORDER BY r.id`, [workspaceId,sessionId,kind,options?.includePromoted === true,options?.parentId ?? null])).rows
  const candidates = discovered.flatMap(candidate => {
    if (!candidate.source || candidate.source.resourceKind !== 'session_context_revision' || (candidate.source as ScopeSource & { held?: boolean }).held !== false) return []
    const {workspaceId: sourceWorkspace,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}=candidate.source
    const source:ScopeSource={workspaceId:sourceWorkspace,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}
    return [{...candidate,source}]
  })
  const readOne = async ({id,source}: RevisionHead) => {
    // A withdrawn independent source holds this entry. It must not poison a
    // different entry or another reader's immutable observation.
    try {
      // The current-head SQL reader owns title admission for every native
      // closure. The transaction and later delivery remain fresh operations.
      return await transaction(authority,[source],'context',async client =>
        (await client.query<{ content: Record<string,unknown> | null }>(kind === 'session_title'
          ? 'SELECT read_session_title_revision($1,$2,$3) AS content' : 'SELECT read_session_context_revision($1,$2) AS content',
          kind === 'session_title' ? [workspaceId,sessionId,id] : [workspaceId,id])).rows[0]?.content)
    } catch (error) {
      // A failed database acquisition withholds the whole optional title page.
      // It must reach the receiving boundary before per-entry denial handling.
      let cause:unknown=error
      const seen=new Set<object>()
      for(let depth=0;depth<16&&typeof cause==='object'&&cause!==null&&!seen.has(cause);depth++){
        seen.add(cause)
        if('code'in cause&&['57014','55P03'].includes(String(cause.code)))throw cause
        cause='cause'in cause?cause.cause:undefined
      }
      if (error instanceof DerivedScopeError || typeof error === 'object' && error !== null
        && ('reason' in error && error.reason === 'caller_evidence_unavailable' || 'code' in error && error.code === 'source_access_denied')) return null
      throw error
    }
  }

  const useCohort = conversationReadersActive() && kind!=='session_title'
    && execution.lifecycle.sessionPersisted && execution.lifecycle.sessionId===sessionId
    && execution.identity.kind==='attended' && execution.identity.principal.kind==='workspace_member'
    && execution.identity.principal.authenticationKind==='native_session' && execution.ownership.kind==='workspace'
    && execution.ownership.workspaceId===workspaceId && !execution.surface.systemRead && !execution.surface.clientSelfMemory
    && !execution.security.access.systemRead && !getApplicationExecutionBinding(execution)
  const size = useCohort ? REVISION_COHORT_SIZE : 1
  const rows: SessionContextRevision[] = []
  for (let offset = 0; offset < candidates.length; offset += size) {
    const chunk = candidates.slice(offset,offset+size)
    const cohort = chunk.length>1 ? await readRevisionCohort(authority,chunk) : undefined
    for (const candidate of chunk) {
      const content = !cohort || cohort.independent.has(candidate.id)
        ? await readOne(candidate) : cohort.payloads.get(candidate.id)
      if (content) rows.push(bindScopeSource({...candidate,content},candidate.source))
    }
  }
  return rows
}

/** Metadata CAS token; never a content count or an authorization result. */
export async function sessionContextGeneration(sessionId: string): Promise<string> {
  const value=(await getPool().query<{generation:string}>('SELECT session_context_generation::text AS generation FROM sessions WHERE id=$1',[sessionId])).rows[0]?.generation
  if(value===undefined)changed()
  return value
}

type SessionContextRevisionInput = {
  sessionId: string; parentId?: string; kind: SessionContextKind; content: Record<string, unknown>
  authority?: SessionContextAuthority; derivation?: DerivedWriteEvidence; expectedRevision?: string
  expectedCursor?: number | null; expectedGeneration?: string
}
/** Snapshot a semantic command, never an authorization or a publication receipt. */
export async function prepareSessionContextRevision(input:SessionContextRevisionInput):Promise<object> {
  const authority = requireAuthority(input.authority), { execution } = authority
  // Snapshot semantic inputs before the first await. The original live
  // authority is not serializable and must remain the canonical instance.
  const command = structuredClone({ sessionId: input.sessionId, parentId: input.parentId, kind: input.kind,
    content: input.content, derivation: input.derivation, expectedRevision: input.expectedRevision,
    expectedCursor: input.expectedCursor, expectedGeneration: input.expectedGeneration })
  // Target session is a real persisted invocation, but read sources may be
  // different sessions authorized under the same canonical actor.
  if (execution.lifecycle.sessionPersisted === false || execution.lifecycle.sessionId !== command.sessionId || execution.surface.readOnly) changed()
  const accumulated = new ContextScopeAccumulator(execution.security.provenance)
  accumulated.note(authority.accumulator.evidence)
  if (!command.derivation) missing()
  accumulated.note({ sources: command.derivation.sources })
  if (command.kind==='message_annotation') {
    if (!command.parentId) missing()
    const native=(await getPool().query<{source:ScopeSource & {held?:boolean}}>(`SELECT read_scope_source($1,'session_message',id) AS source
      FROM session_messages WHERE workspace_id=$1 AND session_id=$2 AND id=$3`,
      [execution.security.access.workspaceId,command.sessionId,command.parentId])).rows[0]?.source
    if (!native || native.held!==false) changed()
    const {workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version}=native
    accumulated.noteSource({workspaceId,userId,assistantId,sensitivity,compartments,projectIds,resourceKind,resourceId,version})
  }
  const originalEvidence = accumulated.evidence
  const evidence: DerivedWriteEvidence = { producer: command.derivation.producer, sources: originalEvidence.sources ?? [] }
  deriveWriteScope(evidence, { workspaceId: execution.security.access.workspaceId, userId: execution.security.access.userId,
    assistantId: null, sensitivity: 'public', compartments: [], projectIds: [] }, execution.security.access.userId)
  // Discovery prepares external authority without turning history's qualified
  // own fields into independent original inputs. Field projection needs the
  // actual admitted client and the complete original root set.
  const preparedEvidence = new ContextScopeAccumulator(originalEvidence)
  preparedEvidence.note({ sources: await readExternalSourceAncestors(execution.security.access.workspaceId,evidence.sources) })
  const parentId=command.parentId??randomUUID(),id=randomUUID()
  const pending=Object.freeze({})
  pendingContextRevisions.set(pending,{authority,execution,command,id,parentId,evidence,floor:preparedEvidence.evidence})
  return pending
}

/** One semantic writer consumes detached commands, never token-owned callbacks. */
async function writePreparedSessionContextRevision(pending:PendingSessionContextRevision,client:PoolClient,checked:ScopeEvidence):Promise<SessionContextRevision|null>{
 const {execution,authority,command,id,parentId,evidence}=pending,payload=command.content
 if(authority.execution!==execution)changed()
 const publicationSources = checked.sources ?? []
 const result=(await client.query<{value:{source:ScopeSource;createdAt:string;userId:string;assistantId:string}|null}>(
   'SELECT publish_native_session_context_revision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value',
   [execution.security.access.workspaceId,command.sessionId,command.kind,(command.kind==='compact_summary'||command.kind==='session_title')?command.sessionId:parentId,id,
    payload,evidence.producer,JSON.stringify(publicationSources),command.expectedRevision??null,command.expectedGeneration??null,command.expectedCursor??null])).rows[0]?.value
 if(!result)return null
 return decodePreparedSessionContextRevision(pending,checked,result)
}
type ContextRevisionPublicationResult={source:ScopeSource;createdAt:string;userId:string;assistantId:string}|null
function decodePreparedSessionContextRevision(pending:PendingSessionContextRevision,checked:ScopeEvidence,result:ContextRevisionPublicationResult):SessionContextRevision|null{
 if(!result)return null
 const {execution,command,id,parentId}=pending,payload=command.content
 const source=result.source
 if(source.workspaceId!==execution.security.access.workspaceId||source.resourceKind!=='session_context_revision'||source.resourceId!==id||source.version!=='1')changed()
 // Metadata-only own-reference labels are still destination requirements.
 // Refuse rather than stamp a narrower result or fabricate a factual source.
 if(RANK[source.sensitivity]<RANK[checked.sensitivity??'public']
   ||!scopeGrantContains(source.compartments,checked.compartments)||!scopeGrantContains(source.projectIds,checked.projectIds))changed()
 const createdAt=new Date(result.createdAt)
 return bindScopeSource({id,parentId:(command.kind==='compact_summary'||command.kind==='session_title')?command.sessionId:parentId,sessionId:command.sessionId,source,content:payload,
   userId:result.userId,assistantId:result.assistantId,createdAt,lastAccessedAt:createdAt,accessCount:0,survivalCount:0},source)
}

/** Canonical semantic write; pointer/CAS/receipt and payload commit together. */
export async function writeSessionContextRevision(input:SessionContextRevisionInput):Promise<SessionContextRevision|null> {
  const token=await prepareSessionContextRevision(input),pending=pendingContextRevisions.get(token)!
  const {authority}=pending
  if(authority.execution!==pending.execution)missing()
  const stored=await transaction(authority,pending.floor.sources??[],'retain',(client,checked)=>writePreparedSessionContextRevision(pending,client,checked),pending.command.sessionId,undefined,undefined,false,pending.floor)
  if (stored) authority.accumulator.note({ sources: boundScopeSources(stored) })
  return stored
}

/** Nonsemantic counters and retention deletes keep the same current source gate. */
export async function mutateSessionContextParents(authority: SessionContextAuthority | undefined,
  kind: 'session_state' | 'episodic_memory', rows: readonly SessionContextRevision[], action: 'delete' | 'access' | 'survive'): Promise<number> {
  requireAuthority(authority)
  if (!rows.length) return 0
  return transaction(authority!, rows.map(row=>row.source),'context',async client => {
    for (const row of rows) {
      const admitted = (await client.query<{ allowed: boolean }>('SELECT session_context_revision_allowed($1,$2) AS allowed',
        [row.source.workspaceId,row.id])).rows[0]?.allowed
      if (admitted !== true) changed()
    }
    const table = kind === 'session_state' ? 'session_state' : 'episodic_memories'
    if (kind==='session_state' && action!=='delete') changed()
    const prefix = action==='delete' ? `DELETE FROM ${table}` : action==='access'
      ? `UPDATE ${table} SET last_accessed_at=now(),access_count=access_count+1`
      : `UPDATE ${table} SET survival_count=survival_count+1`
    const result = await client.query(`${prefix} WHERE scope_revision_id=ANY($1::uuid[]) RETURNING id`,[rows.map(row=>row.id)])
    return result.rowCount ?? 0
  },undefined,undefined,undefined,true)
}

/** Presentation only: the episode retains its exact stored grouping identity. */
export function sessionTopicGraduationPresentation(topicLabel: string): { summary: string; tags: string[] } {
  return isTopicIdentity(topicLabel)
    ? { summary: 'Recurring topic from session history', tags: ['episodic-graduation', 'recurring-topic'] }
    : { summary: `Recurring topic: ${topicLabel}`, tags: ['episodic-graduation', topicLabel] }
}

/** Canonical episode promotion; only admitted immutable payloads reach the writer. */
export async function promoteSessionContextEpisode(parentId: string, inputAuthority: SessionContextAuthority): Promise<{ memoryId: string; created: boolean }> {
  const authority = requireAuthority(inputAuthority), { execution } = authority
  if (execution.lifecycle.sessionPersisted === false || execution.surface.readOnly) changed()
  const row = (await readSessionContextRevisions(execution.lifecycle.sessionId ?? '', 'episodic_memory', authority, { includePromoted: true }))
    .find(candidate => candidate.parentId === parentId)
  if (!row) changed()
  const { topicLabel, summary } = row.content
  if (typeof topicLabel !== 'string' || !topicLabel || typeof summary !== 'string' || !summary) changed()
  const accumulated = new ContextScopeAccumulator(execution.security.provenance)
  accumulated.note(authority.accumulator.evidence)
  accumulated.note({ sources: boundScopeSources(row) })
  const derivation: DerivedWriteEvidence = { producer: 'compaction:episodic-promotion', sources: accumulated.evidence.sources ?? [] }
  const result = await transaction(authority, derivation.sources, 'retain', async (client, checked) => {
    const current = (await client.query<{ revision: string; promoted: string | null; access: number; survival: number }>(`SELECT scope_revision_id AS revision,promoted_memory_id AS promoted,access_count AS access,survival_count AS survival
      FROM episodic_memories WHERE id=$1 AND session_id=$2 FOR UPDATE`, [parentId,execution.lifecycle.sessionId])).rows[0]
    if (!current || current.revision !== row.id) changed()
    if (current.promoted) return { memoryId: current.promoted, created: false }
    if (current.access < 1 || current.survival + 1 < 3) changed()
    const allowed = (await client.query<{ allowed: boolean }>('SELECT session_context_revision_allowed($1,$2) AS allowed', [row.source.workspaceId,row.id])).rows[0]?.allowed
    if (allowed !== true) changed()
    const memory = await createMemory({
      workspaceId: row.source.workspaceId, assistantId: execution.assistant.id,
      userId: row.source.userId, derivationTarget: { userId: row.source.userId, assistantId: row.source.assistantId },
      ...sessionTopicGraduationPresentation(topicLabel), detail: summary,
      scope: row.source.userId ? 'private' : 'shared', sensitivity: row.source.sensitivity,
      compartments: row.source.compartments, projectIds: row.source.projectIds,
      source: 'episodic-graduation', sourceSessionId: row.sessionId,
      confidence: 0.7, createdByUserId: execution.security.access.userId, createdByAssistantId: execution.assistant.id,
      // The retained transaction owns the complete admitted source closure.
      // Recording only the episode root loses independent retention witnesses.
      derivation: { ...derivation, sources: checked.sources ?? [] },
    }, undefined, client)
    await client.query('UPDATE episodic_memories SET promoted_memory_id=$2 WHERE id=$1 AND scope_revision_id=$3', [parentId,memory.id,row.id])
    return { memoryId: memory.id, created: true }
  }, execution.lifecycle.sessionId,undefined,undefined,true)
  authority.accumulator.note({ sources: boundScopeSources(row) })
  return result
}

/** Only the canonical retained-Goal resolver can issue the exact execution
 * object recognized by the source admission module. Caller JSON/AccessContext
 * and a fresh createExecutionContext do not carry that private capability. */
export function writeRetainedGoalWorkflowContextFrame<T>(authority:SessionContextAuthority,sources:readonly ScopeSource[],publish:(client:PoolClient)=>Promise<T>):Promise<T>{
 const {execution}=requireAuthority(authority),source=execution.security.authority.snapshotSource?.()
 if(execution.identity.kind!=='system'||execution.identity.purpose!=='workflow'||source?.kind!=='workflow'
  ||source.runId!==execution.identity.jobId||source.workspaceId!==execution.security.access.workspaceId
  ||source.authorityUserId!==execution.security.access.userId||source.executingAssistantId!==execution.assistant.id
  ||execution.ownership.kind!=='workspace'||execution.surface.readOnly||execution.surface.systemRead
  ||execution.lifecycle.abortSignal.aborted)missing()
 const roots=structuredClone(sources)
 return transaction(authority,roots,'retain',async client=>{
  await admitRetainedGoalWorkflowWrite(execution,roots,client)
  const result=await publish(client)
  await admitRetainedGoalWorkflowWrite(execution,roots,client);return result
 },undefined,undefined,undefined,true)
}
