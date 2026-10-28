import { createPublicKey, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createConnectorActorVerifier, SOURCE_PROTOCOL_VERSION,
  type SourceAuthorizationRequest } from '@use-brian/brian-app/connector'
import { ContextScopeAccumulator, bindScopeSources, scopeEvidenceFromRows, executionToolContext, NOOP_TURN_LEDGER, createOpenAICompatProvider, wrapFallback, CodexRpcPeer, createCodexAppServerProvider, type LLMProvider, type Message, type ScopeSource, type Tool } from '@use-brian/core'
import { getAppPool, getPool, applyRLSGucs, queryWithRLS } from '../../db/client.js'
import { createMemory, getMemoryById, updateMemory } from '../../db/memories.js'
import { validateAudienceScopeEvidence, validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { runAssistantTurn } from '../../turn/kernel.js'
import { readCurrentScopeSources, validateDerivedWriteInputs, validateDerivedMemoryInputs, validateDerivedEntityInputs, recordDerivedResource } from '../../db/derived-scope-store.js'
import { activatePinnedExternalSourceOperation, bindTrustedSourceRead, pinExternalSourceOperation } from '../source-store.js'
import { createConnectorSourceRuntimeFactory, configureConnectorSourceRuntimeFactory } from '../source-runtime.js'
import { readExternalSourceAncestors } from '../external-source-ancestry.js'
import { createRetainedSourceAuthorityCoordinator, pinPreparedExternalSourceAuthority } from '../retained-source-authority.js'
import { injectMcpTools } from '../../mcp/inject.js'
import { createDbConnectorStore } from '../../db/connector-store.js'
import { createConnectorGrantStore } from '../../db/connector-grant-store.js'
import { createDbMcpSettingsStore } from '../../db/mcp-settings-store.js'
import { createConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { createConnectorRuntimeAuthority } from '../connector-runtime-authority.js'
import { createConnectorActorKeyStore } from '../connector-actor-keys.js'
import { createConnectorActorFetch } from '../connector-actor-transport.js'
import { createSourceAccessClient, trustedSourceEnvelope } from '../source-access.js'
import { callRemoteMcpTool } from '../../mcp/client.js'
import { ApplicationManagementService } from '../management.js'
import { ApplicationPlatformService } from '../service.js'
import { independentSourceSchema, independentSourceReplayConsumer, startIndependentSource } from './fixtures/independent-source.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/external-source-access] independent persisted source ACL', () => {
  const pool = getPool()
  let protocol: AsyncGenerator<string,string,void> | undefined
  afterAll(async () => { await protocol?.return('closed'); configureConnectorSourceRuntimeFactory(undefined); await getAppPool().end(); await pool.end() })
  it('lets a personal owner delete an exposed connector without workspace trust administration or losing observation identity', async () => {
    const workspace = randomUUID(), owner = randomUUID(), member = randomUUID(), assistant = randomUUID()
    for (const id of [owner,member]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)", [id])
    try {
      await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Personal source lifecycle fixture',$2)", [workspace,owner])
      for (const [id,role] of [[owner,'owner'],[member,'member']]) await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [workspace,id,role])
      await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Lifecycle assistant',$2,$3,'standard')", [assistant,owner,workspace])
      const instances = createConnectorInstanceStore(randomBytes(32)), instance = await instances.createUserInstance({ userId: member, createdBy: member,
        provider: randomUUID(), label: 'Personal source fixture', url: 'https://source.example/mcp', connected: true, custom: true,
        credentials: { type: 'bearer', token: 'fictional-private-source-token' } })
      await createConnectorGrantStore().create({ actingUserId: member, connectorInstanceId: instance.id, targetType: 'workspace', targetId: workspace, compartments: [], projectIds: [] })
      const profile = (await pool.query<{ id: string }>(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,status,created_by_user_id)
        VALUES($1,$2,'lifecycle-tenant','https://brain.example','https://source.example','https://source.example','https://source.example/mcp','qualified',$3) RETURNING id`, [workspace,instance.id,owner])).rows[0].id
      const resource = (await pool.query<{ id: string }>("INSERT INTO external_source_resources(workspace_id,profile_id,resource_type,opaque_id) VALUES($1,$2,'case','fictional-reference') RETURNING id", [workspace,profile])).rows[0].id
      const metadata = { resource: { type: 'case', id: 'fictional-reference', contentVersion: '1', policyVersion: '1' }, fields: ['description'],
        labels: { sensitivity: 'internal', compartments: [], projectIds: [] }, subjects: [{ kind: 'human', id: member, executingAssistantId: assistant }],
        actions: ['read','context'], retention: { mode: 'governed' }, export: { model: true, destinations: [] } }
      const observation = (await pool.query<{ id: string }>(`INSERT INTO external_source_observations(workspace_id,resource_id,version,content_version,policy_version,fields,observation,sensitivity,compartments,project_ids)
        VALUES($1,$2,$3,'1','1',ARRAY['description'],$4,'internal','{}','{}') RETURNING id`, [workspace,resource,'a'.repeat(64),metadata])).rows[0].id
      expect((await queryWithRLS(member, 'SELECT id FROM connector_source_profiles WHERE id=$1', [profile])).rows).toEqual([])
      const project = randomUUID()
      await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Scope lifecycle fixture','scope lifecycle fixture',$3)", [project,workspace,owner])
      await pool.query("INSERT INTO project_shared_scopes(project_id,workspace_id,origin,created_by) VALUES($1,$2,'created',$3)", [project,workspace,owner])
      const beforeQuarantine = (await pool.query('SELECT external_source_authority_fingerprint($1,$2) AS fingerprint', [workspace,profile])).rows[0].fingerprint
      await pool.query("UPDATE project_shared_scopes SET status='quarantined' WHERE project_id=$1", [project])
      expect((await pool.query('SELECT external_source_authority_fingerprint($1,$2) AS fingerprint', [workspace,profile])).rows[0].fingerprint).not.toBe(beforeQuarantine)
      expect(await instances.delete(member, instance.id)).toBe(true)
      expect((await pool.query('SELECT status,connector_instance_id,original_connector_instance_id FROM connector_source_profiles WHERE id=$1', [profile])).rows[0])
        .toEqual({ status: 'revoked', connector_instance_id: null, original_connector_instance_id: instance.id })
      expect((await pool.query('SELECT resource_id FROM external_source_observations WHERE id=$1', [observation])).rows).toEqual([{ resource_id: resource }])
      expect((await pool.query("SELECT read_scope_source($1,'external_source',$2) AS source", [workspace,observation])).rows[0].source).toEqual({ held: true })
    } finally {
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]); await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner,member]])
    }
  })
  // One persisted source installation is exercised in named sequential steps.
  // Keep its real receipts/derivatives across steps without one oversized test
  // or a larger timeout. Every step is required; no assertion is discarded.
  it.each(['owner reviewed connector admission','source receipt currentness','retained derivation authority',
    ...Array.from({length:8},(_,index)=>`canonical ancestry cohort ${index+1}`),
    'bounded ancestry and immutable metadata','compound and personal model audiences','live model context and delivery',
    'revoked model identities','physical model retry','RPC history admission','discovery effects and source lifecycle'])(
    '%s',async step => {
      protocol ??= sourceScenario()
      expect((await protocol.next()).value).toBe(step)
    })
  async function* sourceScenario(): AsyncGenerator<string,string,void> {
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
      const replay = { key: randomBytes(32).toString('base64url'), expiresAt: Math.floor(Date.now() / 1000) + 65, now: Math.floor(Date.now() / 1000) }
      expect(await independentSourceReplayConsumer(sourcePool)(replay)).toBe(true)
      expect(await independentSourceReplayConsumer(sourcePool)(replay)).toBe(false)
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
      for (const id of [owner,first,second,foreign]) await sourcePool.query("INSERT INTO accounts(kind,id) VALUES('human',$1)", [id])
      await sourcePool.query('INSERT INTO assistants(id) VALUES($1)', [assistant])
      await sourcePool.query("INSERT INTO records(id,kind,data,compartments) VALUES('order-1','purchase',$1,$2)", [{ description: 'Fictional parts', cost: '37.25' },[`team:${department}`]])
      const actions = ['read','context','derive','retain','deliver','export','mutate']
      for (const [id,fields] of [[owner,['description']],[first,['description','cost']],[second,['description']],[foreign,['description','cost']]] as const) await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [id,fields,actions])
      const issuer = `https://${randomUUID()}.installation.example`, audience = 'https://independent-source.example', transportToken = randomBytes(32).toString('base64url')
      const encryptionKey = randomBytes(32), keys = createConnectorActorKeyStore(encryptionKey), instances = createConnectorInstanceStore(encryptionKey)
      // Source independently pins deployment keys/instance before starting; no token-selected discovery URL.
      const instance = await instances.createWorkspaceInstance({ workspaceId: workspace, createdBy: owner, provider: randomUUID(), label: 'Independent source fixture', custom: true,
        connected: true, compartments: [`team:${department}`], projectIds: [], credentials: { type: 'bearer', token: transportToken } })
      const verify = createConnectorActorVerifier({ issuer, audience, workspaceId: workspace, connectorInstanceId: instance.id,
        consumeReplay: independentSourceReplayConsumer(sourcePool), trustedKey: async kid => { const jwk = (await keys.publicJwks(issuer)).keys.find(key => key.kid === kid)
          return jwk ? { key: createPublicKey({ key: jwk, format: 'jwk' }) } : null } })
      let verifiedAuthentication: string | undefined
      source = await startIndependentSource({ pool: sourcePool, tenant: 'fixture-tenant', transportToken, pathPrefix: '/api', verifyActor: async (assertion, request) => {
        const actor = await verify(assertion, request)
        verifiedAuthentication = actor.actor.kind === 'human' ? actor.actor.authenticationKind : undefined
        return actor
      },
        uiSessions: new Map([['first-ui-session',{ kind: 'human', id: first, executingAssistantId: assistant }],['second-ui-session',{ kind: 'human', id: second, executingAssistantId: assistant }]]) })
      await instances.update(owner, instance.id, { url: `${source.url}/mcp` })
      const sourceRuntimeFactory = createConnectorSourceRuntimeFactory({ issuer, keys, instances })
      configureConnectorSourceRuntimeFactory(sourceRuntimeFactory, { instances })
      const management = new ApplicationManagementService(new ApplicationPlatformService([]))
      const manage = (command: unknown) => management.executeCommand(owner,workspace,command,{audience:'human',assistantId:assistant})
      const publicIdentity = await manage({kind:'connector.identity.prepare'}) as {issuer:string;publicJwks:{keys:unknown[]}}
      expect(publicIdentity.issuer).toBe(issuer); expect(publicIdentity.publicJwks.keys).toHaveLength(1)
      expect(await manage({kind:'connector.identity.prepare'})).toEqual(publicIdentity)
      await expect(management.executeCommand(first,workspace,{kind:'connector.identity.prepare'},{audience:'human',assistantId:assistant})).rejects.toMatchObject({code:'access_unavailable'})
      const review = await manage({kind:'connector.source.review',input:{instanceId:instance.id,tenant:'fixture-tenant',audience,
        sourceBaseUrl:source.url,httpReadPath:'/api/http/read',probeTool:'readRecord',probeInput:{id:'order-1',fields:['description']}}}) as {reviewId:string;profileId:string;bindingRevision:string}
      const sourceProfile = review.profileId
      expect(review.bindingRevision).toBe('2')
      expect(JSON.stringify(review)).not.toContain(transportToken)
      const pendingActor=await client(first)
      await expect(sourceRuntimeFactory({workspaceId:workspace,instanceId:instance.id,execution:pendingActor.execution,
        accumulator:new ContextScopeAccumulator(),headers:{Authorization:`Bearer ${transportToken}`}})).rejects.toMatchObject({code:'source_unavailable'})
      const readsBeforeExpired=source.counters.reads
      await pool.query("UPDATE connector_attended_setup_reviews SET expires_at=now()-interval '1 second' WHERE id=$1",[review.reviewId])
      await expect(manage({kind:'connector.source.apply',reviewId:review.reviewId})).rejects.toMatchObject({code:'access_unavailable'})
      expect(source.counters.reads).toBe(readsBeforeExpired)
      await pool.query("UPDATE connector_attended_setup_reviews SET expires_at=now()+interval '5 minutes' WHERE id=$1",[review.reviewId])
      await expect(queryWithRLS(owner,'SELECT connector_apply_attended_source($1,NULL)',[review.reviewId])).rejects.toMatchObject({code:'42501'})
      await expect(queryWithRLS(owner,"INSERT INTO connector_attended_setup_approvals(id,review_id,actor_id,snapshot,proof_digest,expires_at) VALUES($1,$2,$3,'fake','fake',now()+interval '1 hour')",[randomUUID(),review.reviewId,owner])).rejects.toMatchObject({code:'42501'})
      await expect(queryWithRLS(owner,"UPDATE connector_source_profiles SET attended_profile=NULL WHERE id=$1",[sourceProfile])).rejects.toMatchObject({code:'22023'})
      expect(await manage({kind:'connector.source.apply',reviewId:review.reviewId})).toMatchObject({profileId:sourceProfile,state:'qualified'})
      expect(await manage({kind:'connector.source.apply',reviewId:review.reviewId})).toMatchObject({profileId:sourceProfile,state:'qualified'})
      expect((await pool.query('SELECT attended_profile,scoped_app_id,revision::text FROM connector_source_profiles WHERE id=$1',[sourceProfile])).rows[0])
        .toEqual({attended_profile:'attended_governed_read_v1',scoped_app_id:null,revision:'2'})
      await expect(queryWithRLS(owner, "UPDATE connector_source_profiles SET status='qualified' WHERE id=$1", [sourceProfile])).rejects.toMatchObject({ code: '42501' })
      expect((await queryWithRLS(owner, "SELECT application_runtime_qualified($1,'connector_source') AS ready", [workspace])).rows[0].ready).toBe(false)
      expect((await queryWithRLS(first, 'SELECT id FROM connector_source_profiles WHERE workspace_id=$1', [workspace])).rows).toEqual([])
      yield 'owner reviewed connector admission'
      async function client(userId: string, authenticationKind: 'native_session' | 'verified_channel' | 'credential_attribution' | null = 'native_session') {
        const execution = (await resolveExecutionContextSystem({ userId, workspaceId: workspace, assistant: (await findAssistantById(assistant))!, memberMode: 'member',
          identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, ...(authenticationKind ? { authenticationKind } : {}) } }, ownership: { kind: 'workspace', workspaceId: workspace },
          lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelId: 'fixture', channelType: 'test', abortSignal: new AbortController().signal } })).executionContext
        const native = await createConnectorRuntimeAuthority({ workspaceId: workspace, assistantId: assistant, initiatingUserId: userId })
        const ports = { ...keys, admit: async () => { await native.assertCurrent(); const current = await instances.getSystem(instance.id)
          return current?.connected && native.allows(current) ? { bindingRevision: '2', actor: { kind: 'human' as const, userId, authenticationKind: 'native_session' as const } } : null } }
        const profile = { issuer, audience, workspaceId: workspace, connectorInstanceId: instance.id, sourceBaseUrl: source!.url, mcpUrl: `${source!.url}/mcp`,
          httpReadPath: '/api/http/read', tenant: 'fixture-tenant', bindingRevision: '2', subject: { kind: 'human' as const, id: userId, executingAssistantId: assistant } }
        return { execution, profile, ports, access: createSourceAccessClient(execution, profile, ports, { headers: { Authorization: `Bearer ${transportToken}` } }) }
      }
      let one = await client(first), two = await client(second), unknown = await client(unmapped), outsider = await client(foreign)
      const retainedCoordinator = createRetainedSourceAuthorityCoordinator({ factory: createConnectorSourceRuntimeFactory({ issuer, keys, instances }), instances })
      const ui = async (session: string, fields: string) => fetch(`${source!.url}/ui/records/order-1?fields=${fields}`, { headers: { Authorization: `Bearer ${session}` } })
      expect(await (await ui('first-ui-session','cost')).json()).toEqual({ cost: '37.25' }); expect((await ui('second-ui-session','cost')).status).toBe(403)
      const read = await one.access.readMcp('readRecord', { id: 'order-1', fields: ['description','cost'] })
      expect(JSON.stringify(read.result)).toContain('37.25'); expect(read.result).not.toHaveProperty('_meta')
      const evidence = trustedSourceEnvelope(read)!
      expect(evidence.resources[0].fields).toEqual(['description','cost']); expect(trustedSourceEnvelope(structuredClone(read))).toBeUndefined()
      const selectionRequest: SourceAuthorizationRequest = { version: SOURCE_PROTOCOL_VERSION,operationId: randomUUID(),
        items: [{ itemId: randomUUID(),resource: evidence.resources[0].resource,fields: ['description','cost'],action: 'context',retentionMode: 'governed' }],
        recipients: [{ recipientId: randomUUID(),subject: one.profile.subject }] }
      const selection = await one.access.authorize(selectionRequest)
      const unpinnedSibling = await one.access.authorize({ ...selectionRequest,items: selectionRequest.items.map(item => ({ ...item,itemId: randomUUID() })) })
      const app = await getAppPool().connect(), accumulator = new ContextScopeAccumulator()
      let retainedSources: Awaited<ReturnType<typeof bindTrustedSourceRead>>['sources']
      try {
        await app.query('BEGIN'); await applyRLSGucs(app, first)
        await expect(bindTrustedSourceRead(app, one.execution, structuredClone(read), accumulator)).rejects.toMatchObject({ code: 'source_access_denied' })
        const bound = await bindTrustedSourceRead(app, one.execution, read, accumulator)
        retainedSources = bound.sources
        await expect(activatePinnedExternalSourceOperation(app, one.execution, selection, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
        await pinExternalSourceOperation(app, one.execution, selection, bound.sources, 'context')
        await expect(activatePinnedExternalSourceOperation(app, one.execution, unpinnedSibling, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
        await expect(activatePinnedExternalSourceOperation(app, one.execution, selection, bound.sources, 'retain')).rejects.toMatchObject({ code: 'source_access_denied' })
        await activatePinnedExternalSourceOperation(app, one.execution, selection, bound.sources, 'context')
        expect(scopeEvidenceFromRows(bound.sourceRows).sources).toEqual(bound.sources)
        expect(accumulator.evidence.sources).toEqual(bound.sources)
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['current'])
        for (const validate of [validateDerivedWriteInputs,validateDerivedMemoryInputs,validateDerivedEntityInputs]) {
          await expect(validate(app, { producer: 'independent-source-fixture', sources: bound.sources })).rejects.toThrow('scope_source_changed')
        }
        await expect(recordDerivedResource(app, { producer: 'context-cannot-retain', sources: bound.sources },
          { ...bound.sources[0], resourceKind: 'memory', resourceId: randomUUID() })).rejects.toThrow('scope_source_changed')
        await app.query("SELECT set_config('app.external_source_action','retain',true)")
        await expect(validateDerivedWriteInputs(app, { producer: 'no-receipt-upgrade', sources: bound.sources })).rejects.toThrow('scope_source_changed')
        await app.query("SELECT set_config('app.external_source_action','context',true)")
        await app.query('SAVEPOINT context_lineage')
        await expect(app.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          VALUES($1,$2,'external_source',$3,$4)`, [workspace,randomUUID(),bound.sources[0].resourceId,bound.sources[0].version]))
          .rejects.toMatchObject({ code: '42501', message: 'scope_source_changed' })
        await app.query('ROLLBACK TO SAVEPOINT context_lineage')
        const costRead = await one.access.readHttp({ id: 'order-1', fields: ['cost'] })
        const costBound = await bindTrustedSourceRead(app, one.execution, costRead, accumulator)
        expect(costBound.sources[0].resourceId).not.toBe(bound.sources[0].resourceId)
        expect(accumulator.evidence.sources).toHaveLength(2)
        const combined = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'retain', retentionMode: 'governed' },
          { itemId: randomUUID(), resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'derive', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await pinExternalSourceOperation(app, one.execution, combined, accumulator.evidence.sources!, 'retain')
        await validateDerivedWriteInputs(app, { producer: 'independent-field-observations', sources: accumulator.evidence.sources! })
        await validateDerivedMemoryInputs(app, { producer: 'independent-retained-memory', sources: accumulator.evidence.sources! })
        await validateDerivedEntityInputs(app, { producer: 'independent-retained-entity', sources: accumulator.evidence.sources! })
        const retainItem = combined.request.items.find(item => item.action === 'retain')!, deriveItem = combined.request.items.find(item => item.action === 'derive')!
        const retainDecision = combined.response.decisions.find(decision => decision.itemId === retainItem.itemId)!, deriveDecision = combined.response.decisions.find(decision => decision.itemId === deriveItem.itemId)!
        if (!retainDecision.allowed || !deriveDecision.allowed) throw new Error('Fixture retained decision missing')
        const storedReceipt = (await pool.query('SELECT source_receipt,derivation_receipt,expires_at FROM external_source_authorizations WHERE operation_id=$1 AND observation_id=$2',
          [combined.request.operationId,bound.sources[0].resourceId])).rows[0]
        expect(storedReceipt.source_receipt).toBe(retainDecision.receipt.id); expect(storedReceipt.derivation_receipt).toBe(deriveDecision.receipt.id)
        expect(storedReceipt.expires_at.getTime()).toBe(Math.min(retainDecision.receipt.expiresAt,deriveDecision.receipt.expiresAt))
        expect((await app.query('SELECT external_source_retention_allowed($1,$2,$3) AS allowed', [workspace,bound.sources[0].resourceId,bound.sources[0].version])).rows[0].allowed).toBe(true)
        const retainOnly = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'retain', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await expect(pinExternalSourceOperation(app, one.execution, retainOnly, bound.sources, 'retain')).rejects.toMatchObject({ code: 'source_access_denied' })
        await sourcePool.query("UPDATE grants SET actions=array_remove(actions,'derive') WHERE account_id=$1", [first])
        await expect(one.access.authorize({ ...combined.request, operationId: randomUUID() })).rejects.toMatchObject({ code: 'source_access_denied' })
        await sourcePool.query('UPDATE grants SET actions=$2 WHERE account_id=$1', [first,actions])
        expect((await readCurrentScopeSources(app, workspace, [{ ...bound.sources[0], version: '0'.repeat(64) }])).map(row => row.state)).toEqual(['unverifiable'])
        const prepared = await retainedCoordinator.prepare(one.execution, accumulator.evidence.sources!, 'retain')
        await expect(pinPreparedExternalSourceAuthority(app, one.execution, structuredClone(prepared))).rejects.toMatchObject({ code: 'source_access_denied' })
        await expect(pinPreparedExternalSourceAuthority(app, two.execution, prepared)).rejects.toMatchObject({ code: 'source_access_denied' })
        await pinPreparedExternalSourceAuthority(app, one.execution, prepared)
        await validateDerivedWriteInputs(app, { producer: 'shared-retained-coordinator', sources: accumulator.evidence.sources! })
        await expect(retainedCoordinator.prepare(two.execution, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
        const beforeRecipient = source.counters.authorizations
        await expect(retainedCoordinator.prepare(one.execution, bound.sources, 'context', [{ ...one.profile.subject, id: foreign }]))
          .rejects.toMatchObject({ reason: 'caller_evidence_unavailable' })
        expect(source.counters.authorizations).toBe(beforeRecipient)
        const oldOperationId = prepared.operationId
        await app.query('COMMIT')
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await app.query('BEGIN'); await applyRLSGucs(app, first)
        await expect(pinPreparedExternalSourceAuthority(app, one.execution, prepared)).rejects.toMatchObject({ code: 'source_access_denied' })
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
        await expect(one.execution.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
        // Explicit new invocations after the native policy change. A restored
        // Department edge cannot revive any old workspace-wide epoch lease.
        one = await client(first); two = await client(second)
        unknown = await client(unmapped); outsider = await client(foreign)
        await app.query('BEGIN'); await applyRLSGucs(app, first)
        const expiring = await one.access.authorize({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(), items: [{ itemId: randomUUID(),
          resource: evidence.resources[0].resource, fields: ['description','cost'], action: 'context', retentionMode: 'governed' }],
          recipients: [{ recipientId: randomUUID(), subject: one.profile.subject }] })
        await pinExternalSourceOperation(app, one.execution, expiring, bound.sources, 'context')
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['current'])
        await new Promise(resolve => setTimeout(resolve, 5_100))
        expect((await readCurrentScopeSources(app, workspace, bound.sources)).map(row => row.state)).toEqual(['held'])
        await expect(pinExternalSourceOperation(app, one.execution, expiring, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_protocol_invalid' })
        await expect(activatePinnedExternalSourceOperation(app, one.execution, expiring, bound.sources, 'context')).rejects.toMatchObject({ code: 'source_protocol_invalid' })
        await app.query('ROLLBACK')
      } finally { await app.query('ROLLBACK'); app.release() }
      yield 'source receipt currentness'
      // Internal canonical writer transaction: source proof is still checked, not borrowed from its database owner.
      const writer = await pool.connect()
      let retainedDerivative: ScopeSource
      let firstDerivative: ScopeSource | undefined
      let privateNative: Awaited<ReturnType<typeof createMemory>>
      try {
        let inputs = retainedSources!
        for (let generation = 0; generation < 2; generation++) {
          const contextAuthority = await retainedCoordinator.prepare(one.execution, inputs, 'context')
          await writer.query('BEGIN'); await applyRLSGucs(writer, first)
          await pinPreparedExternalSourceAuthority(writer, one.execution, contextAuthority)
          const prepared = await retainedCoordinator.prepare(one.execution, inputs, 'retain')
          const authorizations = source!.counters.authorizations
          await pinPreparedExternalSourceAuthority(writer, one.execution, prepared)
          const receipts = (await pool.query('SELECT count(*)::int AS count FROM external_source_authorizations WHERE operation_id=ANY($1::uuid[])',
            [[prepared.operationId,contextAuthority.operationId]])).rows[0].count
          const memory = await createMemory({ assistantId: assistant, userId: null, workspaceId: workspace,
            createdByUserId: first, summary: 'Fictional source-derived cost 37.25', sensitivity: 'public',
            derivation: { producer: 'retained-source-ancestry-fixture', sources: inputs } }, undefined, writer)
          retainedDerivative = { workspaceId: workspace,userId: memory.userId,assistantId: memory.assistantId,resourceKind: 'memory',resourceId: memory.id,
            version: memory.scopeVersion,sensitivity: memory.sensitivity,compartments: memory.compartments,projectIds: memory.projectIds }
          expect(await readExternalSourceAncestors(workspace, [retainedDerivative], writer)).toEqual(retainedSources)
          // Selecting the pre-pinned context proof after the canonical write inserts no receipt and takes no source HTTP path.
          await pinPreparedExternalSourceAuthority(writer, one.execution, contextAuthority)
          const inTransaction = await validateCallerScopeEvidence({ sources: [retainedDerivative] }, one.execution.security.ceiling, writer)
          expect(inTransaction.sources?.filter(source => source.resourceKind === 'external_source')).toEqual(retainedSources)
          expect((await pool.query('SELECT count(*)::int AS count FROM external_source_authorizations WHERE operation_id=ANY($1::uuid[])',
            [[prepared.operationId,contextAuthority.operationId]])).rows[0].count).toBe(receipts)
          expect(source!.counters.authorizations).toBe(authorizations)
          await writer.query('COMMIT')
          firstDerivative ??= retainedDerivative
          inputs = [retainedDerivative]
        }
        const descendants = (await pool.query('SELECT count(*)::int AS count FROM scope_derivations WHERE workspace_id=$1 AND producer=$2', [workspace,'retained-source-ancestry-fixture'])).rows[0].count
        expect(descendants).toBe(2)
        // Canonical supersession changes the head ID. The successor still owes the predecessor's source rights.
        const predecessor = retainedDerivative!
        const updateAuthority = await retainedCoordinator.prepare(one.execution, [predecessor], 'retain')
        await writer.query('BEGIN'); await applyRLSGucs(writer, first)
        await pinPreparedExternalSourceAuthority(writer, one.execution, updateAuthority)
        const successor = await updateMemory(predecessor.resourceId, { summary: 'Fictional updated source derivative' }, one.execution.security.access, writer)
        expect(successor).not.toBeNull(); expect(successor!.id).not.toBe(predecessor.resourceId)
        retainedDerivative = { ...predecessor,resourceId: successor!.id,version: successor!.scopeVersion }
        await writer.query('COMMIT')
        // Repeated historical derivations may form cycles; the metadata walk must terminate and keep the source.
        await pool.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT $1,id,'memory',$3,$4 FROM scope_derivations WHERE workspace_id=$1 AND resource_id=$2`,
          [workspace,firstDerivative!.resourceId,retainedDerivative!.resourceId,retainedDerivative!.version])
        // Native context/delivery boundaries must recover the source obligation themselves.
        await expect(validateAudienceScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling))
          .rejects.toMatchObject({ diagnostic: 'source_held' })
        const current = await retainedCoordinator.prepare(one.execution, [retainedDerivative!], 'context')
        await writer.query('BEGIN'); await applyRLSGucs(writer, first)
        await pinPreparedExternalSourceAuthority(writer, one.execution, current)
        const admitted = await validateCallerScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling, writer)
        expect(admitted.sources?.filter(source => source.resourceKind === 'external_source')).toEqual(retainedSources)
        await expect(validateAudienceScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling, writer))
          .rejects.toMatchObject({ diagnostic: 'source_held' })
        await writer.query('COMMIT')
        const delivery = await retainedCoordinator.prepare(one.execution, [retainedDerivative!], 'deliver')
        await writer.query('BEGIN'); await applyRLSGucs(writer, first)
        await pinPreparedExternalSourceAuthority(writer, one.execution, delivery)
        expect(await validateAudienceScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling, writer)).toEqual(admitted)
        await expect(validateCallerScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling, writer))
          .rejects.toMatchObject({ diagnostic: 'source_held' })
        await writer.query('COMMIT')
        await writer.query('BEGIN'); await applyRLSGucs(writer, second)
        privateNative = await createMemory({ assistantId: assistant,userId: second,workspaceId: workspace,createdByUserId: second,
          summary: 'Fictional private native fact',sensitivity: 'public',source: 'user' }, undefined, writer)
        await writer.query('COMMIT')
        const reader = await getAppPool().connect()
        try {
          await reader.query('BEGIN'); await applyRLSGucs(reader, first)
          const admittedProof = await retainedCoordinator.prepare(one.execution, [retainedDerivative!], 'context')
          await pinPreparedExternalSourceAuthority(reader, one.execution, admittedProof)
          expect((await reader.query("SELECT has_function_privilege(current_user,'read_external_source_dependencies(uuid,text[],uuid[],text[])','EXECUTE') AS raw")).rows[0].raw).toBe(false)
          expect(await readExternalSourceAncestors(workspace, [retainedDerivative!], reader)).toEqual(retainedSources)
          const admitted = await validateCallerScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling, reader)
          expect(admitted.sources?.filter(source => source.resourceKind === 'external_source')).toEqual(retainedSources)
          expect((await reader.query("SELECT read_admitted_native_scope_snapshot($1,'memory',$2) AS snapshot", [workspace,privateNative!.id])).rows[0].snapshot).toEqual({ held: true })
          const currentMetadata = (await reader.query("SELECT read_admitted_native_scope_snapshot($1,'memory',$2) AS snapshot", [workspace,retainedDerivative!.resourceId])).rows[0].snapshot
          expect(currentMetadata.held).toBe(false); expect(JSON.stringify(currentMetadata)).not.toContain('Fictional')
          await reader.query('SAVEPOINT foreign_observation')
          await expect(reader.query("SELECT read_admitted_native_scope_snapshot($1,'memory',$2)", [randomUUID(),privateNative!.id])).rejects.toMatchObject({ code: '42501' })
          await reader.query('ROLLBACK TO SAVEPOINT foreign_observation')
          await reader.query('ROLLBACK')
        } finally { await reader.query('ROLLBACK'); reader.release() }
        // A native mutation inside this transaction must not reuse proof for the earlier ancestor set.
        const narrowerRead = await one.access.readMcp('readRecord', { id: 'order-1',fields: ['description'] })
        const observationTransaction = await getAppPool().connect()
        let additionalSources: ScopeSource[]
        try {
          await observationTransaction.query('BEGIN'); await applyRLSGucs(observationTransaction, first)
          additionalSources = (await bindTrustedSourceRead(observationTransaction, one.execution, narrowerRead, new ContextScopeAccumulator())).sources
          await observationTransaction.query('COMMIT')
        } finally { await observationTransaction.query('ROLLBACK'); observationTransaction.release() }
        const originalAuthority = await retainedCoordinator.prepare(one.execution, [retainedDerivative!], 'context')
        const addedAuthority = await retainedCoordinator.prepare(one.execution, additionalSources!, 'retain')
        await writer.query('BEGIN'); await applyRLSGucs(writer, first)
        await pinPreparedExternalSourceAuthority(writer, one.execution, originalAuthority)
        await pinPreparedExternalSourceAuthority(writer, one.execution, addedAuthority)
        await writer.query('SAVEPOINT ancestry_change')
        await writer.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT $1,id,'external_source',$3,$4 FROM scope_derivations WHERE workspace_id=$1 AND resource_id=$2`,
          [workspace,firstDerivative!.resourceId,additionalSources![0].resourceId,additionalSources![0].version])
        await expect(pinPreparedExternalSourceAuthority(writer, one.execution, originalAuthority)).rejects.toMatchObject({ code: 'source_access_denied' })
        await writer.query('ROLLBACK TO SAVEPOINT ancestry_change')
        await expect(pinPreparedExternalSourceAuthority(writer, one.execution, originalAuthority)).rejects.toMatchObject({ code: 'source_access_denied' })
        await writer.query('ROLLBACK')
        // Oversized ancestry is an explicit refusal, never silently truncated evidence.
        yield 'retained derivation authority'
        await writer.query('BEGIN'); await applyRLSGucs(writer, first)
        // Keep the canonical memory writer even for this wide physical cohort.
        // Checkpoint bounded setup batches; the complete 4096-node refusal below
        // remains required, with the original receipt and test deadlines.
        const wide: Array<{id:string;version:string}> = []
        for(let batch=0;batch<8;batch++){
          for(let index=0;index<512;index++){
            const memory=await createMemory({assistantId:assistant,userId:null,workspaceId:workspace,createdByUserId:first,
              summary:'Fictional bounded-ancestry input',sensitivity:'public'},undefined,writer)
            expect(memory.userId).toBeNull()
            wide.push({id:memory.id,version:memory.scopeVersion})
          }
          yield `canonical ancestry cohort ${batch+1}`
        }
        await writer.query(`INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT $1,d.id,'memory',s.id,s.version FROM scope_derivations d CROSS JOIN unnest($3::uuid[],$4::text[]) s(id,version)
          WHERE d.workspace_id=$1 AND d.resource_id=$2`, [workspace,firstDerivative!.resourceId,wide.map(row => row.id),wide.map(row => row.version)])
        await expect(readExternalSourceAncestors(workspace, [retainedDerivative!], writer)).rejects.toMatchObject({ code: 'source_access_denied' })
        await writer.query('ROLLBACK')
        await expect(retainedCoordinator.prepare(two.execution, [retainedDerivative!], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
      } finally { await writer.query('ROLLBACK'); writer.release() }
      for (const table of ['external_source_resources','external_source_observations','external_source_authorizations']) {
        await expect(queryWithRLS(first, `SELECT * FROM ${table} WHERE workspace_id=$1`, [workspace])).rejects.toMatchObject({ code: '42501' })
      }
      const missing = { ...retainedSources![0], resourceId: randomUUID() }
      expect((await readCurrentScopeSources(pool, workspace, [missing])).map(row => row.state)).toEqual(['unverifiable'])
      await expect(pool.query('UPDATE external_source_observations SET fields=$2 WHERE id=$1', [retainedSources![0].resourceId,['description']])).rejects.toMatchObject({ code: '22023' })
      expect((await pool.query('SELECT count(*)::int AS count FROM external_source_resources WHERE profile_id=$1', [sourceProfile])).rows[0].count).toBe(1)
      expect((await pool.query('SELECT count(*)::int AS count FROM external_source_observations WHERE workspace_id=$1', [workspace])).rows[0].count).toBe(3)
      yield 'bounded ancestry and immutable metadata'
      // The real shared kernel admits model input under current source rights. This local provider incurs no model/API cost.
      const cached = await getMemoryById(one.execution.security.access, firstDerivative!.resourceId)
      expect(cached?.summary).toContain('37.25')
      async function modelFromRetained(actor: Awaited<ReturnType<typeof client>>, includeExecution = true, input: { sources?: ScopeSource[]; content?: string; provider?: LLMProvider; messages?: Message[]; onEvent?: (event: unknown) => void } = {}) {
        let sessions = 0, requests = 0
        const observed: string[] = []
        const provider: LLMProvider = { name: 'fixture',models: ['fixture-model'],
          createSession: options => {
            sessions++; observed.push(options.runtimeSystemContext ?? '')
            return { send: () => {
              requests++
              return (async function* () {
                yield { type: 'message_start' as const,model: 'fixture-model' }
                yield { type: 'text_delta' as const,text: 'Fictional checked result' }
                yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
              })()
            } }
          },
          stream: () => { requests++; throw new Error('Unexpected fixture model fallback') },
        }
        const accumulator = new ContextScopeAccumulator({ sources: input.sources ?? [firstDerivative!] })
        const context = { ...executionToolContext(actor.execution, { appId: 'model-fixture' }),scopeAccumulator: accumulator,
          // An optional route hook cannot replace the mandatory source boundary.
          assertModelInputAuthority: async () => {},...(!includeExecution ? { executionContext: undefined } : {}) }
        const run = () => runAssistantTurn({ sessionId: actor.execution.lifecycle.sessionId,policy: { admission: 'personal' },sink: input.onEvent ? { kind: 'sse',onEvent: input.onEvent } : { kind: 'return' },
          lease: { mode: 'none' },abortController: new AbortController(),
          model: { provider: input.provider ?? provider,model: 'fixture-model',configuredProviders: undefined,customLlm: null },
          loop: { ledger: NOOP_TURN_LEDGER,context,systemPrompt: 'Fictional model input fixture',runtimeSystemContext: input.content ?? cached!.summary,
            messages: input.messages ?? [{ role: 'user',content: 'Report the fictional retained result.' }],tools: new Map(),maxTurns: 1 } })
        return { run,accumulator,observed,counts: () => ({ sessions,requests }) }
      }
      configureConnectorSourceRuntimeFactory(sourceRuntimeFactory, { instances })
      try {
        const privateSource: ScopeSource = { workspaceId: workspace,userId: privateNative!.userId,assistantId: privateNative!.assistantId,
          resourceKind: 'memory',resourceId: privateNative!.id,version: privateNative!.scopeVersion,sensitivity: privateNative!.sensitivity,
          compartments: privateNative!.compartments,projectIds: privateNative!.projectIds }
        const compound = bindScopeSources({ total: '37.25' },[firstDerivative!,...retainedSources!])
        const compoundSources = scopeEvidenceFromRows([compound]).sources!
        expect(compoundSources).toEqual([firstDerivative!,...retainedSources!])
        const compoundAllowed = await modelFromRetained(await client(first),true,{ sources: compoundSources })
        await expect(compoundAllowed.run()).resolves.toMatchObject({ selection: { kind: 'text' } })
        expect(compoundAllowed.counts()).toEqual({ sessions: 1,requests: 1 })
        const divided = bindScopeSources({ total: '37.25' },[...compoundSources,privateSource])
        for (const userId of [first,second]) {
          const withheld = await modelFromRetained(await client(userId),true,{ sources: scopeEvidenceFromRows([divided]).sources! })
          await expect(withheld.run()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
          expect(withheld.counts()).toEqual({ sessions: 0,requests: 0 })
        }
        const privateDenied = await modelFromRetained(await client(first), true, { sources: [privateSource],content: privateNative!.summary })
        await expect(privateDenied.run()).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(privateDenied.counts()).toEqual({ sessions: 0,requests: 0 })
        const privateAllowed = await modelFromRetained(await client(second), true, { sources: [privateSource],content: privateNative!.summary })
        await expect(privateAllowed.run()).resolves.toMatchObject({ selection: { kind: 'text' } })
        expect(privateAllowed.counts()).toEqual({ sessions: 1,requests: 1 })
        yield 'compound and personal model audiences'
        const allowed = await modelFromRetained(await client(first))
        expect((await allowed.run()).selection.kind).toBe('text')
        expect(allowed.counts()).toEqual({ sessions: 1,requests: 1 }); expect(allowed.observed[0]).toContain('37.25')
        expect(allowed.accumulator.evidence.sources?.filter(source => source.resourceKind === 'external_source')).toEqual(retainedSources)
        const delivered: unknown[] = [];let outputRequests = 0
        const outputProvider: LLMProvider = { name: 'fixture',models: ['fixture-model'],stream: () => { throw new Error('Unexpected output fallback') },
          createSession: () => ({ send: () => (async function* () {
            outputRequests++
            yield { type: 'message_start' as const,model: 'fixture-model' }
            yield { type: 'text_delta' as const,text: 'Fictional permitted source prefix' }
            // Context remains authorized. The ordinary source ACL revokes only
            // delivery, so a context recheck cannot stand in for this decision.
            await sourcePool.query("UPDATE grants SET actions=array_remove(actions,'deliver') WHERE kind='human' AND account_id=$1 AND record_id='order-1'",[first])
            yield { type: 'text_delta' as const,text: 'Fictional withheld source continuation' }
            yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
          })() }) }
        const outputTurn = await modelFromRetained(await client(first),true,{ provider: outputProvider,onEvent: event => { delivered.push(event) } })
        await expect(outputTurn.run()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
        expect(outputRequests).toBe(1)
        expect(JSON.stringify(delivered)).toContain('Fictional permitted source prefix')
        expect(JSON.stringify(delivered)).not.toContain('Fictional withheld source continuation')
        const contextAfterDeliveryLoss = await modelFromRetained(await client(first))
        await expect(contextAfterDeliveryLoss.run()).resolves.toMatchObject({ selection: { kind: 'text' } })
        await sourcePool.query("UPDATE grants SET actions=$2 WHERE kind='human' AND account_id=$1 AND record_id='order-1'",[first,actions])
        await expect(outputTurn.run()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
        expect(outputRequests).toBe(1)
        yield 'live model context and delivery'
        const narrower = await modelFromRetained(await client(second))
        await expect(narrower.run()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
        expect(narrower.counts()).toEqual({ sessions: 0,requests: 0 })
        const missing = await modelFromRetained(await client(first), false)
        await expect(missing.run()).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(missing.counts()).toEqual({ sessions: 0,requests: 0 })
        const attributed = await modelFromRetained(await client(first, 'credential_attribution'))
        await expect(attributed.run()).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(attributed.counts()).toEqual({ sessions: 0,requests: 0 })
        const revokedActor = await client(first), revoked = await modelFromRetained(revokedActor)
        await sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1 AND record_id='order-1'", [first])
        await expect(revoked.run()).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(revoked.counts()).toEqual({ sessions: 0,requests: 0 })
        await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [first,['description','cost'],actions])
        await expect(revoked.run()).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(revoked.counts()).toEqual({ sessions: 0,requests: 0 })
        const restored = await modelFromRetained(await client(first))
        await expect(restored.run()).resolves.toMatchObject({ selection: { kind: 'text' } })
        yield 'revoked model identities'
        // Real loopback model HTTP: access loss between primary response and retry/fallback must stop the next wire request.
        for (const failover of [false,true]) {
          const bodies: Array<{ path: string; body: string }> = []
          const modelServer = createServer((request,response) => {
            void (async () => {
              const chunks: Buffer[] = []
              for await (const chunk of request) chunks.push(Buffer.from(chunk))
              bodies.push({ path: request.url ?? '',body: Buffer.concat(chunks).toString('utf8') })
              await sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1 AND record_id='order-1'", [first])
              response.writeHead(failover ? 503 : 400, { 'content-type': 'text/plain' })
              response.end(failover ? 'Fictional provider outage' : 'Only one system message is supported')
            })().catch(error => { response.destroy(error as Error) })
          })
          await new Promise<void>(resolve => modelServer.listen(0,'127.0.0.1',resolve))
          try {
            const address = modelServer.address()
            if (!address || typeof address === 'string') throw new Error('Local model fixture did not bind')
            const baseURL = `http://127.0.0.1:${address.port}`
            const primary = createOpenAICompatProvider({ label: 'fixture-primary',baseURL: `${baseURL}/primary` })
            const provider = failover ? wrapFallback(primary,createOpenAICompatProvider({ label: 'fixture-fallback',baseURL: `${baseURL}/fallback` })) : primary
            const turn = await modelFromRetained(await client(first),true,{ provider })
            await expect(turn.run()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
            expect(bodies).toHaveLength(1)
            expect(bodies[0].path).toBe('/primary/chat/completions')
            expect(bodies[0].body).toContain('37.25'); expect(bodies[0].body).not.toContain('assertInputAuthority')
            await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [first,['description','cost'],actions])
            await expect(turn.run()).rejects.toMatchObject({ reason: 'authority_changed' })
            expect(bodies).toHaveLength(1)
          } finally {
            modelServer.closeAllConnections()
            await new Promise<void>(resolve => modelServer.close(() => resolve()))
          }
        }
        yield 'physical model retry'
        // Mock only model RPC. The shared kernel still consults the real independent source ACL.
        for (const stage of ['history','schema'] as const) {
          const inbound = new PassThrough(), frames: Array<{ id: number; method: string; params: unknown }> = []
          const output = new Writable({ write(chunk,_encoding,done) {
            const frame = JSON.parse(chunk.toString()) as typeof frames[number]
            frames.push(frame)
            void (async () => {
              if (frame.method === 'thread/start') {
                if (stage === 'history') await sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1 AND record_id='order-1'", [first])
                inbound.write(`${JSON.stringify({ id: frame.id,result: { thread: { id: 'fixture-thread' },model: 'fixture-model',modelProvider: 'fixture' } })}\n`)
              } else if (frame.method === 'turn/start') {
                await sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1 AND record_id='order-1'", [first])
                inbound.write(`${JSON.stringify({ id: frame.id,error: { code: -32602,message: 'Fictional schema rejection' } })}\n`)
              } else {
                inbound.write(`${JSON.stringify({ id: frame.id,result: {} })}\n`)
              }
              done()
            })().catch(error => done(error as Error))
          } })
          const rpc = new CodexRpcPeer({ input: inbound,output })
          try {
            const codex = createCodexAppServerProvider({ transport: { rpc,cwd: '/tmp/local-model-fixture' },models: ['fixture-model'] })
            const provider: LLMProvider = stage === 'schema' ? { ...codex,createSession: options => ({
              send: (messages,sendOptions) => codex.stream({ ...options,...sendOptions,messages,responseFormat: 'json',responseSchema: { type: 'object' } }),
            }) } : codex
            const turn = await modelFromRetained(await client(first),true,{ provider,...(stage === 'history' ? {
              messages: [{ role: 'assistant' as const,content: cached!.summary },{ role: 'user' as const,content: 'Current fictional request' }],
            } : {}) })
            await expect(turn.run()).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
            expect(frames.filter(frame => frame.method === 'thread/start')).toHaveLength(1)
            expect(frames.filter(frame => frame.method === 'thread/inject_items')).toHaveLength(0)
            expect(frames.filter(frame => frame.method === 'turn/start')).toHaveLength(stage === 'schema' ? 1 : 0)
            expect(JSON.stringify(frames[0])).toContain('37.25')
            expect(JSON.stringify(frames)).not.toContain('assertInputAuthority')
            await sourcePool.query("INSERT INTO grants(kind,account_id,record_id,fields,actions) VALUES('human',$1,'order-1',$2,$3)", [first,['description','cost'],actions])
            await expect(turn.run()).rejects.toMatchObject({ reason: 'authority_changed' })
            expect(frames.filter(frame => ['thread/start','thread/inject_items','turn/start'].includes(frame.method))).toHaveLength(stage === 'schema' ? 2 : 1)
            expect(rpc.closed).toBe(false)
          } finally { rpc.close() }
        }
        configureConnectorSourceRuntimeFactory(sourceRuntimeFactory)
        const unwired = await modelFromRetained(await client(first)), beforeUnwired = source.counters.authorizations
        await expect(unwired.run()).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(unwired.counts()).toEqual({ sessions: 0,requests: 0 }); expect(source.counters.authorizations).toBe(beforeUnwired)
      } finally { configureConnectorSourceRuntimeFactory(undefined) }
      yield 'RPC history admission'

      const inject = async (userId: string, includeExecution = true, authenticationKind: 'native_session' | 'verified_channel' = 'native_session', includeFactory = true) => {
        const actor = await client(userId, authenticationKind), scopeAccumulator = new ContextScopeAccumulator(), tools = new Map<string, Tool>()
        const result = await injectMcpTools({ userId: owner, assistantId: assistant, assistantTeamId: workspace, tools,
          connectorStore: createDbConnectorStore(encryptionKey), connectorInstanceStore: instances, connectorGrantStore: createConnectorGrantStore(),
          settingsStore: createDbMcpSettingsStore(), connectorSourceRuntimeFactory: includeFactory ? sourceRuntimeFactory : undefined, keepDynamicToolsDirect: true,
          contextScope: { effectiveCompartments: actor.execution.security.access.compartments!, effectiveProjectIds: actor.execution.security.access.projectIds!, access: actor.execution.security.access },
          actorIdentity: { channel: 'test', userId }, executionContext: includeExecution ? actor.execution : undefined, scopeAccumulator })
        return { ...actor, scopeAccumulator, tools, result, context: { ...executionToolContext(actor.execution, { appId: 'Fixture' }), scopeAccumulator } }
      }
      const protectedRead = await inject(first)
      expect(protectedRead.tools.has('readRecord')).toBe(true); expect(protectedRead.tools.has('updateRecord')).toBe(false)
      const discovered = source.counters.discoveries
      const protectedSecond = await inject(first)
      expect(protectedSecond.tools.has('readRecord')).toBe(true)
      expect(source.counters.discoveries).toBeGreaterThan(discovered)
      const protectedOutput = await protectedRead.tools.get('mcp_call')!.execute({ server: `connector:${instance.id}`, tool: 'readRecord', args: { id: 'order-1', fields: ['description','cost'] } }, protectedRead.context)
      expect(JSON.stringify(protectedOutput)).toContain('37.25'); expect(protectedRead.scopeAccumulator.evidence.sources).toHaveLength(1)
      configureConnectorSourceRuntimeFactory(sourceRuntimeFactory)
      try {
        const shared = await inject(first, true, 'native_session', false)
        expect(shared.tools.has('readRecord')).toBe(true)
        expect(JSON.stringify(await shared.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['cost'] }, shared.context))).toContain('37.25')
        const incomplete = await inject(first, false, 'native_session', false)
        expect(incomplete.tools.has('readRecord')).toBe(false)
        expect(incomplete.result.unavailable.join(' ')).toContain('Protected source access is unavailable')
        configureConnectorSourceRuntimeFactory(undefined)
        await expect(async () => shared.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['cost'] }, shared.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      } finally { configureConnectorSourceRuntimeFactory(undefined) }
      const narrowRuntime = await inject(second)
      const narrowSearch = await narrowRuntime.tools.get('mcp_search')!.execute({ query: 'readRecord', limit: 1 }, narrowRuntime.context)
      expect(String(narrowSearch.data)).not.toContain('cost')
      expect(await narrowRuntime.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['cost'] }, narrowRuntime.context)).toMatchObject({ isError: true })
      expect(narrowRuntime.scopeAccumulator.evidence.sources ?? []).toEqual([])
      expect(JSON.stringify(await narrowRuntime.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['description'] }, narrowRuntime.context))).not.toContain('37.25')
      expect(narrowRuntime.scopeAccumulator.evidence.sources).toHaveLength(1)
      await expect(async () => protectedRead.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['cost'] }, protectedSecond.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      const verifiedChannel = await inject(first, true, 'verified_channel')
      expect(JSON.stringify(await verifiedChannel.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['cost'] }, verifiedChannel.context))).toContain('37.25')
      expect(verifiedAuthentication).toBe('verified_channel')
      for (const authenticationKind of [null, 'credential_attribution'] as const) {
        const unverified = await client(first, authenticationKind)
        const beforeDiscovery = source.counters.discoveries
        await expect(sourceRuntimeFactory({ workspaceId: workspace, instanceId: instance.id, execution: unverified.execution,
          accumulator: new ContextScopeAccumulator(), headers: { Authorization: `Bearer ${transportToken}` } })).rejects.toMatchObject({ code: 'source_unavailable' })
        expect(source.counters.discoveries).toBe(beforeDiscovery)
      }
      const missingExecution = await inject(first, false), missingMapping = await inject(unmapped)
      expect(missingExecution.tools.has('readRecord')).toBe(false); expect(missingMapping.tools.has('readRecord')).toBe(false)
      expect(missingExecution.result.unavailable.join(' ')).toContain('Protected source access is unavailable')
      expect(missingMapping.result.unavailable.join(' ')).toContain('Protected source access is unavailable')
      await expect(createConnectorSourceRuntimeFactory({ issuer, instances })({ workspaceId: workspace, instanceId: instance.id, execution: one.execution,
        accumulator: new ContextScopeAccumulator(), headers: { Authorization: `Bearer ${transportToken}` } })).rejects.toMatchObject({ code: 'source_unavailable' })
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
      const retained = (userId: string, resource = evidence.resources[0].resource): SourceAuthorizationRequest => ({ version: SOURCE_PROTOCOL_VERSION, operationId: randomUUID(),
        items: [{ itemId: randomUUID(), resource, fields: ['description'], action: 'context', retentionMode: 'governed' }],
        recipients: [{ recipientId: randomUUID(), subject: { kind: 'human', id: userId, executingAssistantId: assistant } }] })
      await one.access.authorize(retained(first)); await two.access.authorize(retained(second))
      await sourcePool.query("DELETE FROM grants WHERE account_id=$1 AND record_id='order-1'", [first])
      await expect(one.access.authorize(retained(first))).rejects.toMatchObject({ code: 'source_access_denied' })
      await expect(retainedCoordinator.prepare(one.execution, retainedSources!, 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
      await expect(retainedCoordinator.prepare(one.execution, [retainedDerivative!], 'context')).rejects.toMatchObject({ code: 'source_access_denied' })
      await expect(validateAudienceScopeEvidence({ sources: [retainedDerivative!] }, one.execution.security.ceiling)).rejects.toMatchObject({ diagnostic: 'source_held' })
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
      await pool.query("UPDATE connector_source_profiles SET status='pending' WHERE id=$1", [sourceProfile])
      await expect(async () => protectedRead.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['description'] }, protectedRead.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      const pendingProfile = await inject(first)
      expect(pendingProfile.tools.has('readRecord')).toBe(false)
      expect(pendingProfile.result.unavailable.join(' ')).toContain('Protected source access is unavailable')
      await pool.query("UPDATE connector_source_profiles SET status='qualified' WHERE id=$1", [sourceProfile])
      await expect(async () => protectedRead.tools.get('readRecord')!.execute({ id: 'order-1', fields: ['description'] }, protectedRead.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      const currentProfile = await inject(first)
      expect(currentProfile.tools.has('readRecord')).toBe(true)
      const currentObservation = trustedSourceEnvelope(await two.access.readMcp('readRecord', { id: 'order-1', fields: ['description'] }))!
      await two.access.authorize(retained(second, currentObservation.resources[0].resource))
      await sourcePool.query("UPDATE records SET withdrawn=true WHERE id='order-1'")
      await expect(two.access.authorize(retained(second, currentObservation.resources[0].resource))).rejects.toMatchObject({ code: 'source_access_denied' })
      expect(await one.access.reconcile({ version: SOURCE_PROTOCOL_VERSION, idempotencyKey: args.idempotencyKey })).toMatchObject({ state: 'uncertain' })
      expect(source.counters.effects).toBe(1)
      await source.close(); source = undefined
      await expect(two.access.authorize(retained(second))).rejects.toMatchObject({ code: 'source_unavailable' })
      const evidenceCount = (await pool.query('SELECT count(*)::int AS count FROM external_source_observations WHERE workspace_id=$1', [workspace])).rows[0].count
      expect(await instances.delete(owner, instance.id)).toBe(true)
      expect(await instances.getSystem(instance.id)).toBeNull()
      expect((await pool.query('SELECT connector_instance_id,original_connector_instance_id,status FROM connector_source_profiles WHERE id=$1', [sourceProfile])).rows[0])
        .toEqual({ connector_instance_id: null, original_connector_instance_id: instance.id, status: 'revoked' })
      expect((await pool.query('SELECT count(*)::int AS count FROM external_source_observations WHERE workspace_id=$1', [workspace])).rows[0].count).toBe(evidenceCount)
      expect((await readCurrentScopeSources(pool, workspace, retainedSources!)).map(row => row.state)).toEqual(['held'])
      await expect(sourceRuntimeFactory({ workspaceId: workspace, instanceId: instance.id, execution: one.execution,
        accumulator: new ContextScopeAccumulator(), headers: {} })).rejects.toMatchObject({ code: 'source_unavailable' })
      await expect(pool.query('UPDATE connector_source_profiles SET original_connector_instance_id=$2 WHERE id=$1', [sourceProfile,randomUUID()])).rejects.toMatchObject({ code: '22023' })
    } finally {
      await source?.close(); await sourcePool.end()
      await pool.query(`DROP SCHEMA ${sourceSchema} CASCADE`); await pool.query(`DROP ROLE ${sourceRole}`)
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]); await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner,first,second,foreign,unmapped]])
    }
    return 'discovery effects and source lifecycle'
  }
})
