// [COMP:api/channel-room] Provider identity is shared by passive and active
// intake. See adapter-pattern.md -> "Ordinary message identity".
import type { PoolClient } from 'pg'
import { getPool } from '../db/client.js'
import { sessionKindSql } from '../session-kind.js'
import { addSessionMessage, type Session, type SessionMessage } from '../db/sessions.js'

export type ProviderConversationExpectation = { identity: NonNullable<Session['providerContextIdentity']>; generation: number }
type RoomMessageInput = Omit<Parameters<typeof addSessionMessage>[0], 'role' | 'derivation'> & { role: 'user' | 'assistant'; providerContext?: ProviderConversationExpectation }
type Client = Pick<PoolClient, 'query'>

/** The same canonical DB gate used before reads and inside append transactions.
 * Expected provenance is checked while the session row is locked, so renewal
 * cannot turn a stale sender/receipt into current-authority content. */
export async function assertChannelConversationCurrent(db: Client, sessionId: string, expected: ProviderConversationExpectation): Promise<void> {
  const previous=(await db.query<{value:string|null}>("SELECT current_setting('app.provider_conversation_context_check',true) AS value")).rows[0]?.value
  await db.query("SELECT set_config('app.provider_conversation_context_check',$1,true)",[sessionId])
  const result=await db.query(`UPDATE sessions s SET last_active_at=last_active_at WHERE s.id=$1
    AND s.provider_context_identity=$2::jsonb AND s.provider_context_generation=$3
    AND ${sessionKindSql.providerConversationContext('s')} AND ${sessionKindSql.activeChannelRoom('s')} RETURNING id`,
  [sessionId,expected.identity,expected.generation])
  if(!result.rows.length)throw new Error('provider_context_unavailable')
  await db.query("SELECT set_config('app.provider_conversation_context_check',$1,true)",[previous??''])
}

/** Reuse a provider input atomically, including rows already saved passively.
 * A caller's archive transaction owns commit/rollback when supplied. */
export async function appendChannelRoomMessage(
  input: RoomMessageInput,
  client?: Client,
): Promise<{ message: SessionMessage; created: boolean }> {
  const write = async (db: Client) => {
    if (input.channelMessageId != null || input.providerContext) {
      // Recording admission and destination changes lock workspace before
      // session. Keep the same order for later addressed-turn appends.
      await db.query(`SELECT w.id FROM workspaces w JOIN sessions s ON s.workspace_id=w.id
        WHERE s.id=$1 AND (s.recording_revision IS NOT NULL OR ${sessionKindSql.providerConversationContext('s')}) FOR UPDATE OF w`, [input.sessionId])
      // Lock the parent, not the nonexistent message: this also serializes
      // sequence allocation across concurrent installations and processes.
      const room = await db.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [input.sessionId])
      if (!room.rows.length) throw new Error('channel_room_not_found')
      if(input.providerContext)await assertChannelConversationCurrent(db,input.sessionId,input.providerContext)
      const existing = await db.query<SessionMessage>(
        `SELECT id,session_id AS "sessionId",role,content,sequence_num AS "sequenceNum",created_at AS "createdAt",
                reply_to_text AS "replyToText",topic_label AS "topicLabel",topic_confidence AS "topicConfidence",
                channel_message_id AS "channelMessageId",sender_user_id AS "senderUserId",
                sender_assistant_id AS "senderAssistantId",published_sender_name AS "publishedSenderName",attachments
           FROM session_messages WHERE session_id=$1 AND role=$3 AND channel_message_id=$2
          ORDER BY sequence_num,id LIMIT 1`,
        [input.sessionId, input.channelMessageId, input.role],
      )
      if (existing.rows[0]) return { message: existing.rows[0], created: false }
    }
    const previous=input.providerContext ? (await db.query<{value:string|null}>("SELECT current_setting('app.provider_conversation_expected',true) AS value")).rows[0]?.value : null
    if(input.providerContext)await db.query("SELECT set_config('app.provider_conversation_expected',$1,true)",[JSON.stringify(input.providerContext)])
    const message=await addSessionMessage(input,db)
    if(input.providerContext)await db.query("SELECT set_config('app.provider_conversation_expected',$1,true)",[previous??''])
    return {message,created:true}
  }
  if (client) return write(client)
  const db = await getPool().connect()
  try {
    await db.query('BEGIN')
    const result = await write(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  } finally { db.release() }
}

/** One attempt per assistant/input. Never replay uncertain tool/send effects. */
export async function claimChannelRoomTurn(input: {
  sessionId: string
  assistantId: string
  channelMessageId: string
}): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO channel_message_turn_claims(session_id,assistant_id,channel_message_id)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING session_id`,
    [input.sessionId, input.assistantId, input.channelMessageId],
  )
  return result.rows.length === 1
}
