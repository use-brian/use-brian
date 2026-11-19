/** Canonical conversation settings port. Routes remain unmounted until the
 * authenticated envelope successor and every protected consumer are active.
 * No fallback query reinterprets the legacy audience as permission.
 * [COMP:api/conversation-visibility] */
import { z } from 'zod'
import type { ConversationVisibilityMetadata, ConversationVisibilityMutation, ConversationCapMutation, ConversationProjectMutation,
  ConversationSettingsUnreadable, ConversationVisibilityErrorCode } from '@use-brian/shared'
import { getAppPool, query, queryWithRLS, rlsGucSettings, rollbackAndRelease } from './client.js'

const uuid = z.string().uuid()
const expectedVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const conversationVisibilityMutationSchema: z.ZodType<ConversationVisibilityMutation> = z.object({
  expectedVersion,
  visibility: z.enum(['configured_private', 'workspace']),
  participantUserIds: z.array(uuid).max(1000).optional(),
}).strict().refine(value => !value.participantUserIds
  || new Set(value.participantUserIds).size === value.participantUserIds.length, 'Duplicate participants')
export const conversationCapMutationSchema:z.ZodType<ConversationCapMutation>=z.object({
  expectedVersion,cap:z.enum(['public','internal','confidential']),
}).strict()
export const conversationProjectMutationSchema:z.ZodType<ConversationProjectMutation>=z.object({
  expectedVersion,projectId:uuid.nullable(),
}).strict()

export const conversationVisibilityMetadataSchema: z.ZodType<ConversationVisibilityMetadata> = z.object({
  conversationVisibility: z.enum(['private_by_kind', 'configured_private', 'workspace']),
  conversationVisibilityVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  conversationCap: z.enum(['public', 'internal', 'confidential']),
  conversationCompartments: z.array(z.string().min(1)),
  conversationProjectIds: z.array(uuid),
  participantUserIds: z.array(uuid),
  capabilities: z.object({ canNarrow:z.boolean(),canWiden:z.boolean(),canManageParticipants:z.boolean(),
    canRaiseCap:z.boolean(),canMoveProject:z.boolean() }).strict(),
}).strict()

export class ConversationVisibilityError extends Error {
  constructor(readonly code: ConversationVisibilityErrorCode, readonly status: 403 | 409) {
    super(code); this.name = 'ConversationVisibilityError'
  }
}
/** Middleware-verified native device identity; SQL freshly validates it too. */
export type ConversationVisibilityActor = { userId:string;authSessionId:string;authVersion:number }
let nativeConversationReads = false
let nativeConversationSettings = false
let nativePageVisitorReads = false
let nativePromptMemorySections = false
let nativeAnchorWriteAdmission = false
let nativeRetainedConversationOutputs = false
let nativePublicConversationHistory = false
let nativeVerifiedChannelPublication = false

/** Edition-shared boot binds the installed SQL capability before mounting
 * routes. An activated native read never falls back after a refusal or error. */
