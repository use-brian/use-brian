/**
 * Durable inbound channel-event idempotency.
 *
 * [COMP:api/channel-event-dedup]
 */

import { query } from './client.js'

/**
 * Atomically claim one provider event. Returns false when it was already seen.
 * The same statement prunes expired claims, keeping the table bounded without
 * a connector-specific worker.
 */
export async function claimChannelEvent(channelId: string, eventId: string): Promise<boolean> {
  const result = await query<{ event_id: string }>(
    `WITH pruned AS (
       DELETE FROM channel_event_dedup
        WHERE received_at < now() - interval '14 days'
     )
     INSERT INTO channel_event_dedup (channel_id, event_id)
     VALUES ($1, $2)
     ON CONFLICT (channel_id, event_id) DO NOTHING
     RETURNING event_id`,
    [channelId, eventId],
  )
  return result.rowCount === 1
}
