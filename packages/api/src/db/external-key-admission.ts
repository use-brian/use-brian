import { AsyncLocalStorage } from 'node:async_hooks'
import type { QueryResultRow } from 'pg'
import { applyRLSGucs, getAppPool, rollbackAndRelease } from './client.js'

// Set only by authenticated transport; never deserialize this from key JSON.
const configurationActor = new AsyncLocalStorage<{ userId: string; sessionId?: string }>()
export function withExternalKeyActor<T>(userId: string, sessionId: string | undefined, work: () => T): T {
  return configurationActor.run({ userId, sessionId }, work)
}

/** Canonical key writes lock the workspace before touching the credential. */
export async function createExternalKey<T extends QueryResultRow>(
  actor: string, target: { workspaceId: string } | { assistantId: string },
  sql: string, values: unknown[], explicitBinding = false,
) {
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, actor)
    const workspace = 'workspaceId' in target ? target.workspaceId
      : (await client.query<{ workspace_id: string }>('SELECT workspace_id FROM assistants WHERE id=$1', [target.assistantId])).rows[0]?.workspace_id
    if (workspace) await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspace])
    const provenance = configurationActor.getStore()
    if (provenance?.userId === actor && provenance.sessionId) {
      await client.query("SELECT set_config('app.external_key_session',$1,true)", [provenance.sessionId])
    }
    await client.query("SELECT set_config('app.external_key_explicit',$1,true)", [String(explicitBinding)])
    const result = await client.query<T>(sql, values)
    await client.query('COMMIT')
    return result
  } finally {
    await rollbackAndRelease(client)
  }
}