export async function initializeConversationVisibility(): Promise<void> {
  const result = await getAppPool().query<{ reads: boolean; settings: boolean; pageVisitors: boolean; promptMemory: boolean;
    anchorWriteAdmission: boolean; anchorWriteExposed: boolean; retainedOutputs: boolean; retainedOutputOwnerExposed: boolean;
    publicHistory: boolean; publicHistoryOwnerExposed: boolean; publicMemberPublication: boolean; verifiedChannelPublication: boolean }>(`SELECT
    coalesce(has_function_privilege(current_user,to_regprocedure('public.read_conversation_member_tiers(uuid[],boolean)'),'EXECUTE'),false)
    AND to_regprocedure('public.read_native_conversation_history(uuid,uuid,integer)') IS NOT NULL
    AND NOT coalesce(has_function_privilege(current_user,to_regprocedure('public.read_native_conversation_history(uuid,uuid,integer)'),'EXECUTE'),false) AS reads,
    coalesce(has_function_privilege(current_user,to_regprocedure('public.conversation_visibility_settings_ready(integer)'),'EXECUTE'),false) AS settings,
    to_regprocedure('public.read_native_page_conversation_rows(uuid,text)') IS NOT NULL
    AND NOT coalesce(has_function_privilege(current_user,to_regprocedure('public.read_native_page_conversation_rows(uuid,text)'),'EXECUTE'),false) AS "pageVisitors",
    coalesce(has_function_privilege(current_user,to_regprocedure('public.capture_native_prompt_memory_sections(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid)'),'EXECUTE'),false) AS "promptMemory",
    to_regprocedure('public.lock_conversation_member_read(uuid,uuid,uuid)') IS NOT NULL AS "anchorWriteAdmission",
    coalesce(has_function_privilege(current_user,to_regprocedure('public.lock_conversation_member_read(uuid,uuid,uuid)'),'EXECUTE'),false)
      AS "anchorWriteExposed",
    to_regprocedure('public.conversation_record_derivation_current(uuid,text,uuid,text,uuid)') IS NOT NULL
    AND coalesce(has_function_privilege(current_user,to_regprocedure('public.conversation_record_resource_current(uuid,text,uuid,text)'),'EXECUTE'),false)
      AS "retainedOutputs",
    coalesce(has_function_privilege(current_user,to_regprocedure('public.conversation_record_derivation_current(uuid,text,uuid,text,uuid)'),'EXECUTE'),false)
      AS "retainedOutputOwnerExposed",
    to_regprocedure('public.read_public_conversation_history(uuid,jsonb,uuid,text,text,integer)') IS NOT NULL AS "publicHistory",
    coalesce(has_function_privilege(current_user,to_regprocedure('public.read_public_conversation_history(uuid,jsonb,uuid,text,text,integer)'),'EXECUTE'),false)
      AS "publicHistoryOwnerExposed",
    coalesce(has_function_privilege(current_user,to_regprocedure('public.pin_public_member_conversation_publication(uuid,jsonb,uuid,text,text,uuid,bigint,uuid)'),'EXECUTE'),false)
      AS "publicMemberPublication",
    coalesce(has_function_privilege(current_user,to_regprocedure('public.pin_verified_channel_conversation_append(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)'),'EXECUTE'),false)
      AS "verifiedChannelPublication"`)
  if (result.rows[0]?.reads && result.rows[0].anchorWriteExposed) throw new Error('conversation_anchor_write_contract_changed')
  if (result.rows[0]?.reads && result.rows[0].retainedOutputOwnerExposed) throw new Error('conversation_retained_output_contract_changed')
  if (result.rows[0]?.reads && (result.rows[0].publicHistoryOwnerExposed
    || result.rows[0].publicHistory !== result.rows[0].publicMemberPublication)) throw new Error('conversation_public_history_contract_changed')
  const capabilities = result.rows[0]
  let settingsReady = false
  if (capabilities?.settings) {
    const ready = await getAppPool().query<{ ready: boolean }>('SELECT public.conversation_visibility_settings_ready(1) AS ready')
    if (ready.rows[0]?.ready !== true || !capabilities.reads || !capabilities.pageVisitors || !capabilities.anchorWriteAdmission
      || !capabilities.retainedOutputs || !capabilities.publicHistory || !capabilities.verifiedChannelPublication)
      throw new Error('conversation_visibility_settings_contract_changed')
    settingsReady = true
  }
  nativeConversationReads = result.rows[0]?.reads === true
  nativeConversationSettings = settingsReady
  nativePageVisitorReads = nativeConversationReads && result.rows[0]?.pageVisitors === true
  nativePromptMemorySections = nativeConversationReads && result.rows[0]?.promptMemory === true
  nativeAnchorWriteAdmission = nativeConversationReads && result.rows[0]?.anchorWriteAdmission === true
  nativeRetainedConversationOutputs = nativeConversationReads && result.rows[0]?.retainedOutputs === true
  nativePublicConversationHistory = nativeConversationReads && result.rows[0]?.publicHistory === true
  nativeVerifiedChannelPublication = nativeConversationReads && result.rows[0]?.verifiedChannelPublication === true
}
export const conversationReadersActive = () => nativeConversationReads
export const conversationSettingsActive = () => nativeConversationSettings
export const pageVisitorConversationsActive = () => nativePageVisitorReads
export const promptMemorySectionsActive = () => nativePromptMemorySections
export const conversationAnchorWriteAdmissionActive = () => nativeAnchorWriteAdmission
export const conversationRetainedOutputActive = () => nativeRetainedConversationOutputs
export const publicConversationHistoryActive = () => nativePublicConversationHistory
export const verifiedChannelPublicationActive = () => nativeVerifiedChannelPublication

