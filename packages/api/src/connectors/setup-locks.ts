import type { PoolClient } from 'pg'

/** Internal restart signal. Never retry provider exchanges or external effects. */
export class ConnectorSetupLockRetry extends Error {}

/** Discover before locking any resource; acquire the entire workspace set in
 * UUID order, then the connector, then rediscover under that connector lock.
 * A concurrent new grant/transfer requires a fresh transaction, not acquiring
 * an additional workspace out of order. Grant publication also locks its
 * workspace, so grants in this set cannot expand while these locks are held. */
export async function lockConnectorSetupWorkspaces(c: PoolClient, workspaceId: string | null, instanceId?: string) {
  const discover = async () => (await c.query<{ id: string }>(`SELECT DISTINCT id FROM (
    SELECT $1::uuid AS id
    UNION ALL SELECT workspace_id FROM connector_instance WHERE id=$2::uuid
    UNION ALL SELECT target_id FROM connector_grant WHERE connector_instance_id=$2::uuid
  ) affected WHERE id IS NOT NULL ORDER BY id`, [workspaceId, instanceId ?? null])).rows.map(r => r.id)
  const before = await discover()
  await c.query('SELECT id FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [before])
  if (instanceId) await c.query('SELECT id FROM connector_instance WHERE id=$1 FOR UPDATE', [instanceId])
  const after = await discover()
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new ConnectorSetupLockRetry()
}
