/** Text-only M7 history for an authenticated public route.
 * [COMP:api/conversation-visibility] */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ClientBase } from 'pg'
import type { ResourceScope } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ApiKeyAudience, ApiKeyAnonymousContext, ApiKeyScope, ApiKeyToolPolicy } from './api-key-store.js'
import { query } from './client.js'
import { ConversationVisibilityError } from './conversation-visibility.js'

type PublicKeyConfiguration = {
  audience: ApiKeyAudience
  anonymousContext: ApiKeyAnonymousContext
  scope: ApiKeyScope
  toolPolicy: ApiKeyToolPolicy
  createdBy: string | null
}

export type PublicConversationCredential = { kind: 'chat_link'; id: string; fingerprint: string }
  | { kind: 'api_key'; id: string; fingerprint: string; configuration: PublicKeyConfiguration }

export function publicChatLinkCredential(id: string, token: string): PublicConversationCredential {
  return { kind: 'chat_link', id, fingerprint: createHash('sha256').update(token).digest('hex') }
}

export function publicApiKeyCredential(key: PublicKeyConfiguration & { id: string; keyHash: string }): PublicConversationCredential {
  const { id, keyHash, scope, audience, anonymousContext, toolPolicy, createdBy } = key
  return { kind: 'api_key', id, fingerprint: createHash('sha256').update(keyHash).digest('hex'),
    configuration: { scope, audience, anonymousContext, toolPolicy, createdBy } }
}

const historySchema = z.array(z.object({
  id: z.string().uuid(), role: z.enum(['user', 'assistant']), content: z.string().min(1),
  sequenceNum: z.number().int().positive(), createdAt: z.string().datetime({ offset: true }),
}).strict()).max(500)

function reportPublicConversationError(error: unknown): never {
  const database = error as { code?: string; message?: string }
  if (database.code === '42501' && database.message === 'conversation_access_denied')
    throw new ConversationVisibilityError('conversation_access_denied', 403)
  throw error
}

export async function readPublicConversationHistory(input: {
  assistantId: string
  credential: PublicConversationCredential
  resolvedUserId?: string
  externalUserId: string
  channelId: string
  limit: number
}) {
  try {
    const result = await query<{ value: unknown }>(
      'SELECT public.read_public_conversation_history($1,$2,$3,$4,$5,$6) AS value',
      [input.assistantId, JSON.stringify(input.credential), input.resolvedUserId ?? null,
        input.externalUserId, input.channelId, input.limit],
    )
    return historySchema.parse(result.rows[0]?.value)
  } catch (error) {
    return reportPublicConversationError(error)
  }
}

export type PublicTurnConversationAddress = {
  assistantId: string
  credential: PublicConversationCredential
  memberUserId?: string
  externalUserId: string
  channelId: string
  sessionId: string
  userId: string
  claimedEmail?: string
}
export type PublicTurnConversationBinding = PublicTurnConversationAddress & { version: string }
const uuid = z.string().uuid()
const floorSchema = z.object({
  sessionId: uuid, workspaceId: uuid.nullable(), starterUserId: uuid,
  version: z.string().regex(/^[1-9][0-9]*$/),
  visibility: z.enum(['workspace', 'configured_private', 'private_by_kind']),
  cap: z.enum(['public', 'internal', 'confidential']),
  compartments: z.array(z.string()), projectIds: z.array(uuid),
}).strict()
export type PublicConversationFloor = z.infer<typeof floorSchema>

export function publicConversationBindingValues(input: PublicTurnConversationAddress, version: string | null) {
  return [input.assistantId, JSON.stringify(input.credential), input.memberUserId ?? null, input.externalUserId,
    input.channelId, input.sessionId, input.userId, input.claimedEmail ?? null, version]
}

export async function readPublicConversationFloor(address: PublicTurnConversationAddress,
  options?: { version: string; probe?: boolean; write?: { client: Pick<ClientBase, 'query'>; token: string } }): Promise<PublicConversationFloor> {
  const sql = `SELECT e.session_id AS "sessionId",e.workspace_id AS "workspaceId",e.starter_user_id AS "starterUserId",
    e.version::text AS version,e.visibility,e.cap,e.compartments,e.project_ids AS "projectIds"
    FROM public.public_conversation_session_current($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) e`
  const values = [...publicConversationBindingValues(address, options?.version ?? null), !!options?.write,
    options?.write?.token ?? null, !options?.probe]
  try {
    const result = options?.write ? await options.write.client.query(sql, values) : await query(sql, values)
    return floorSchema.parse(result.rows[0])
  } catch (error) { return reportPublicConversationError(error) }
}

export async function pinPublicMemberConversationPublication(
  client: Pick<ClientBase, 'query'>, binding: PublicTurnConversationBinding, token: string,
): Promise<PublicConversationFloor> {
  try {
    const result = await client.query<{ value: unknown }>(
      'SELECT public.pin_public_member_conversation_publication($1,$2,$3,$4,$5,$6,$7,$8) AS value',
      [binding.assistantId, JSON.stringify(binding.credential), binding.userId, binding.externalUserId, binding.channelId,
        binding.sessionId, binding.version, token],
    )
    const floor = floorSchema.parse(result.rows[0]?.value)
    if (floor.sessionId !== binding.sessionId || floor.starterUserId !== binding.userId || floor.version !== binding.version)
      throw new ConversationVisibilityError('conversation_access_denied', 403)
    return floor
  } catch (error) { return reportPublicConversationError(error) }
}

export function publicConversationScope(floor: PublicConversationFloor): ResourceScope | undefined {
  if (!floor.workspaceId) return undefined
  return { workspaceId: floor.workspaceId, userId: floor.visibility === 'workspace' ? null : floor.starterUserId,
    assistantId: null, sensitivity: floor.cap, compartments: floor.compartments, projectIds: floor.projectIds }
}

