// [COMP:channels/media-receipt] Durable at-most-once upload + receipt effects.
import { query } from '../db/client.js'

export type ChannelMediaReceiptKey = {
  workspaceId: string
  channelType: string
  conversationId: string
  operationKey: string
}
export type ChannelMediaReceiptStore = {
  claim(key: ChannelMediaReceiptKey): Promise<boolean>
  finish(key: ChannelMediaReceiptKey, state: 'complete' | 'failed'): Promise<void>
}
const values = (key: ChannelMediaReceiptKey) => [key.workspaceId, key.channelType, key.conversationId, key.operationKey]
export const channelMediaReceiptStore: ChannelMediaReceiptStore = {
  async claim(key) {
    const result = await query(`INSERT INTO channel_media_receipts (workspace_id,channel_type,conversation_id,operation_key)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING operation_key`, values(key))
    return result.rows.length > 0
  },
  async finish(key, state) {
    await query(`UPDATE channel_media_receipts SET state=$5,updated_at=now()
      WHERE workspace_id=$1 AND channel_type=$2 AND conversation_id=$3 AND operation_key=$4`, [...values(key), state])
  },
}

/** Never replay a possibly completed write/send after a crash or ambiguous error.
 * A fresh user upload has a new provider message id and can recover the operation. */
export async function runChannelMediaReceipt(
  key: ChannelMediaReceiptKey,
  operation: () => Promise<void>,
  store: ChannelMediaReceiptStore = channelMediaReceiptStore,
): Promise<void> {
  if (!await store.claim(key)) return
  try {
    await operation()
    await store.finish(key, 'complete')
  } catch (error) {
    await store.finish(key, 'failed')
    throw error
  }
}