/** Trusted owner readers validate the retained copy for its recorded recipient. */
export function retainedConversationOutputFilter(kind:'memory'|'task'|'workspace_file'):string {
  return nativeRetainedConversationOutputs
    ? `AND public.conversation_record_derivation_current(workspace_id,'${kind}',id,scope_version::text,user_id)` : ''
}

export type PageConversationRow = {
  threadId: string
  sessionId: string
  anchorBlockId: string | null
  quote: string | null
  threadCreatedAt: Date
  guestName: string | null
  author: string | null
  avatar: string | null
  body: string | null
  messageCreatedAt: Date | null
}

/** The public route has resolved the exact live Page grant before the owner read. */
export async function readPageConversationRows(pageId: string, guestToken: string | null): Promise<PageConversationRow[]> {
  return (await query<PageConversationRow>('SELECT * FROM public.read_native_page_conversation_rows($1,$2)', [pageId, guestToken])).rows
}

const tierSchema = z.object({ session_id: uuid, tier: z.enum(['full', 'presence']) }).strict()
export async function readConversationMemberTiers(userId: string, sessionIds: readonly string[], includePresence = false) {
  if (!sessionIds.length) return new Map<string, 'full' | 'presence'>()
  const settings = rlsGucSettings(userId)
  const client = await getAppPool().connect()
  // The tier function depends on the completed setting result. Both the local
  // settings and canonical enrollment use this statement's transaction.
  try {
    const result = await client.query<{ session_id: string; tier: string }>(`
      WITH actor_context AS MATERIALIZED (
        SELECT count(set_config(setting.name,setting.value,true)) AS applied
        FROM unnest($1::text[],$2::text[]) AS setting(name,value)
      )
      SELECT admitted.session_id,admitted.tier FROM actor_context context
      CROSS JOIN LATERAL public.read_conversation_member_tiers(
        CASE WHEN context.applied=cardinality($1::text[]) THEN $3::uuid[] ELSE NULL END,$4::boolean
      ) admitted ORDER BY admitted.session_id`,
      [settings.map(([name])=>name),settings.map(([,value])=>value),sessionIds,includePresence])
    return new Map(result.rows.map(raw => {
      const row = tierSchema.parse(raw)
      return [row.session_id, row.tier] as const
    }))
  } finally { await rollbackAndRelease(client) }
}
const actorSchema = z.object({userId:uuid,authSessionId:uuid,authVersion:z.number().int().nonnegative()}).strict()
const committedUnreadable:z.ZodType<ConversationSettingsUnreadable>=z.object({
 committed:z.literal(true),readable:z.literal(false),sessionId:uuid,version:expectedVersion,code:z.literal('conversation_access_denied'),
}).strict()
const committedReadable=z.object({committed:z.literal(true),readable:z.literal(true),sessionId:uuid,
 version:expectedVersion,metadata:conversationVisibilityMetadataSchema}).strict()
const mutationResultSchema=z.union([committedReadable,committedUnreadable]).refine(result=>!result.readable
 ||result.version===result.metadata.conversationVisibilityVersion)
type MutationResult=z.infer<typeof mutationResultSchema>
function parseMutationResult(result:{rows:Array<{value:unknown}>},sessionId:string):MutationResult{
 if(result.rows.length!==1)throw new Error('conversation_visibility_unavailable')
 const received=mutationResultSchema.parse(result.rows[0].value)
 if(received.sessionId!==sessionId)throw new Error('conversation_visibility_unavailable')
 return received
}

