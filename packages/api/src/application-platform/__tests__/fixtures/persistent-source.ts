import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { createConnectorActorVerifier } from '@use-brian/brian-app/connector'
import { ContextScopeAccumulator, boundScopeSources, type ScopeSource } from '@use-brian/core'
import { applyRLSGucs, getAppPool, runWithAgentAccess } from '../../../db/client.js'
import { createMemory } from '../../../db/memories.js'
import { addSessionMessage, getSessionMessages, type SessionMessage } from '../../../db/sessions.js'
import { createConnectorInstanceStore } from '../../../db/connector-instance-store.js'
import { createConnectorActorKeyStore } from '../../connector-actor-keys.js'
import { createConnectorSourceRuntimeFactory } from '../../source-runtime.js'
import { createRetainedSourceAuthorityCoordinator, pinPreparedExternalSourceAuthority } from '../../retained-source-authority.js'
import { independentSourceSchema, independentSourceReplayConsumer, startIndependentSource } from './independent-source.js'
import type { persistentContextFixture } from './persistent-context.js'

/** A distinct persisted source installation; SQL and ACL boundaries are real. */
export async function persistentSourceFixture(f: Awaited<ReturnType<typeof persistentContextFixture>>) {
  const role = `persistence_${randomBytes(8).toString('hex')}`, password = randomBytes(32).toString('hex')
  await f.pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`)
  await f.pool.query(`CREATE SCHEMA ${role} AUTHORIZATION ${role}`)
  const sourceUrl = new URL(process.env.DATABASE_URL!)
  sourceUrl.username = role; sourceUrl.password = password
  const pool = new pg.Pool({ connectionString: sourceUrl.href, options: `-c search_path=${role},pg_catalog`, max: 3 })
  let source: Awaited<ReturnType<typeof startIndependentSource>> | undefined
  async function cleanup() {
    await source?.close(); await pool.end()
    await f.pool.query(`DROP SCHEMA ${role} CASCADE`); await f.pool.query(`DROP ROLE ${role}`)
  }
  try {
    await pool.query(independentSourceSchema)
    await pool.query('INSERT INTO assistants(id) VALUES($1)', [f.assistantId])
    for (const user of [f.ownerId, f.secondId]) await pool.query("INSERT INTO accounts(kind,id) VALUES('human',$1)", [user])
    await pool.query("INSERT INTO records(id,kind,data,compartments) VALUES('fixture-record','purchase',$1,'{}')", [{ description: 'Fictional independent obligation' }])
    for (const user of [f.ownerId, f.secondId]) await pool.query(`INSERT INTO grants(kind,account_id,record_id,fields,actions)
      VALUES('human',$1,'fixture-record',ARRAY['description'],ARRAY['read','context','derive','retain','deliver','export'])`, [user])
    const key = randomBytes(32), keys = createConnectorActorKeyStore(key), instances = createConnectorInstanceStore(key)
    const issuer = `https://${randomUUID()}.installation.example`, audience = 'https://persistent-source.example', token = randomBytes(32).toString('base64url')
    await keys.rotateSystem(issuer)
    const instance = await instances.createWorkspaceInstance({ workspaceId: f.workspaceId, createdBy: f.ownerId,
      provider: randomUUID(), label: 'Persistent source fixture', custom: true, connected: true, compartments: [], projectIds: [],
      credentials: { type: 'bearer', token } })
    const verify = createConnectorActorVerifier({ issuer, audience, workspaceId: f.workspaceId, connectorInstanceId: instance.id,
      consumeReplay: independentSourceReplayConsumer(pool), trustedKey: async kid => {
        const jwk = (await keys.publicJwks(issuer)).keys.find(value => value.kid === kid)
        return jwk ? { key: createPublicKey({ key: jwk, format: 'jwk' }) } : null
      } })
    source = await startIndependentSource({ pool, tenant: 'persistent-fixture', transportToken: token,
      verifyActor: verify, uiSessions: new Map() })
    await instances.update(f.ownerId, instance.id, { url: `${source.url}/mcp` })
    await f.pool.query(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id)
      VALUES($1,$2,'persistent-fixture',$3,$4,$5,$6,'/http/read','qualified',$7)`,
    [f.workspaceId, instance.id, issuer, audience, source.url, `${source.url}/mcp`, f.ownerId])
    const factory = createConnectorSourceRuntimeFactory({ issuer, keys, instances })
    const coordinator = createRetainedSourceAuthorityCoordinator({ factory, instances })
    const execution = await f.execution(), accumulator = new ContextScopeAccumulator()
    const runtime = await factory({ workspaceId: f.workspaceId, instanceId: instance.id, execution, accumulator,
      headers: { Authorization: `Bearer ${token}` } })
    if (!runtime) throw new Error('Persistent fixture source runtime missing')
    await runtime.call('readRecord', { id: 'fixture-record', fields: ['description'] })
    const observations = accumulator.evidence.sources!
    const prepared = await coordinator.prepare(execution, observations, 'retain')
    const tx = await f.pool.connect()
    let derivative
    try {
      await tx.query('BEGIN'); await applyRLSGucs(tx, f.ownerId)
      await pinPreparedExternalSourceAuthority(tx, execution, prepared)
      derivative = await createMemory({ workspaceId: f.workspaceId, assistantId: f.assistantId, userId: null,
        createdByUserId: f.ownerId, summary: 'Fictional retained independent content', sensitivity: 'internal',
        derivation: { producer: 'fixture:persistent-independent', sources: observations } }, undefined, tx)
      await tx.query('COMMIT')
    } catch (error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
    const root = (await f.pool.query<{ source: ScopeSource }>("SELECT read_scope_source($1,'memory',$2) AS source",
      [f.workspaceId, derivative.id])).rows[0].source
    if (!root) throw new Error('Persistent fixture derivative evidence missing')
    async function independentlyAuthorized() {
      const other = await f.execution(f.secondId), proof = await coordinator.prepare(other, observations, 'context')
      const tx = await getAppPool().connect()
      try {
        await tx.query('BEGIN'); await applyRLSGucs(tx, f.secondId)
        await pinPreparedExternalSourceAuthority(tx, other, proof)
        const current = await tx.query<{ source: { held: boolean } }>('SELECT external_source_snapshot($1,$2) AS source',
          [f.workspaceId, observations[0].resourceId])
        await tx.query('COMMIT')
        return current.rows[0].source.held === false
      } catch (error) { await tx.query('ROLLBACK'); throw error }
      finally { tx.release() }
    }
    async function writeTranscript() {
      const proof = await coordinator.prepare(execution, [root], 'retain'), tx = await f.pool.connect()
      try {
        await tx.query('BEGIN'); await applyRLSGucs(tx, f.ownerId)
        await pinPreparedExternalSourceAuthority(tx, execution, proof)
        const row = await addSessionMessage({ sessionId: f.session.id, role: 'assistant',
          content: 'Fictional independently sourced reply', derivation: { producer: 'fixture:retained-transcript', sources: [root] } }, tx)
        await tx.query('COMMIT')
        return row
      } catch (error) { await tx.query('ROLLBACK'); throw error }
      finally { tx.release() }
    }
    async function readTranscript(row: SessionMessage) {
      const current = await f.execution(), proof = await coordinator.prepare(current, boundScopeSources(row), 'context')
      const tx = await getAppPool().connect()
      try {
        return await runWithAgentAccess(current.security.access, async () => {
          await tx.query('BEGIN'); await applyRLSGucs(tx, f.ownerId)
          await pinPreparedExternalSourceAuthority(tx, current, proof)
          const rows = await getSessionMessages(f.session.id, { excludeHeld: true }, tx)
          await current.security.authority.assertCurrent(); await tx.query('COMMIT')
          return rows
        })
      } catch (error) { await tx.query('ROLLBACK'); throw error }
      finally { tx.release() }
    }
    return { root, observations, pool, coordinator, independentlyAuthorized, writeTranscript, readTranscript, cleanup }
  } catch (error) { await cleanup(); throw error }
}
