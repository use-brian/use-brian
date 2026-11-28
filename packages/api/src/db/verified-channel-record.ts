/** Native record floor for an already verified provider ingress.
 * [COMP:api/conversation-visibility] */
import { sessionKindSql } from '../session-kind.js'
import { resolveWriteScope, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { maxSensitivity, type Sensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import { DerivedScopeError } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { z } from 'zod'
import type { ClientBase } from 'pg'
import { query } from './client.js'
import type { Session } from './sessions.js'
import type { TelegramKnowledgeGroup } from '../context-scope/telegram-knowledge-audience.js'

export type ChannelRecordAddress = {
  session: Pick<Session,'id'|'channelType'|'channelId'>
  workspaceId: string
  assistantId: string
  userId: string
  member: boolean
  room: boolean
  integrationId?: string
}

export type ChannelRecordEnvelope = {
  version: string
  visibility: 'workspace' | 'configured_private' | 'private_by_kind'
  cap: Sensitivity
  compartments: string[]
  projects: string[]
}
export type ChannelRecordPublication = { address: ChannelRecordAddress; version: string }
const verifiedSelections = new WeakMap<ExecutionContext,ChannelRecordPublication>()

/** The ingress binds the exact record to its original verified execution. */
export function bindVerifiedChannelSelection(execution: ExecutionContext, binding: ChannelRecordPublication): void {
  const address=binding.address
  if (!address.member || execution.identity.kind!=='attended' || execution.identity.principal.kind!=='workspace_member'
      || execution.identity.principal.authenticationKind!=='verified_channel'
      || execution.security.access.userId!==address.userId || execution.security.access.workspaceId!==address.workspaceId
      || execution.assistant.id!==address.assistantId || execution.lifecycle.sessionId!==address.session.id
      || execution.lifecycle.channelType!==address.session.channelType || verifiedSelections.has(execution))
    throw new DerivedScopeError('scope_source_changed')
  verifiedSelections.set(execution,structuredClone(binding))
}

export async function selectVerifiedChannelHistory(execution: ExecutionContext, candidateIds: readonly string[]) {
  const binding=verifiedSelections.get(execution)
  if (!binding) return undefined
  const ids=await readVerifiedChannelRecordIds(binding.address,binding.version,candidateIds)
  if (!ids) throw new DerivedScopeError('scope_source_changed')
  return ids
}
const envelopeSchema = z.object({version:z.string().regex(/^[1-9][0-9]*$/),
  visibility:z.enum(['workspace','configured_private','private_by_kind']),cap:z.enum(['public','internal','confidential']),
  compartments:z.array(z.string()),projects:z.array(z.string().uuid())}).strict()

export async function pinVerifiedChannelPublication(client: Pick<ClientBase,'query'>, binding: ChannelRecordPublication, token: string) {
  const {address,version}=binding
  try {
    const value=(await client.query<{ value:unknown }>(`SELECT public.pin_verified_channel_conversation_append(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value`,[address.workspaceId,address.session.id,address.userId,address.assistantId,
      address.session.channelType,address.session.channelId,address.member,address.room,version,token,address.integrationId??null])).rows[0]?.value
    const floor=envelopeSchema.parse(value)
    if(floor.version!==version)throw new DerivedScopeError('scope_source_changed')
    return floor
  } catch(error) {
    if((error as {code?:string;message?:string}).code==='42501'&&(error as Error).message==='conversation_access_denied')
      throw Object.assign(new DerivedScopeError('scope_source_changed'),{cause:error})
    throw error
  }
}

const addressedEnvelope = `SELECT e AS envelope FROM public.conversation_envelopes e
  JOIN public.sessions s ON s.id=e.session_id AND coalesce(s.workspace_id,e.workspace_id)=e.workspace_id
  JOIN public.assistants responder ON responder.id=$5 AND responder.workspace_id=e.workspace_id
  WHERE e.session_id=$1 AND e.workspace_id=$2 AND e.starter_user_id=s.user_id AND s.channel_type=$3 AND s.channel_id=$4
    AND s.archived_at IS NULL AND s.recording_privacy_held IS NOT TRUE
    AND public.scope_review_state_held('session',s.id) IS NOT TRUE
    AND ($9::text IS NULL OR e.version::text=$9)
    AND (($8::boolean AND s.anchor_kind='channel' AND ${sessionKindSql.workspaceEnvelope('e')}) OR
      (NOT $8::boolean AND s.anchor_kind='none' AND s.user_id=$6 AND s.assistant_id=$5))
    AND ($7::boolean AND public.conversation_member_read_allowed(e.workspace_id,s.id,$6) OR
      NOT $7::boolean AND ${sessionKindSql.workspaceEnvelope('e')} AND (s.anchor_kind='channel' OR
        e.cap='public' AND cardinality(e.compartments)=0 AND e.classification='new_public')
      AND NOT EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=e.workspace_id AND m.user_id=$6))`

function addressValues(address: ChannelRecordAddress, version: string | null) {
  return [address.session.id,address.workspaceId,address.session.channelType,address.session.channelId,address.assistantId,
    address.userId,address.member,address.room,version]
}

export async function readVerifiedChannelEnvelope(address: ChannelRecordAddress, version: string | null = null) {
  return (await query<ChannelRecordEnvelope>(`SELECT (bound.envelope).version::text AS version,(bound.envelope).visibility,
    (bound.envelope).cap,(bound.envelope).compartments,public.conversation_hard_project_ids((bound.envelope).compartments) AS projects
    FROM (${addressedEnvelope}) bound`,addressValues(address,version))).rows[0]
}

/** Intersect the retained conversation record with the provider's existing
 * history projection. This does not authorize any independent source. */
export async function readVerifiedChannelRecordIds(address: ChannelRecordAddress, version: string, candidateIds: readonly string[]) {
  const result = await query<{ ids: string[] }>(`SELECT ARRAY(SELECT m.id FROM public.session_messages candidate
    CROSS JOIN LATERAL public.conversation_record_rows(bound.envelope,candidate.sequence_num-1,candidate.sequence_num,
      legacy.allowed,$6,false) m
    WHERE candidate.session_id=(bound.envelope).session_id AND candidate.id=ANY($10::uuid[]) AND m.id=candidate.id) AS ids
    FROM (${addressedEnvelope}) bound
    JOIN public.sessions s ON s.id=(bound.envelope).session_id
    CROSS JOIN LATERAL (SELECT CASE WHEN (bound.envelope).visibility='private_by_kind' THEN
      public.conversation_legacy_enrolled(s.id,(bound.envelope).workspace_id,s.user_id,s.assistant_id) ELSE false END AS allowed) legacy`,
    [...addressValues(address,version),candidateIds])
  return result.rows[0] ? new Set(result.rows[0].ids) : null
}

const recentTextCandidateSchema = z.object({
  sequence: z.number().int().positive(),
  role: z.enum(['user','assistant']),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.object({workspaceId:z.string().uuid(),userId:z.string().uuid().nullable(),assistantId:z.string().uuid().nullable(),
    resourceKind:z.literal('session_message'),resourceId:z.string().uuid(),version:z.string().min(1),
    sensitivity:z.enum(['public','internal','confidential']),compartments:z.array(z.string()),projectIds:z.array(z.string().uuid())}).strict(),
}).strict()
const recentTextSelectionSchema = z.object({
  messages: z.array(recentTextCandidateSchema).max(8),
  quote: recentTextCandidateSchema.nullable(),
}).strict()

export const recentTextDigest = "encode(sha256(convert_to(m.content::text,'UTF8')),'hex')"
const recentTextSlots = 8
export type TelegramTextWindow = Readonly<{ beforeSequence: number; quoteId?: string; includeUnaddressedDialogue?: boolean }>

/** Resolve one original provider address in the exact session or return no
 * quote. The index lookup stops after two matches so ambiguity stays bounded. */
export function exactTelegramQuoteSql(session:string, quote:string, through:string):string {
  return `SELECT q.id,q.sequence_num FROM (
    SELECT candidate.id,candidate.sequence_num,count(*) OVER() AS matches FROM (
      SELECT id,sequence_num FROM public.session_messages WHERE session_id=${session}
        AND channel_message_id=${quote} AND sequence_num<=${through} LIMIT 2
    ) candidate
  ) q WHERE q.matches=1`
}

/** The next older window ends where the current window starts. */
export function previousRecentTextBoundary(beforeSequence: number): number | undefined {
  const boundary = beforeSequence - recentTextSlots
  return boundary > 1 ? boundary : undefined
}

/** A fixed, server-owned selection of bounded metadata under the verified
 * workspace record floor. The room branch of addressedEnvelope applies the
 * workspace audience. The non-owner retained reader admits each selected
 * message and its ancestry before fetching model-visible bytes. */
export async function selectVerifiedChannelRecentText(execution: ExecutionContext, window: TelegramTextWindow, continuation?: TelegramKnowledgeGroup) {
  const pages = await selectVerifiedChannelRecentTextWindows(execution, [window], continuation)
  if (!pages) throw new DerivedScopeError('scope_source_changed')
  return pages[0]!
}

/** Capture all selected pages under one binding and one database snapshot. */
export async function selectVerifiedChannelRecentTextWindows(execution: ExecutionContext, windows: readonly TelegramTextWindow[],
  continuation?: TelegramKnowledgeGroup) {
  const binding = verifiedSelections.get(execution)
  if (execution.lifecycle.channelType !== 'telegram' || !windows.length || windows.some(({beforeSequence}) =>
    !Number.isSafeInteger(beforeSequence) || beforeSequence < 1 || beforeSequence > 2147483647)) {
    throw new DerivedScopeError('scope_source_changed')
  }
  if (continuation && (!binding?.address.room || continuation.sessionId !== binding.address.session.id || continuation.address !== binding.address.session.channelId
    || continuation.integrationId !== binding.address.integrationId || continuation.envelopeVersion !== binding.version)) return null
  const afterSequences = windows.map(({beforeSequence}) => (previousRecentTextBoundary(beforeSequence) ?? 1) - 1)
  const throughSequences = windows.map(({beforeSequence}) => beforeSequence - 1)
  const quoteIds = windows.map(window => window.quoteId ?? null)
  const includeUnaddressed = windows.map(window => window.includeUnaddressedDialogue === true)
  const selectionPayload = `jsonb_build_object('sequence',m.sequence_num,'role',m.role,'digest',${recentTextDigest},
    'source',jsonb_build_object('workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,
      'resourceKind','session_message','resourceId',m.id,'version',m.scope_version::text,'sensitivity',m.sensitivity,
      'compartments',m.compartments,'projectIds',m.project_ids))`
  const textRows = `(m.channel_message_id IS NOT NULL OR page.include_unaddressed) AND octet_length(m.content::text)<=16384
    AND NOT jsonb_path_exists(m.content,'$[*] ? (@.type == "tool_use" || @.type == "tool_result" || @.type == "host_observation")')`
  if (!binding) {
    // Before a verified envelope is available, the ordinary native reader
    // still owns the exact message sources. This query captures only roots.
    const {rows} = await query<{ selection: unknown }>(`SELECT jsonb_build_object('messages',coalesce(
      jsonb_agg(payload ORDER BY seq) FILTER (WHERE in_window),'[]'::jsonb),'quote',
      CASE WHEN count(*) FILTER (WHERE is_quote)=1 THEN (jsonb_agg(payload) FILTER (WHERE is_quote))->0 END) AS selection
      FROM unnest($3::integer[],$4::integer[],$5::text[],$6::boolean[])
        WITH ORDINALITY AS page(after_sequence,through_sequence,quote_id,include_unaddressed,ord)
      LEFT JOIN LATERAL (${exactTelegramQuoteSql('$2','page.quote_id','page.through_sequence')}) quote ON TRUE
      LEFT JOIN LATERAL (
        SELECT ${selectionPayload} AS payload,m.sequence_num AS seq,m.sequence_num>page.after_sequence AS in_window,
          m.id=quote.id AS is_quote
        FROM (
          SELECT recent.* FROM public.session_messages recent WHERE recent.session_id=$2
            AND recent.sequence_num>page.after_sequence AND recent.sequence_num<=page.through_sequence
          UNION ALL
          SELECT exact.* FROM public.session_messages exact WHERE exact.id=quote.id AND exact.sequence_num<=page.after_sequence
        ) m WHERE m.workspace_id=$1 AND m.session_id=$2
          AND public.session_recording_read_allowed(m.session_id) AND m.scope_held IS NOT TRUE
          AND public.scope_review_state_held('session_message',m.id) IS NOT TRUE
          AND m.scope_version IS NOT NULL AND m.role IN ('user','assistant') AND ${textRows}
      ) selected ON TRUE GROUP BY page.ord ORDER BY page.ord`,
    [execution.security.access.workspaceId,execution.lifecycle.sessionId,afterSequences,throughSequences,quoteIds,includeUnaddressed])
    return rows.map(row => recentTextSelectionSchema.parse(row.selection))
  }
  // Keep the metadata-only credential check with the exact page selection.
  // The live lease still owns audience, membership and source admission.
  const continuationBinding = continuation ? `AND s.status='running' AND s.turn_lease_token=$14
    AND s.cancel_requested_at IS NULL AND coalesce(s.turn_assistant_id,s.assistant_id)=$5
    AND EXISTS (SELECT 1 FROM public.linked_identities l WHERE l.provider='telegram' AND l.provider_id=$15 AND l.user_id=$6)
    AND EXISTS (SELECT 1 FROM public.channel_integrations ci JOIN public.channels c ON c.id=ci.channel_id
      WHERE ci.id=$16 AND ci.bot_user_id=$17 AND ci.identity_generation=$18
        AND ci.channel_type='telegram' AND c.channel_type='telegram' AND c.workspace_id=$2
        AND ci.status='active' AND c.status='active')` : ''
  const continuationValues = continuation
    ? [continuation.lease, continuation.speakerId, continuation.integrationId, continuation.botId, continuation.generation] : []
  const recordedTextRows = `${textRows} AND m.workspace_id=$2 AND (NOT $8::boolean OR m.user_id IS NULL)`
  const { rows } = await query<{ selection: unknown }>(`WITH bound AS MATERIALIZED (${addressedEnvelope} ${continuationBinding})
    SELECT jsonb_build_object('messages',coalesce((SELECT jsonb_agg(${selectionPayload} ORDER BY m.sequence_num)
      FROM public.conversation_record_rows(bound.envelope,page.after_sequence,page.through_sequence,false,$6,false) m
      WHERE ${recordedTextRows}), '[]'::jsonb), 'quote',
      (SELECT ${selectionPayload}
        FROM (${exactTelegramQuoteSql('$1','page.quote_id','page.through_sequence')}) candidate
        CROSS JOIN LATERAL public.conversation_record_rows(bound.envelope,candidate.sequence_num-1,candidate.sequence_num,false,$6,false) m
        WHERE m.id=candidate.id AND ${recordedTextRows})) AS selection
    FROM bound CROSS JOIN unnest($10::integer[],$11::integer[],$12::text[],$13::boolean[])
      WITH ORDINALITY AS page(after_sequence,through_sequence,quote_id,include_unaddressed,ord)
    ORDER BY page.ord`,
  [...addressValues(binding.address,binding.version),afterSequences,throughSequences,quoteIds,includeUnaddressed,...continuationValues])
  if (rows.length === 0) return null
  if (rows.length !== afterSequences.length) throw new DerivedScopeError('scope_source_changed')
  return rows.map(row => recentTextSelectionSchema.parse(row.selection))
}

export function channelEvidenceFitsEnvelope(envelope: ChannelRecordEnvelope, evidence: ScopeEvidence) {
  const floor = resolveWriteScope({evidence})
  return maxSensitivity(envelope.cap,floor.sensitivity)===envelope.cap
    && floor.compartments.every(label=>envelope.compartments.includes(label))
    && floor.projectIds.every(id=>envelope.projects.includes(id))
}