function visibilityError(error: unknown): never {
  const database = error as {code?:string;message?:string}
  if (database.code === '42501' && database.message === 'conversation_access_denied')
    throw new ConversationVisibilityError('conversation_access_denied',403)
  if (database.message === 'conversation_visibility_conflict')
    throw new ConversationVisibilityError('conversation_visibility_conflict',409)
  if (database.message === 'conversation_cap_cannot_lower')
    throw new ConversationVisibilityError('conversation_cap_cannot_lower',409)
  throw error
}

export async function readConversationVisibility(actor:ConversationVisibilityActor,sessionId:string):Promise<ConversationVisibilityMetadata|null> {
  const claims = actorSchema.parse(actor); uuid.parse(sessionId)
  try {
    const result = await queryWithRLS<{value:unknown}>(claims.userId,
      'SELECT read_conversation_visibility($1,$2,$3) AS value',[sessionId,claims.authSessionId,claims.authVersion])
    if (result.rows.length !== 1 || result.rows[0].value === undefined) throw new Error('conversation_visibility_unavailable')
    return result.rows[0].value === null ? null : conversationVisibilityMetadataSchema.parse(result.rows[0].value)
  } catch (error) { return visibilityError(error) }
}

/** One canonical transaction owns current credential/member/envelope authority,
 * optimistic concurrency, participant admission, audit and durable notice.
 * A 409 requires revalidation; it is not evidence to evict retained history. */
export async function changeConversationVisibility(actor:ConversationVisibilityActor,sessionId:string,
  command:ConversationVisibilityMutation):Promise<MutationResult> {
  const claims=actorSchema.parse(actor),input=conversationVisibilityMutationSchema.parse(command);uuid.parse(sessionId)
  try {
    const result=await queryWithRLS<{value:unknown}>(claims.userId,
      'SELECT change_conversation_visibility($1,$2,$3,$4,$5,$6) AS value',
      [sessionId,claims.authSessionId,claims.authVersion,input.expectedVersion,input.visibility,
        input.participantUserIds === undefined ? null : JSON.stringify(input.participantUserIds)])
    return parseMutationResult(result,sessionId)
  } catch(error) { return visibilityError(error) }
}

export async function raiseConversationCap(actor:ConversationVisibilityActor,sessionId:string,
  command:ConversationCapMutation):Promise<MutationResult> {
  const claims=actorSchema.parse(actor),input=conversationCapMutationSchema.parse(command);uuid.parse(sessionId)
  try {
    const result=await queryWithRLS<{value:unknown}>(claims.userId,
      'SELECT raise_conversation_cap($1,$2,$3,$4,$5) AS value',
      [sessionId,claims.authSessionId,claims.authVersion,input.expectedVersion,input.cap])
    return parseMutationResult(result,sessionId)
  } catch(error) { return visibilityError(error) }
}

export async function moveConversationProject(actor:ConversationVisibilityActor,sessionId:string,
  command:ConversationProjectMutation):Promise<MutationResult> {
  const claims=actorSchema.parse(actor),input=conversationProjectMutationSchema.parse(command);uuid.parse(sessionId)
  try {
    const result=await queryWithRLS<{value:unknown}>(claims.userId,
      'SELECT move_conversation_project($1,$2,$3,$4,$5) AS value',
      [sessionId,claims.authSessionId,claims.authVersion,input.expectedVersion,input.projectId])
    return parseMutationResult(result,sessionId)
  } catch(error) { return visibilityError(error) }
}

export async function promoteNativeConversationLegacyHistory(actor:ConversationVisibilityActor,sessionId:string,
  version:number):Promise<MutationResult> {
  const claims=actorSchema.parse(actor);uuid.parse(sessionId);expectedVersion.parse(version)
  try {
    const result=await queryWithRLS<{value:unknown}>(claims.userId,
      'SELECT promote_native_conversation_legacy_history($1,$2,$3,$4) AS value',
      [sessionId,claims.authSessionId,claims.authVersion,version])
    return parseMutationResult(result,sessionId)
  } catch(error) { return visibilityError(error) }
}
