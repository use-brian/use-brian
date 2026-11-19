import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import type { ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { DerivedScopeError, deriveResourceScope, resourceScopeKey, type DerivedWriteEvidence, type ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { currentApplicationReadTransaction, getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import { captureSessionAuthority } from '../context-scope/authority-lease.js'
import { sessionAuthorityFactsParameters } from '../context-scope/session-authority-facts.js'
import { getPool, query } from './client.js'
import { conversationReadersActive } from './conversation-visibility.js'
import { createMemory, legacySoulContentSql, preparePromptIdentityRead } from './memories.js'
import { beginBrainAdmission } from '../workspace-access/brain-create-admission.js'
import { buildMemoryAccessPredicate } from './memory-access-predicate.js'
import { preferredDeliveryChannelSql } from './sessions.js'
import { providerChannelIdFromSession } from './session-channel-id.js'

/** Source-validated transaction; model-provided slot keys never confer authority. */
export async function writeScopedSummary(params: {
  assistantId: string; userId: string; kind: 'soul' | 'domain'; slotKey: string;
  content: string; derivation: DerivedWriteEvidence;
}): Promise<void> {
  if (!params.content.trim()) return
  const floor = deriveResourceScope(params.derivation)
  const scopeKey = resourceScopeKey(floor)
  const identity = [floor.workspaceId,params.userId,params.assistantId,params.kind,params.slotKey,scopeKey]
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    // Match canonical writers' workspace-before-resource lock order.
    await beginBrainAdmission(client, floor.workspaceId)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(identity)])
    const { rows } = await client.query<{ memoryId: string }>(
      `SELECT s.memory_id AS "memoryId" FROM memory_summary_slots s
       JOIN memories m ON m.id=s.memory_id AND m.workspace_id=s.workspace_id
       WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.owner_assistant_id=$3 AND s.kind=$4 AND s.slot_key=$5 AND s.scope_key=$6 FOR UPDATE OF s,m`,identity,
    )
    const common = { summary: params.content.slice(0,100),detail: params.content,
      sensitivity: floor.sensitivity,compartments: floor.compartments,projectIds: floor.projectIds,
      derivation: params.derivation }
    // A regenerated summary is not an edit of the previous output: its only
    // inputs are the synthesis evidence. updateMemory would add the predecessor
    // as an input, making later ancestor invalidation hold the current summary
    // itself, so the new row is created fresh and the old one is retired.
    //
    // Retirement is NOT a source change and holds nothing. The previous row's
    // content and labels stay exactly what every reader saw, and the slot is
    // keyed by the same scope key, so a memory that read it (every turn notes
    // the SOUL into its derivation evidence) keeps a correct floor. Holding its
    // descendants here hid every memory saved from such a turn on each Deep
    // tick (context-engine/memory-consolidation.md -> "Regeneration retires,
    // it does not hold"). A real input change still holds the whole lineage
    // through the source's own version trigger.
    const previous = rows[0]
    if (previous) {
      // Retire before validation so a direct citation of this output is
      // rejected (`scope_source_changed`). A failed create rolls it back.
      await client.query(`UPDATE memories SET valid_to=COALESCE(valid_to,now()),updated_at=now()
        WHERE workspace_id=$1 AND id=$2`,[floor.workspaceId,previous.memoryId])
    }
    const memory = await createMemory({ ...common,workspaceId: floor.workspaceId,assistantId: params.assistantId,
      userId: params.userId,createdByUserId: params.userId,createdByAssistantId: params.assistantId,
      source: 'consolidation',tags: [`consolidation:${params.kind}`],scope: 'shared' },undefined,client)
    if (previous) {
      // Retain history without introducing a derivation edge to the predecessor.
      await client.query(`UPDATE memories SET superseded_by=$3
        WHERE workspace_id=$1 AND id=$2`,[floor.workspaceId,previous.memoryId,memory.id])
    }
    await client.query(
      `INSERT INTO memory_summary_slots(workspace_id,owner_user_id,owner_assistant_id,kind,slot_key,scope_key,memory_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(workspace_id,owner_user_id,owner_assistant_id,kind,slot_key,scope_key)
       DO UPDATE SET memory_id=EXCLUDED.memory_id,updated_at=now()`,[...identity,memory.id],
    )
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}

type SoulContextRow = { scoped: Array<ScopeSource & { content: string }> | null; legacyContent: string | null }

function soulContextSelection(access: AccessContext, appId?: string) {
  const ap = buildMemoryAccessPredicate(access,{ alias: 'm',startIdx: 6 })
  return {sql:`WITH scoped AS (
       SELECT m.detail AS content,m.id AS "resourceId",'memory' AS "resourceKind",m.scope_version::text AS version,
         m.workspace_id AS "workspaceId",m.user_id AS "userId",m.assistant_id AS "assistantId",
         m.sensitivity,m.compartments,m.project_ids AS "projectIds",s.slot_key,s.scope_key
       FROM memory_summary_slots s JOIN memories m ON m.id=s.memory_id AND m.workspace_id=s.workspace_id
       WHERE s.workspace_id=$4 AND s.owner_user_id=$2 AND s.owner_assistant_id=$1 AND s.kind='soul'
         AND s.slot_key=ANY($5::text[]) AND m.valid_to IS NULL AND m.retracted_at IS NULL AND ${ap.sql}
     ), visible AS (
       SELECT jsonb_agg(to_jsonb(scoped)-'slot_key'-'scope_key' ORDER BY slot_key,scope_key) AS sources FROM scoped
     )
     SELECT sources AS scoped,
       CASE WHEN sources IS NOT NULL THEN NULL
         WHEN EXISTS(SELECT 1 FROM memory_summary_slots s JOIN memories m ON m.id=s.memory_id
           WHERE s.workspace_id=$4 AND s.owner_user_id=$2 AND s.owner_assistant_id=$1
             AND s.kind='soul' AND m.learning IS NOT NULL) THEN NULL
         WHEN EXISTS(SELECT 1 FROM workspace_access_policies WHERE workspace_id=$4 AND classification_mode<>'legacy') THEN NULL
         ELSE ${legacySoulContentSql}
       END AS "legacyContent"
     FROM visible`,
    params:[access.assistantId,access.userId,appId || null,access.workspaceId,
      appId ? ['shared',`app:${appId}`] : ['shared'],...ap.params],
  }
}

function soulContext(row?: SoulContextRow): { content: string | null; evidence: ScopeEvidence } {
  if (!row?.scoped) return { content: row?.legacyContent ?? null, evidence: {} }
  const sources = row.scoped.map(({ content: _content,...source }) => source)
  const floor = deriveResourceScope({ producer: 'soul-context',sources })
  return { content: row.scoped.map(summary => summary.content).filter(Boolean).join('\n\n') || null,
    evidence: { sensitivity: floor.sensitivity,compartments: floor.compartments,projectIds: floor.projectIds,sources } }
}

/** Full evidence accompanies text, so prompt assembly cannot lose its floor. */
export async function getSoulContext(access: AccessContext, appId?: string) {
  const {sql,params}=soulContextSelection(access,appId)
  return soulContext((await query<SoulContextRow>(sql,params)).rows[0])
}

/** The ordinary system pool's existing prompt selectors share a live private chat read. */
export async function getNativePromptAuxiliaryContext(viewer: AccessContext, appId: string, authority: SessionContextAuthority) {
  const execution=authority.execution, {access}=execution.security
  if(!conversationReadersActive() || viewer.systemRead || currentApplicationReadTransaction(viewer)
    || viewer.sharedAudience || access.sharedAudience || access.systemRead || execution.surface.systemRead || execution.surface.clientSelfMemory
    || execution.identity.kind!=='attended' || execution.identity.principal.kind!=='workspace_member'
    || execution.identity.principal.authenticationKind!=='native_session' || execution.identity.principal.userId!==viewer.userId
    || execution.ownership.kind!=='workspace' || execution.ownership.workspaceId!==viewer.workspaceId
    || execution.lifecycle.channelType!=='web' || getApplicationExecutionBinding(execution)
    || viewer.userId!==access.userId || viewer.workspaceId!==access.workspaceId || viewer.assistantId!==execution.assistant.id) return null

  const {sql,params}=soulContextSelection(viewer,appId)
  const offset=params.length
  const facts=Array.from({length:9},(_,index)=>`$${offset+index+1}`).join(',')
  const session=`$${offset+4}`, token=`$${offset+10}`
  const identityRead=preparePromptIdentityRead(viewer,authority,offset+11)
  execution.lifecycle.abortSignal.throwIfAborted()
  const captured=await captureSessionAuthority(execution.security.authority,async input=>{
    if(!input.turn || !input.credential || input.workspaceId!==viewer.workspaceId || input.userId!==viewer.userId
      || input.assistantId!==viewer.assistantId || input.sessionId!==execution.lifecycle.sessionId) return null
    const value=(await query<{
      authority:unknown; summary:SoulContextRow; preferred:{channelType:string;channelId:string}|null
      workspace:{name:string;purpose:string}|null; memoryEvolution:string|null; brainEvolution:string|null
      identitySource:ScopeSource|null
    }>(`WITH live AS MATERIALIZED (
      SELECT public.read_session_authority_facts(${facts}) AS authority
      FROM public.sessions s WHERE s.workspace_id=$4 AND s.user_id=$2 AND s.assistant_id=$1 AND s.id=${session}
        AND s.channel_type='web' AND s.app_origin='chat' AND s.anchor_kind='none' AND s.anchor_ref IS NULL
        AND s.visibility IN('owner','personal') AND s.mode IS DISTINCT FROM 'draft'
        AND s.status='running' AND s.turn_lease_token=${token} AND s.last_turn_lease_token=${token}
        AND coalesce(s.turn_assistant_id,s.assistant_id)=$1 AND s.cancel_requested_at IS NULL
        AND s.turn_heartbeat_at>clock_timestamp()-interval '90 seconds'
    ) SELECT live.authority,
      (SELECT to_jsonb(summary) FROM (${sql}) summary) AS summary,
      (SELECT to_jsonb(preferred) FROM (${preferredDeliveryChannelSql()}) preferred) AS preferred,
      (SELECT jsonb_build_object('name',w.name,'purpose',w.purpose) FROM public.workspaces w WHERE w.id=$4) AS workspace,
      (SELECT prompt_snippet FROM public.workspace_memory_evolution WHERE workspace_id=$4) AS "memoryEvolution",
      (SELECT prompt_snippet FROM public.workspace_brain_evolution WHERE workspace_id=$4) AS "brainEvolution",
      (${identityRead.sql}) AS "identitySource"
      FROM live WHERE live.authority->'credentialCurrent'='true'::jsonb
        AND live.authority->'member'<>'null'::jsonb`,[...params,...sessionAuthorityFactsParameters(input),input.turn.token,...identityRead.params])).rows[0]
    if(!value)throw new DerivedScopeError('scope_source_changed')
    return {authority:value.authority,value}
  })
  execution.lifecycle.abortSignal.throwIfAborted()
  if(!captured)return null
  const {summary,preferred,workspace,memoryEvolution,brainEvolution,identitySource}=captured.value
  const identity=await identityRead.project(identitySource)
  execution.lifecycle.abortSignal.throwIfAborted()
  return {soul:soulContext(summary),workspace,
    preferred:preferred?{...preferred,channelId:providerChannelIdFromSession(preferred.channelType,preferred.channelId)}:null,
    evolution:[memoryEvolution,brainEvolution].filter((part):part is string=>!!part).join('\n\n')||null,identity}
}
