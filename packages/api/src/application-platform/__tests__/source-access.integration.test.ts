import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createBoundedConnectorReplayConsumer, createConnectorActorVerifier, SOURCE_PROTOCOL_VERSION,
  type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
import { ContextScopeAccumulator, scopeEvidenceFromRows } from '@use-brian/core'
import { getAppPool, getPool, applyRLSGucs, queryWithRLS } from '../../db/client.js'
import { readCurrentScopeSources, validateDerivedWriteInputs } from '../../db/derived-scope-store.js'
import { bindTrustedSourceRead, pinExternalSourceOperation } from '../source-store.js'
import { createConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { createConnectorRuntimeAuthority } from '../connector-runtime-authority.js'
import { createConnectorActorKeyStore } from '../connector-actor-keys.js'
import { createConnectorActorFetch } from '../connector-actor-transport.js'
import { createSourceAccessClient, trustedSourceEnvelope } from '../source-access.js'
import { callRemoteMcpTool } from '../../mcp/client.js'
import { independentSourceSchema, startIndependentSource } from './fixtures/independent-source.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/external-source-access] independent persisted source ACL', () => {
  const pool = getPool()
  afterAll(async () => { await getAppPool().end(); await pool.end() })
  it('uses source canonical rights across UI/HTTP/MCP, same-department field differences, revocation, withdrawal and effect reconciliation', async () => {
    const workspace = randomUUID(), owner = randomUUID(), first = randomUUID(), second = randomUUID(), foreign = randomUUID(), unmapped = randomUUID(), assistant = randomUUID(), department = randomUUID()
    const sourceRole = `reference_${randomBytes(8).toString('hex')}`, sourceSchema = sourceRole, sourcePassword = randomBytes(32).toString('hex')
    // Only after the disposable marker assertion: source has its own non-bypass login and schema.
    await pool.query(`CREATE ROLE ${sourceRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${sourcePassword}'`)
    await pool.query(`CREATE SCHEMA ${sourceSchema} AUTHORIZATION ${sourceRole}`)
    const sourceUrl = new URL(process.env.DATABASE_URL!); sourceUrl.username = sourceRole; sourceUrl.password = sourcePassword
    const sourcePool = new pg.Pool({ connectionString: sourceUrl.href, options: `-c search_path=${sourceSchema},pg_catalog`, max: 3 })
    let source: Awaited<ReturnType<typeof startIndependentSource>> | undefined
    try {
      await sourcePool.query(independentSourceSchema)
      await expect(sourcePool.query('SELECT id FROM public.users')).rejects.toMatchObject({ code: '42501' })
      for (const id of [owner,first,second,foreign,unmapped]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)", [id])
      await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Source boundary fixture',$2,true)", [workspace,owner])
      await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspace,owner])
      for (const id of [first,second,foreign,unmapped]) await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspace,id])
      await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Independent source assistant',$2,$3,'standard','confidential',NULL)", [assistant,workspace,owner])
      await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fixture Department',$3,'team',$1::text,$4)", [department,workspace,owner,`team:${department}`])
      await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fixture Department',$3,'team',$4)", [workspace,`team:${department}`,owner,department])
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store')", [workspace,department,assistant])
      for (const id of [first,second,unmapped]) await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace,department,id])
      for (const id of [first,second,foreign]) await sourcePool.query("INSERT INTO accounts(kind,id) VALUES('human',$1)", [id])
      await sourcePool.query('INSERT INTO assistants(id) VALUES($1)', [assistant])
      await sourcePool.query("INSERT INTO records(id,kind,data,compartments) VALUES('order-1','purchase',$1,$2)", [{ description: 'Fictional parts', cost: '37.25' },[`team:${department}`]])
      const actions = ['read','context','derive','retain','deliver','export','mutate']
      for (const [id,fields] of [[first,['description','cost']],[second,['description']],[foreign,['description','cost']]] as const) await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [id,fields,actions])
      const issuer = `https://${randomUUID()}.installation.example`, audience = 'https://independent-source.example', transportToken = randomBytes(32).toString('base64url')
      const encryptionKey = randomBytes(32), keys = createConnectorActorKeyStore(encryptionKey), instances = createConnectorInstanceStore(encryptionKey)
      await keys.rotateSystem(issuer)
      // Source independently pins deployment keys/instance before starting; no token-selected discovery URL.
      const instance = await instances.createWorkspaceInstance({ workspaceId: workspace, createdBy: owner, provider: randomUUID(), label: 'Independent source fixture', custom: true,
        connected: true, compartments: [`team:${department}`], projectIds: [], credentials: { type: 'bearer', token: transportToken } })
      const verify = createConnectorActorVerifier({ issuer, audience, workspaceId: workspace, connectorInstanceId: instance.id,
        consumeReplay: createBoundedConnectorReplayConsumer(), trustedKey: async kid => { const jwk = (await keys.publicJwks(issuer)).keys.find(key => key.kid === kid)
          return jwk ? { key: createPublicKey({ key: jwk, format: 'jwk' }) } : null } })
      source = await startIndependentSource({ pool: sourcePool, tenant: 'fixture-tenant', transportToken, verifyActor: verify,
        uiSessions: new Map([['first-ui-session',{ kind: 'human', id: first, executingAssistantId: assistant }],['second-ui-session',{ kind: 'human', id: second, executingAssistantId: assistant }]]) })
      await instances.update(owner, instance.id, { url: `${source.url}/mcp` })
      const sourceProfile = (await pool.query<{ id: string }>(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id)
        VALUES($1,$2,'fixture-tenant',$3,$4,$5,$6,'/http/read','qualified',$7) RETURNING id`, [workspace,instance.id,issuer,audience,source.url,`${source.url}/mcp`,owner])).rows[0].id
      await expect(queryWithRLS(owner, "UPDATE connector_source_profiles SET status='qualified' WHERE id=$1", [sourceProfile])).rejects.toMatchObject({ code: '42501' })
      expect((await queryWithRLS(owner, "SELECT application_runtime_qualified($1,'connector_source') AS ready", [workspace])).rows[0].ready).toBe(false)
      expect((await queryWithRLS(first, 'SELECT id FROM connector_source_profiles WHERE workspace_id=$1', [workspace])).rows).toEqual([])
      async function client(userId: string) {
        const execution = (await resolveExecutionContextSystem({ userId, workspaceId: workspace, assistant: (await findAssistantById(assistant))!, memberMode: 'member',
          identity: { kind: 'attended', principal: { kind: 'workspace_member', userId } }, ownership: { kind: 'workspace', workspaceId: workspace },
          lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelId: 'fixture', channelType: 'test', abortSignal: new AbortController().signal } })).executionContext
        const native = await createConnectorRuntimeAuthority({ workspaceId: workspace, assistantId: assistant, initiatingUserId: userId })
        const ports = { ...keys, admit: async () => { await native.assertCurrent(); const current = await instances.getSystem(instance.id)
          return current?.connected && native.allows(current) ? { bindingRevision: '1', actor: { kind: 'human' as const, userId, authenticationKind: 'native_session' as const } } : null } }
        const profile = { issuer, audience, workspaceId: workspace, connectorInstanceId: instance.id, sourceBaseUrl: source!.url, mcpUrl: `${source!.url}/mcp`,
          httpReadPath: '/http/read', tenant: 'fixture-tenant', bindingRevision: '1', subject: { kind: 'human' as const, id: userId, executingAssistantId: assistant } }
        return { execution, profile, ports, access: createSourceAccessClient(execution, profile, ports, { headers: { Authorization: `Bearer ${transportToken}` } }) }
      }
      const one = await client(first), two = await client(second), unknown = await client(unmapped), outsider = await client(foreign)
      const ui = async (session: string, fields: string) => fetch(`${source!.url}/ui/records/order-1?fields=${fields}`, { headers: { Authorization: `Bearer ${session}` } })
      expect(await (await ui('first-ui-session','cost')).json()).toEqual({ cost: '37.25' }); expect((await ui('second-ui-session','cost')).status).toBe(403)
      const read = await one.access.readMcp('readRecord', { id: 'order-1', fields: ['description','cost'] })
      expect(JSON.stringify(read.result)).toContain('37.25'); expect(read.result).not.toHaveProperty('_meta')
      const evidence = trustedSourceEnvelope(read)!
      expect(evidence.resources[0].fields).toEqual(['description','cost']); expect(trustedSourceEnvelope(structuredClone(read))).toBeUndefined()
      const app = await getAppPool().connect(), accumulator = new ContextScopeAccumulator()
      let retainedSources: Awaited<ReturnType<typeof bindTrustedSourceRead>>['sources']
      try {
        await app.query('BEGIN'); await applyRLSGucs(app, first)
        await expect(bindTrustedSourceRead(app, one.execution, structuredClone(read), accumulator)).rejects.toMatchObject({ code: 'source_access_denied' })
        const bound = await bindTrustedSourceRead(app, one.execution, read, accumulator)
        retainedSources = bound.sources
        expect(scopeEvidenceFromRows(bound.sourceRows).sources).toEqual(bound.sources)
        expect(accumulator.evidence.sources).toEqual(bound.sources)
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['current'])
        await validateDerivedWriteInputs(app, { producer: 'independent-source-fixture', sources: bound.sources })
        const costRead = await one.access.readHttp({ id: 'order-1', fields: ['cost'] })
        const costBound = await bindTrustedSourceRead(app, one.execution, costRead, accumulator)
        expect(costBound.sources[0].resourceId).not.toBe(bound.sources[0].resourceId)
        expect(accumulator.evidence.sources).toHaveLength(2)
        const combined = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'context', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await pinExternalSourceOperation(app, one.execution, combined, accumulator.evidence.sources!, 'context')
        await validateDerivedWriteInputs(app, { producer: 'independent-field-observations', sources: accumulator.evidence.sources! })
        expect((await readCurrentScopeSources(app, workspace, [{ ...bound.sources[0], version: '0'.repeat(64) }])).map(row => row.state)).toEqual(['unverifiable'])
        const oldOperationId = combined.request.operationId
        await app.query('COMMIT')
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await app.query('BEGIN'); await applyRLSGucs(app, first)
        await app.query(`SELECT set_config('app.external_source_operation_id',$1,true),set_config('app.external_source_actor_id',$2,true),
          set_config('app.external_source_assistant_id',$3,true),set_config('app.external_source_action','context',true),set_config('app.v2_assistant_id',$3,true)`, [oldOperationId,first,assistant])
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        const partial = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description'], action: 'context', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await expect(pinExternalSourceOperation(app, one.execution, partial, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
        const foreignRecipient = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'context', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: { ...one.profile.subject, id: foreign } }] })
        await expect(pinExternalSourceOperation(app, one.execution, foreignRecipient, bound.sources, 'context')).rejects.toMatchObject({ reason: 'caller_evidence_unavailable' })
        const retainedProof = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'context', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await expect(pinExternalSourceOperation(app, one.execution, structuredClone(retainedProof), bound.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
        await pinExternalSourceOperation(app, one.execution, retainedProof, bound.sources, 'context')
        await app.query("SELECT set_config('app.current_user_id',$1,true)", [second])
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await app.query("SELECT set_config('app.current_user_id',$1,true)", [first])
        await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3', [workspace,first,department])
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace,department,first])
        // Observed local contraction cannot be revived by restoring the old row.
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await app.query('ROLLBACK')
        await app.query('BEGIN'); await applyRLSGucs(app, first)
        const expiring = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'context', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await pinExternalSourceOperation(app, one.execution, expiring, bound.sources, 'context')
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['current'])
        await new Promise(resolve => setTimeout(resolve, 5_100))
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await expect(pinExternalSourceOperation(app, one.execution, expiring, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_protocol_invalid' })
        await app.query('ROLLBACK')
      } finally { await app.query('ROLLBACK'); app.release() }
      for (const table of ['external_source_resources','external_source_observations','external_source_authorizations']) {
        expect((await queryWithRLS(first, `SELECT * FROM ${table} WHERE workspace_id=$1`, [workspace])).rows).toEqual([])
      }
      const missing = { ...retainedSources![0], resourceId: randomUUID() }
      expect((await readCurrentScopeSources(pool, workspace, [missing])).map(row => row.state)).toEqual(['unverifiable'])
      await expect(pool.query('UPDATE external_source_observations SET fields=$2 WHERE id=$1', [retainedSources![0].resourceId,['description']])).rejects.toMatchObject({ code: '22023' })
      expect((await pool.query('SELECT count(*)::int AS count FROM external_source_resources WHERE profile_id=$1', [sourceProfile])).rows[0].count).toBe(1)
      expect((await pool.query('SELECT count(*)::int AS count FROM external_source_observations WHERE workspace_id=$1', [workspace])).rows[0].count).toBe(2)
      expect(JSON.stringify(await two.access.readMcp('readRecord', { id: 'order-1', fields: ['description'] }))).not.toContain('37.25')
      await expect(two.access.readMcp('readRecord', { id: 'order-1', fields: ['cost'] })).rejects.toMatchObject({ code: 'source_unavailable' })
      await expect(unknown.access.capabilities()).rejects.toMatchObject({ code: 'source_access_denied' })
      const beforeForeign = source.counters.reads
      await expect(outsider.access.readMcp('readRecord', { id: 'order-1', fields: ['description'] })).rejects.toMatchObject({ code: 'source_unavailable' })
      expect(source.counters.reads).toBe(beforeForeign)
      // Non-MCP HTTP uses the same source function and a separately bound authenticated result envelope.
      const http = createConnectorActorFetch(one.execution, `${source.url}/http/read`, one.profile, one.ports)
      const response = await http(`${source.url}/http/read`, { method: 'POST', headers: { Authorization: `Bearer ${transportToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'order-1', fields: ['cost'] }) })
      expect(await response.json()).toMatchObject({ data: { cost: '37.25' } })
      const httpRead = await one.access.readHttp({ id: 'order-1', fields: ['cost'] })
      expect(httpRead.result.structuredContent).toEqual({ cost: '37.25' })
      expect(trustedSourceEnvelope(httpRead)?.resources[0].fields).toEqual(['cost'])
      await expect(two.access.readHttp({ id: 'order-1', fields: ['cost'] })).rejects.toMatchObject({ code: 'source_access_denied' })
      const retained = (userId: string): SourceAuthorizationRequest => ({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(),
        items: [{ itemId: randomUUID(), resource: evidence.resources[0].resource, fields: ['description'], action: 'context', retentionMode: 'governed' }],
        recipients: [{ recipientId: randomUUID(), subject: { kind: 'human', id: userId, executingAssistantId: assistant } }] })
      await one.access.authorize(retained(first)); await two.access.authorize(retained(second))
      await sourcePool.query("DELETE FROM grants WHERE account_id=$1 AND record_id='order-1'", [first])
      await expect(one.access.authorize(retained(first))).rejects.toMatchObject({ code: 'source_access_denied' })
      await two.access.authorize(retained(second))
      await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [first,['description','cost'],actions])
      source.setAfterRead(async () => { await sourcePool.query("DELETE FROM grants WHERE account_id=$1 AND record_id='order-1'", [first]) })
      await expect(one.access.readMcp('readRecord', { id: 'order-1', fields: ['cost'] })).rejects.toMatchObject({ code: 'source_access_denied' })
      source.setAfterRead()
      await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [first,['description','cost'],actions])
      const dispatch = createConnectorActorFetch(one.execution, one.profile.mcpUrl, one.profile, one.ports), args = { id: 'order-1', expectedVersion: '1', values: { cost: '38.00' }, idempotencyKey: 'fictional-effect-1' }
      const effect = await callRemoteMcpTool(one.profile.mcpUrl, 'updateRecord', args, { Authorization: `Bearer ${transportToken}` }, dispatch)
      expect(await callRemoteMcpTool(one.profile.mcpUrl, 'updateRecord', args, { Authorization: `Bearer ${transportToken}` }, dispatch)).toEqual(effect)
      expect(source.counters.effects).toBe(1)
      expect(await one.access.reconcile({ version: SOURCE_PROTOCOL_VERSION, idempotencyKey: args.idempotencyKey })).toMatchObject({ state: 'applied' })
      expect(await one.access.reconcile({ version: SOURCE_PROTOCOL_VERSION, idempotencyKey: 'unknown-effect' })).toMatchObject({ state: 'not_applied' })
      await sourcePool.query("UPDATE records SET withdrawn=true WHERE id='order-1'")
      await expect(two.access.authorize(retained(second))).rejects.toMatchObject({ code: 'source_access_denied' })
      expect(await one.access.reconcile({ version: SOURCE_PROTOCOL_VERSION, idempotencyKey: args.idempotencyKey })).toMatchObject({ state: 'uncertain' })
      expect(source.counters.effects).toBe(1)
      await source.close(); source = undefined
      await expect(two.access.authorize(retained(second))).rejects.toMatchObject({ code: 'source_unavailable' })
    } finally {
      await source?.close(); await sourcePool.end()
      await pool.query(`DROP SCHEMA ${sourceSchema} CASCADE`); await pool.query(`DROP ROLE ${sourceRole}`)
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]); await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner,first,second,foreign,unmapped]])
    }
  })
})
