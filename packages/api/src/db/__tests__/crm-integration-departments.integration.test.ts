import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { authenticateBrainRequest, getAuthenticatedCrmCredentialParent, getAuthenticatedBrainCredentialCurrent } from '../../brain-mcp/auth.js'
import { makeBrainContextResolver } from '../../brain-mcp/tools.js'
import { createDbOAuthAuthorizationStore } from '../oauth-authorization-store.js'
import { hashSecret } from '../api-key-store.js'
import { createDbBrainKeyStore } from '../brain-keys-store.js'
import { createCrmCredentialTools, crmOperationsSha256, type CrmCredentialParent, type ToolContext } from '@use-brian/core'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createCrmIntegrationRecordReadStore } from '../crm-integration-records.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { applyRLSGucs } from '../client.js'
import { mintBridgeToken } from '../../home-apps/tokens.js'
import { getHomeApp } from '../home-apps-store.js'
import { assertCrmCredentialParent, configureCrmHomeAppParentSigner } from '../../crm-operations/integration-department-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const keys = createCrmIntegrationStore(owner, app)
const input = { label: 'Fictional integration', expiresAt: '2099-01-01T00:00:00Z', grants: [
  { operation: 'crm.records.read' as const, selectors: {} }, { operation: 'crm.records.write' as const, selectors: {} },
] }

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), custodian = randomUUID()
  const cedar = randomUUID(), harbor = randomUUID()
  await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [userId, custodian])
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional credential workspace',$2)", [workspaceId, custodian])
  await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'admin')", [workspaceId, custodian, userId])
  for (const [id, name] of [[cedar, 'Cedar'], [harbor, 'Harbor']]) {
    await owner.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
      VALUES($1::uuid,$2,'team',$3,$4,$5,$1::text)`, [id, workspaceId, name, custodian, `team:${id}`])
    await owner.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,$3,'team',$4)", [workspaceId, `team:${id}`, name, id])
  }
  const edge = async (id: string, clearance = 'confidential') => {
    await owner.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
      VALUES($1,$2,'user',$3,$4,'store')`, [workspaceId, id, userId, clearance])
  }
  const record = async (departments: string[], sensitivity = 'confidential', privateUser: string | null = null) => {
    const id = randomUUID()
    await owner.query(`INSERT INTO entities(id,workspace_id,kind,display_name,source,created_by_user_id,sensitivity,compartments,user_id)
      VALUES($1,$2,'person','Fictional contact','manual',$3,$4,$5,$6)`, [id, workspaceId, custodian, sensitivity, departments.map(d => `team:${d}`), privateUser])
    return id
  }
  return { workspaceId, userId, custodian, cedar, harbor, edge, record }
}

describe('[COMP:api/crm-integration-auth] Departmental credential issuance and record access', () => {
  afterAll(async () => { await Promise.all([owner.end(), app.end()]) })

  it('caps Home-app children to the viewer token and renews live app grants', async () => {
    const f = await fixture(), appId=randomUUID(), assistantId=randomUUID()
    await owner.query(`INSERT INTO workspace_home_apps(id,workspace_id,kind,name,status,granted_scopes,max_clearance)
      VALUES($1,$2,'assistant','Fictional app','active','{"data":"read_write"}','internal')`,[appId,f.workspaceId])
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional issuer','primary','internal')",[assistantId,f.workspaceId])
    for (const capability of ['configure','crm','home_app:crm:write']) await owner.query(
      'INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3)',[assistantId,capability,f.userId])
    const signer='fictional-home-signer'
    configureCrmHomeAppParentSigner(signer)
    const token=mintBridgeToken({appId,workspaceId:f.workspaceId,userId:f.userId,scope:'read_write',maxClearance:'internal',secret:signer})
    const auth=await authenticateBrainRequest({headers:{authorization:`Bearer ${token}`}} as Request,
      {brainKeyStore:{} as never,homeApps:{secret:signer,getApp:getHomeApp}})
    const parent=getAuthenticatedCrmCredentialParent(auth!)!
    if (parent.kind !== 'home_app') throw new Error('Expected Home-app parent')
    const context=await makeBrainContextResolver(f.workspaceId,appId,'internal','programmatic',
      {kind:'home_app',credentialId:appId,userId:f.userId},getAuthenticatedBrainCredentialCurrent(auth!),parent)()
    if ('error' in context) throw new Error(context.error)
    const authority=await captureAuthoringAuthoritySystem({workspaceId:f.workspaceId,userId:f.userId,assistantId})
    const native=createCrmCredentialTools({
      preview:(input,authority,source)=>keys.bindingOptions(f.workspaceId,f.userId,input,authority,source),
      list:(input,authority,source)=>keys.listForMember(f.workspaceId,f.userId,input,authority,source),
      create:(input,authority,source)=>keys.create(f.workspaceId,f.userId,input,authority,source),
      revoke:async(input,authority,source)=>({revoked:await keys.revoke(f.workspaceId,f.userId,input.credentialId,authority,source)}),
    })
    const result=await native.createCrmCredential.execute({...input,requestId:randomUUID(),departmentBinding:{departmentIds:[],cap:'internal'}},context)
    expect(result.isError).not.toBe(true)
    const child=result.data as Awaited<ReturnType<typeof keys.create>>
    expect(JSON.stringify(child.departmentBinding)).not.toContain(token)
    expect(JSON.stringify(child.departmentBinding)).not.toContain(signer)
    expect(child.expiresAt.toISOString()).toBe(parent.expiresAt)
    expect(child.departmentBinding?.parent).toEqual(parent)
    expect(await keys.authenticate(child.oneTimeSecret)).not.toBeNull()
    await owner.query(`UPDATE workspace_home_apps SET granted_scopes='{"data":"read"}' WHERE id=$1`,[appId])
    expect(await keys.authenticate(child.oneTimeSecret)).toBeNull()
    await owner.query(`UPDATE workspace_home_apps SET granted_scopes='{"data":"read_write"}' WHERE id=$1`,[appId])
    expect(await keys.authenticate(child.oneTimeSecret)).not.toBeNull()
    await expect(keys.create(f.workspaceId,f.userId,{...input,requestId:randomUUID()},authority,
      {...parent,expiresAt:new Date(0).toISOString()})).rejects.toMatchObject({code:'not_authorized'})
    configureCrmHomeAppParentSigner('fictional-replacement-signer')
    expect(await keys.authenticate(child.oneTimeSecret)).toBeNull()
    expect(await native.listCrmCredentials.execute({},context)).toMatchObject({isError:true})
    configureCrmHomeAppParentSigner(null)
    expect(await keys.authenticate(child.oneTimeSecret)).toBeNull()
    configureCrmHomeAppParentSigner(signer)
    expect(await keys.authenticate(child.oneTimeSecret)).not.toBeNull()
    await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    expect(await keys.authenticate(child.oneTimeSecret)).toBeNull()
  })

  it('renews exact Brain-key parent evidence through app-role admission', async () => {
    const f = await fixture(), id = randomUUID(), verifier = await hashSecret('fictional-parent')
    await owner.query(`INSERT INTO brain_keys(id,workspace_id,name,key_prefix,key_hash,scope,status,max_clearance)
      VALUES($1,$2,'Fictional parent','sk_brain_fixture',$3,'read_write','active','internal')`, [id,f.workspaceId,verifier])
    const parent: CrmCredentialParent = { version:1, kind:'brain_key', credentialId:id, workspaceId:f.workspaceId,
      userId:f.custodian, tokenFingerprint:crmOperationsSha256(verifier), maxClearance:'internal',
      contextGroupId:null,contextProjectId:null,configurationSessionId:null,admittedCompartments:null,admittedProjectIds:null }
    const connection = await app.connect()
    try {
      await assertCrmCredentialParent(connection,parent,f.workspaceId,f.custodian)
      for (const patch of [{ userId:f.userId }, { tokenFingerprint:'0'.repeat(64) },
        { maxClearance:'public' as const }, { admittedCompartments:[] }, { admittedProjectIds:[] },
        { configurationSessionId:randomUUID() }, { contextGroupId:f.cedar }]) {
        await expect(assertCrmCredentialParent(connection,{...parent,...patch},f.workspaceId,f.custodian))
          .rejects.toMatchObject({code:'not_authorized'})
      }
      const assistantId = randomUUID()
      await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional delegated issuer','primary','internal')", [assistantId,f.workspaceId])
      for (const capability of ['configure','crm','home_app:crm:write']) await owner.query(
        'INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3)',[assistantId,capability,f.custodian])
      const auth = await authenticateBrainRequest({headers:{authorization:`Bearer sk_brain_${id}_fictional-parent`}} as Request,
        {brainKeyStore:createDbBrainKeyStore()})
      expect(auth).not.toBeNull()
      const captured = getAuthenticatedCrmCredentialParent(auth!)!
      expect(captured).toEqual(parent)
      const context = await makeBrainContextResolver(f.workspaceId,id,'internal','programmatic',
        {kind:'brain_key',credentialId:id},getAuthenticatedBrainCredentialCurrent(auth!),captured)()
      if ('error' in context) throw new Error(context.error)
      const native = createCrmCredentialTools({
        preview:(input,authority,source)=>keys.bindingOptions(f.workspaceId,f.custodian,input,authority,source),
        list:(input,authority,source)=>keys.listForMember(f.workspaceId,f.custodian,input,authority,source),
        create:(input,authority,source)=>keys.create(f.workspaceId,f.custodian,input,authority,source),
        revoke:async(input,authority,source)=>({revoked:await keys.revoke(f.workspaceId,f.custodian,input.credentialId,authority,source)}),
      })
      const result = await native.createCrmCredential.execute({...input,requestId:randomUUID(),
        departmentBinding:{departmentIds:[],cap:'internal'}},context)
      expect(result.isError).not.toBe(true)
      const child = result.data as Awaited<ReturnType<typeof keys.create>>
      expect(child.departmentBinding?.parent).toEqual(parent)
      expect(JSON.stringify(child.departmentBinding)).not.toContain(verifier)
      expect(await keys.authenticate(child.oneTimeSecret)).not.toBeNull()
      const concurrent=await Promise.all([keys.authenticate(child.oneTimeSecret),keys.authenticate(child.oneTimeSecret)])
      expect(concurrent.every(value=>value!==null)).toBe(true)
      const usage=async()=>(await owner.query('SELECT last_used_at FROM crm_integration_credentials WHERE id=$1',[child.id])).rows[0].last_used_at
      const lastSuccessfulUse=await usage()
      await owner.query("UPDATE brain_keys SET status='revoked' WHERE id=$1",[id])
      await expect(assertCrmCredentialParent(connection,parent,f.workspaceId,f.custodian)).rejects.toMatchObject({code:'not_authorized'})
      expect(await keys.authenticate(child.oneTimeSecret)).toBeNull()
      expect(await usage()).toEqual(lastSuccessfulUse)
      expect(await native.listCrmCredentials.execute({},context)).toMatchObject({isError:true})
    } finally { connection.release() }
  })

  it('retains exact authenticated OAuth parent expiry and revocation in a delegated CRM key', async () => {
    const f = await fixture(), assistantId = randomUUID(), clientId = randomUUID(), authorizationId = randomUUID()
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional delegated issuer','primary','internal')", [assistantId, f.workspaceId])
    for (const capability of ['configure', 'crm', 'home_app:crm:write']) await owner.query('INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [assistantId, capability, f.userId])
    const tokenSecret = 'fictional-parent-secret', tokenHash = await hashSecret(tokenSecret)
    await owner.query("INSERT INTO oauth_clients(client_id,redirect_uris) VALUES($1,ARRAY['https://client.example/callback'])", [clientId])
    await owner.query("INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,access_token_hash,access_token_expires_at) VALUES($1,$2,$3,$4,'read_write',$5,now()+interval '10 minutes')", [authorizationId, clientId, f.userId, f.workspaceId, tokenHash])
    const bearer = `oat_${authorizationId}_${tokenSecret}`
    const auth = await authenticateBrainRequest({ headers: { authorization: `Bearer ${bearer}` } } as Request,
      { brainKeyStore: {} as never, authorizationStore: createDbOAuthAuthorizationStore() })
    const parent = getAuthenticatedCrmCredentialParent(auth!)!
    if (parent.kind !== 'oauth_token') throw new Error('Expected OAuth parent')
    expect(getAuthenticatedCrmCredentialParent({ ...auth! })).toBeUndefined()
    const admission = await app.connect(), mutation = await owner.connect()
    try {
      await admission.query('BEGIN')
      await assertCrmCredentialParent(admission, parent, f.workspaceId, f.userId)
      for (const [sql, id] of [
        ['SELECT id FROM oauth_authorizations WHERE id=$1 FOR UPDATE NOWAIT', authorizationId],
        ['SELECT client_id FROM oauth_clients WHERE client_id=$1 FOR UPDATE NOWAIT', clientId],
      ]) {
        await mutation.query('BEGIN')
        await expect(mutation.query(sql, [id])).rejects.toMatchObject({ code: '55P03' })
        await mutation.query('ROLLBACK')
      }
      await admission.query('COMMIT')
      await mutation.query('BEGIN')
      await mutation.query('SELECT id FROM oauth_authorizations WHERE id=$1 FOR UPDATE NOWAIT', [authorizationId])
      await mutation.query('SELECT client_id FROM oauth_clients WHERE client_id=$1 FOR UPDATE NOWAIT', [clientId])
      await mutation.query('ROLLBACK')
    } finally {
      await admission.query('ROLLBACK')
      await mutation.query('ROLLBACK')
      admission.release(); mutation.release()
    }
    const authority = await captureAuthoringAuthoritySystem({ workspaceId: f.workspaceId, userId: f.userId, assistantId })
    const request = { ...input, requestId: randomUUID(), departmentBinding: { departmentIds: [] as string[], cap: 'internal' as const } }
    const native = createCrmCredentialTools({
      preview: (input, authoring, source) => keys.bindingOptions(f.workspaceId, f.userId, input, authoring, source),
      list: (input, authoring, source) => keys.listForMember(f.workspaceId, f.userId, input, authoring, source),
      create: (input, authoring, source) => keys.create(f.workspaceId, f.userId, input, authoring, source),
      revoke: async (input, authoring, source) => ({ revoked: await keys.revoke(f.workspaceId, f.userId, input.credentialId, authoring, source) }),
    })
    const context = await makeBrainContextResolver(f.workspaceId, authorizationId, 'internal', 'programmatic',
      { kind: 'oauth_token', credentialId: authorizationId, userId: f.userId }, getAuthenticatedBrainCredentialCurrent(auth!), parent)()
    if ('error' in context) throw new Error(context.error)
    const result = await native.createCrmCredential.execute(request, context)
    expect(result.isError).not.toBe(true)
    const key = result.data as Awaited<ReturnType<typeof keys.create>>
    expect((await native.listCrmCredentials.execute({}, context)).isError).not.toBe(true)
    expect(key.expiresAt.toISOString()).toBe(parent.expiresAt)
    expect(key.departmentBinding?.parent).toEqual(parent)
    expect(JSON.stringify(key.departmentBinding)).not.toContain(tokenHash)
    expect(JSON.stringify(key.departmentBinding)).not.toContain(bearer)
    const record = await f.record([], 'internal')
    const records = createCrmIntegrationRecordReadStore((await keys.authenticate(key.oneTimeSecret))!, owner)
    expect(await records.get(record)).toMatchObject({ id: record })
    await owner.query("UPDATE oauth_authorizations SET access_token_hash='rotated-verifier' WHERE id=$1", [authorizationId])
    expect(await keys.authenticate(key.oneTimeSecret)).toBeNull()
    expect(await native.listCrmCredentials.execute({}, context)).toMatchObject({ isError: true })
    await expect(records.get(record)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(keys.create(f.workspaceId, f.userId, { ...request, requestId: randomUUID() }, authority, parent)).rejects.toMatchObject({ code: 'not_authorized' })
    await owner.query('UPDATE oauth_authorizations SET access_token_hash=$2 WHERE id=$1', [authorizationId, tokenHash])
    await owner.query("UPDATE oauth_authorizations SET scope='read' WHERE id=$1", [authorizationId])
    expect(await keys.authenticate(key.oneTimeSecret)).toBeNull()
    await owner.query("UPDATE oauth_authorizations SET scope='read_write',access_token_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [authorizationId])
    expect(await keys.authenticate(key.oneTimeSecret)).toBeNull()
    await owner.query('UPDATE oauth_authorizations SET access_token_expires_at=$2 WHERE id=$1', [authorizationId, parent.expiresAt])
    expect(await keys.authenticate(key.oneTimeSecret)).not.toBeNull()

    await owner.query('UPDATE oauth_clients SET revoked_at=clock_timestamp() WHERE client_id=$1', [clientId])
    expect(await keys.authenticate(key.oneTimeSecret)).toBeNull()
    expect((await owner.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ id: key.id }])
  })

  it('executes actual native credential creation rotation and revocation through the canonical store', async () => {
    const f = await fixture(), assistantId = randomUUID()
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional native issuer','primary','internal')", [assistantId, f.workspaceId])
    for (const capability of ['configure', 'crm', 'home_app:crm:write']) await owner.query('INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [assistantId, capability, f.userId])
    const native = createCrmCredentialTools({
      preview: (input, authority) => keys.bindingOptions(f.workspaceId, f.userId, input, authority),
      list: (input, authority) => keys.listForMember(f.workspaceId, f.userId, input, authority),
      create: (input, authority) => keys.create(f.workspaceId, f.userId, input, authority),
      revoke: async (input, authority) => ({ revoked: await keys.revoke(f.workspaceId, f.userId, input.credentialId, authority) }),
    })
    const context: ToolContext = { workspaceId: f.workspaceId, userId: f.userId, assistantId, assistantKind: 'primary',
      appId: assistantId, sessionId: randomUUID(), channelType: 'web', channelId: 'fixture', abortSignal: new AbortController().signal,
      clearance: 'internal', compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null,
      activeCapabilities: new Set(['configure', 'crm', 'home_app:crm:write']) }
    const request = { ...input, requestId: randomUUID(), departmentBinding: { departmentIds: [], cap: 'internal' } }
    for (const capability of ['configure', 'crm', 'home_app:crm:write']) {
      await owner.query('UPDATE assistant_capabilities SET revoked_at=clock_timestamp() WHERE assistant_id=$1 AND capability=$2', [assistantId, capability])
      expect(await native.createCrmCredential.execute(request, context)).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
      expect(await native.listCrmCredentials.execute({}, context)).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
      expect((await owner.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
      expect((await owner.query("SELECT id FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='crm.integration_credential_created'", [f.workspaceId])).rows).toEqual([])
      await owner.query('UPDATE assistant_capabilities SET revoked_at=NULL WHERE assistant_id=$1 AND capability=$2', [assistantId, capability])
    }
    const created = await native.createCrmCredential.execute(request, context)
    expect(created.isError).not.toBe(true)
    const first = created.data as { id: string; oneTimeSecret: string }
    expect(await keys.authenticate(first.oneTimeSecret)).not.toBeNull()
    expect(await native.createCrmCredential.execute(request, context)).toMatchObject({ isError: true,
      data: { error: 'conflict', reason: 'credential_already_issued', credentialId: first.id } })
    const rotated = await native.createCrmCredential.execute({ ...request, requestId: randomUUID(), revokeCredentialId: first.id }, context)
    expect(rotated.isError).not.toBe(true)
    const second = rotated.data as { id: string; oneTimeSecret: string }
    expect(await keys.authenticate(first.oneTimeSecret)).toBeNull()
    expect(await keys.authenticate(second.oneTimeSecret)).not.toBeNull()
    expect(await native.revokeCrmCredential.execute({ credentialId: second.id }, context)).toMatchObject({ data: { revoked: true } })
    expect(await keys.authenticate(second.oneTimeSecret)).toBeNull()
    await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    expect(await native.listCrmCredentials.execute({}, context)).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
  })

  it('pins delegated credential issuance to the executing assistant and complete authoring ceiling', async () => {
    const f = await fixture(), assistantId = randomUUID()
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional credential author','primary','internal')", [assistantId, f.workspaceId])
    for (const capability of ['configure', 'crm', 'home_app:crm:write']) await owner.query('INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [assistantId, capability, f.userId])
    const authoring = await captureAuthoringAuthoritySystem({ workspaceId: f.workspaceId, userId: f.userId, assistantId })
    authoring.ceiling.projectIds = []
    const preview = await keys.bindingOptions(f.workspaceId, f.userId, { cap: 'internal' }, authoring)
    expect(preview.choices.some(choice => choice.binding.length === 0)).toBe(true)
    await expect(keys.create(f.workspaceId, f.userId, input, authoring)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(keys.create(f.workspaceId, f.userId, { ...input, requestId: randomUUID(),
      departmentBinding: { assistantId: randomUUID(), departmentIds: [], cap: 'internal' } }, authoring)).rejects.toMatchObject({ code: 'not_authorized' })
    const requestId = randomUUID()
    const key = await keys.create(f.workspaceId, f.userId, { ...input, requestId, departmentBinding: { departmentIds: [], cap: 'internal' } }, authoring)
    expect(key.departmentBinding).toMatchObject({ assistantId, execution: { projectIds: [] } })
    expect((await keys.authenticate(key.oneTimeSecret))?.executionLimits?.projectIds).toEqual([])
    await expect(keys.create(f.workspaceId, f.userId, { ...input, requestId, departmentBinding: { departmentIds: [], cap: 'internal' } }, authoring))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'credential_already_issued', credentialId: key.id } })
    expect((await keys.listForMember(f.workspaceId, f.userId, {}, authoring)).credentials.map(row => row.id)).toEqual([key.id])
    expect(await keys.revoke(f.workspaceId, f.userId, key.id, authoring)).toBe(true)
    expect(await keys.authenticate(key.oneTimeSecret)).toBeNull()
    await owner.query("UPDATE assistants SET clearance='public' WHERE id=$1", [assistantId])
    await expect(keys.create(f.workspaceId, f.userId, { ...input, requestId: randomUUID() }, authoring)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(keys.listForMember(f.workspaceId, f.userId, {}, authoring)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(keys.revoke(f.workspaceId, f.userId, key.id, authoring)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await owner.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([{ id: key.id }])
  })

  it('previews only admitted binding choices and renews destination authority without issuing keys', async () => {
    const f = await fixture()
    await f.edge(f.cedar)
    await owner.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, f.cedar])
    const preview = await keys.bindingOptions(f.workspaceId, f.userId, { cap: 'confidential' })
    expect(preview.mode).toBe('department-v2')
    expect(preview.validForMs).toBe(30000)
    expect(preview.choices.map(row => row.binding)).toEqual([[f.cedar], [], [f.cedar]])
    expect(JSON.stringify(preview)).not.toContain(f.harbor)
    expect(preview.choices[0].departments).toEqual([{ id: f.cedar, name: 'Cedar' }])
    await owner.query("UPDATE department_edges SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    const renewed = await keys.bindingOptions(f.workspaceId, f.userId, { cap: 'confidential' })
    expect(renewed.choices.map(row => row.binding)).toEqual([[]])
    expect(JSON.stringify(renewed)).not.toContain('Cedar')
    await expect(keys.create(f.workspaceId, f.userId, { ...input, departmentBinding: preview.choices[0].selection })).rejects.toThrow()
    expect((await owner.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    expect((await owner.query("SELECT id FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='crm.integration_credential_created'", [f.workspaceId])).rows).toEqual([])
    await owner.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [f.workspaceId])
    expect(await keys.bindingOptions(f.workspaceId, f.userId)).toEqual({ mode: 'legacy', choices: [], assistants: [], validForMs: 30000 })
  })

  it('does not let a workspace admin issue a department binding without an edge', async () => {
    const f = await fixture()
    await expect(keys.create(f.workspaceId, f.userId, { ...input,
      departmentBinding: { departmentIds: [f.cedar], cap: 'confidential' },
    })).rejects.toThrow()
    expect((await owner.query('SELECT id FROM crm_integration_credentials WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
    expect((await owner.query("SELECT id FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='crm.integration_credential_created'", [f.workspaceId])).rows).toEqual([])
  })

  it('filters rows and profile mutation by the exact binding and renews after edge loss', async () => {
    const f = await fixture()
    await f.edge(f.cedar); await f.edge(f.harbor)
    const visible = await f.record([f.cedar]), hidden = await f.record([f.harbor])
    const conjunction = await f.record([f.cedar, f.harbor]), privateId = await f.record([f.cedar], 'internal', f.custodian)
    const general = await f.record([], 'public')
    const key = await keys.create(f.workspaceId, f.userId, { ...input,
      departmentBinding: { departmentIds: [f.cedar], cap: 'confidential' } })
    const principal = (await keys.authenticate(key.oneTimeSecret))!
    expect(principal.departmentRead?.binding).toEqual([f.cedar])
    const records = createCrmIntegrationRecordReadStore(principal, owner)
    expect((await records.list({})).records.map(r => r.id).sort()).toEqual([visible, general].sort())
    for (const id of [hidden, conjunction, privateId]) {
      expect(await records.get(id)).toBeNull()
      expect(await records.getMemberProfile(id)).toBeNull()
      expect(await records.updateMemberProfile(id, { expectedUpdatedAt: new Date().toISOString(), name: 'Denied change' })).toBeNull()
    }
    const profile = (await records.getMemberProfile(visible))!
    expect(await records.updateMemberProfile(visible, { expectedUpdatedAt: profile.updatedAt, name: 'Permitted change' }))
      .toMatchObject({ name: 'Permitted change' })
    expect((await owner.query('SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
    await owner.query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3', [f.workspaceId, f.cedar, f.userId])
    expect(await records.get(visible)).toBeNull()
    expect((await records.list({})).records.map(r => r.id)).toEqual([general])
    await keys.revoke(f.workspaceId, f.userId, key.id)
    await expect(records.get(general)).rejects.toMatchObject({ code: 'credential_revoked' })
  })

  it('filters frozen Project and assistant axes before pages and profile mutation', async () => {
    const f = await fixture(), project = randomUUID(), otherProject = randomUUID(), assistant = randomUUID(), otherAssistant = randomUUID()
    await f.edge(f.cedar)
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind) VALUES($1,$3,'Fictional first assistant','standard'),($2,$3,'Fictional second assistant','standard')", [assistant, otherAssistant, f.workspaceId])
    for (const [id, name] of [[project, 'Fictional allowed project'], [otherProject, 'Fictional other project']]) await owner.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)', [id, f.workspaceId, name, f.userId])
    const visible = await f.record([f.cedar]), hiddenProject = await f.record([f.cedar]), hiddenAssistant = await f.record([f.cedar])
    const privateId = await f.record([f.cedar], 'internal', f.userId)
    for (const [id, p, a] of [[visible, project, assistant], [hiddenProject, otherProject, assistant], [hiddenAssistant, project, otherAssistant]]) {
      await owner.query('UPDATE entities SET project_ids=$2::uuid[],assistant_id=$3 WHERE id=$1', [id, [p], a])
    }
    const frozen = { workspaceId: f.workspaceId, userId: f.userId, clearance: 'public' as const, compartments: null,
      mutationCompartments: null, projectIds: [project], visibilityAssistantIds: [assistant], sharedAudience: true }
    const key = await runWithAgentAccess(frozen, () => keys.create(f.workspaceId, f.userId, { ...input,
      departmentBinding: { departmentIds: [f.cedar], cap: 'confidential' } }))
    expect(key.departmentBinding?.execution).toMatchObject({ projectIds: [project], visibilityAssistantIds: [assistant], sharedAudience: true })
    await expect(runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'internal', compartments: null },
      () => keys.create(f.workspaceId, f.userId, input))).rejects.toMatchObject({ code: 'not_authorized' })
    const principal = (await keys.authenticate(key.oneTimeSecret))!
    expect(principal.executionLimits).toEqual(key.departmentBinding?.execution)
    // A direct consumer cannot omit the saved ceiling by constructing a minimal principal.
    const { executionLimits: _limits, ...minimal } = principal
    const records = createCrmIntegrationRecordReadStore(minimal, owner)
    await runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'public', compartments: null,
      projectIds: [project], visibilityAssistantIds: [assistant], sharedAudience: true, departmentRead: principal.departmentRead }, async () => {
      const page = await records.list({ limit: 1 })
      expect(page.records.map(row => row.id)).toEqual([visible]); expect(page.nextCursor).toBeNull()
      for (const id of [hiddenProject, hiddenAssistant, privateId]) {
        expect(await records.get(id)).toBeNull()
        expect(await records.getMemberProfile(id)).toBeNull()
        expect(await records.updateMemberProfile(id, { expectedUpdatedAt: new Date().toISOString(), name: 'Denied edit' })).toBeNull()
      }
      expect((await owner.query('SELECT id FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
      const before = (await records.getMemberProfile(visible))!
      expect(await records.updateMemberProfile(visible, { expectedUpdatedAt: before.updatedAt, name: 'Allowed edit' })).toMatchObject({ name: 'Allowed edit' })
    })
    const readOnlyKey = await runWithAgentAccess({ ...frozen, mutationCompartments: [] }, () => keys.create(f.workspaceId, f.userId, { ...input,
      departmentBinding: { departmentIds: [f.cedar], cap: 'confidential' } }))
    const readOnlyRecords = createCrmIntegrationRecordReadStore((await keys.authenticate(readOnlyKey.oneTimeSecret))!, owner)
    const readable = (await readOnlyRecords.getMemberProfile(visible))!
    expect(readable).not.toBeNull()
    expect(await readOnlyRecords.updateMemberProfile(visible, { expectedUpdatedAt: readable.updatedAt, name: 'Mutation ceiling bypass' })).toBeNull()
    const narrower = createCrmIntegrationRecordReadStore({ ...principal, executionLimits: { ...principal.executionLimits!, projectIds: [] } }, owner)
    expect((await narrower.list({})).records).toEqual([])
    expect((await records.list({})).records.map(row => row.id)).toEqual([visible])
    expect(await records.get(hiddenProject)).toBeNull()
    expect(await records.get(hiddenAssistant)).toBeNull()
    expect((await owner.query('SELECT display_name FROM entities WHERE id=ANY($1::uuid[])', [[hiddenProject, hiddenAssistant, privateId]])).rows.every(row => row.display_name === 'Fictional contact')).toBe(true)
  })

  it('captures credential audit floors without blocking revocation after department loss', async () => {
    const f = await fixture(); await f.edge(f.cedar)
    const key = await keys.create(f.workspaceId, f.userId, { ...input, departmentBinding: { departmentIds: [f.cedar], cap: 'confidential' } })
    const principal = (await keys.authenticate(key.oneTimeSecret))!
    const readAudit = () => runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId,
      clearance: 'public', compartments: null, mutationCompartments: null, projectIds: null,
      visibilityAssistantIds: null, departmentRead: principal.departmentRead }, async () => {
      const client = await app.connect()
      try {
        await client.query('BEGIN'); await applyRLSGucs(client, f.userId)
        const rows = (await client.query('SELECT id,scope_origin,scope_sources FROM workspace_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows
        await client.query('COMMIT'); return rows
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    })
    const before = await readAudit(); expect(before).toHaveLength(1)
    expect(before[0].scope_origin).toBe('captured')
    expect(before[0].scope_sources).toMatchObject([{ resourceKind: 'crm_integration_credential', resourceId: key.id,
      sensitivity: 'confidential', compartments: [`team:${f.cedar}`] }])
    await owner.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3', [f.workspaceId, f.userId, f.cedar])
    expect(await readAudit()).toEqual([])
    expect(await keys.revoke(f.workspaceId, f.userId, key.id)).toBe(true)
    expect(await readAudit()).toEqual([])
    const receipts = (await owner.query('SELECT scope_sources FROM workspace_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows
    expect(receipts).toHaveLength(2)
    expect(receipts.every(row => JSON.stringify(row.scope_sources) === JSON.stringify(before[0].scope_sources))).toBe(true)
  })

  it('preserves General-only selection and credential caps after later issuer grants', async () => {
    const f = await fixture()
    await f.edge(f.cedar)
    await owner.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, f.cedar])
    const secret = await f.record([f.cedar]), general = await f.record([], 'public')
    const key = await keys.create(f.workspaceId, f.userId, { ...input, departmentBinding: { departmentIds: [], cap: 'public' } })
    expect(key.departmentBinding).toMatchObject({ binding: [], cap: 'public' })
    const records = createCrmIntegrationRecordReadStore((await keys.authenticate(key.oneTimeSecret))!, owner)
    expect(await records.get(secret)).toBeNull()
    expect(await records.get(general)).toMatchObject({ id: general })
    const capped = await keys.create(f.workspaceId, f.userId, { ...input, departmentBinding: { departmentIds: [f.cedar], cap: 'internal' } })
    expect(await createCrmIntegrationRecordReadStore((await keys.authenticate(capped.oneTimeSecret))!, owner).get(secret)).toBeNull()
  })

  it('pins home admission and refuses missing historical evidence until atomic rotation', async () => {
    const f = await fixture()
    await f.edge(f.cedar)
    await owner.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, f.cedar])
    const home = await keys.create(f.workspaceId, f.userId, input)
    expect(home.departmentBinding?.binding).toEqual([f.cedar])
    await expect(owner.query("UPDATE crm_integration_credentials SET department_binding=NULL WHERE id=$1", [home.id])).rejects.toThrow(/immutable/)
    // A legacy issuance genuinely has no v2 evidence; the cutover must not invent it.
    await owner.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [f.workspaceId])
    const legacy = await keys.create(f.workspaceId, f.userId, input)
    await owner.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    expect(await keys.authenticate(legacy.oneTimeSecret)).toBeNull()
    const replacement = await keys.create(f.workspaceId, f.userId, { ...input, revokeCredentialId: legacy.id,
      departmentBinding: { departmentIds: [f.cedar], cap: 'internal' } })
    expect(await keys.authenticate(replacement.oneTimeSecret)).not.toBeNull()
    expect(await keys.authenticate(legacy.oneTimeSecret)).toBeNull()
  })

  it('renews bound assistant Project limits and never broadens the saved issuance ceiling', async () => {
    const f = await fixture(), assistantId = randomUUID(), project = randomUUID(), otherProject = randomUUID()
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,project_scope_mode) VALUES($1,$2,'Fictional scoped assistant','primary','internal','all')", [assistantId, f.workspaceId])
    for (const [id, name] of [[project, 'Fictional selected project'], [otherProject, 'Fictional excluded project']]) {
      await owner.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)', [id, f.workspaceId, name, f.userId])
    }
    const visible = await f.record([], 'internal'), hidden = await f.record([], 'internal')
    await owner.query('UPDATE entities SET project_ids=ARRAY[$2::uuid] WHERE id=$1', [visible, project])
    await owner.query('UPDATE entities SET project_ids=ARRAY[$2::uuid] WHERE id=$1', [hidden, otherProject])
    const requested = { ...input, departmentBinding: { departmentIds: [] as string[], assistantId, cap: 'internal' as const } }
    const broad = await keys.create(f.workspaceId, f.userId, requested)
    expect(broad.departmentBinding?.execution?.projectIds).toBeNull()
    const records = createCrmIntegrationRecordReadStore((await keys.authenticate(broad.oneTimeSecret))!, owner)
    expect(await records.get(hidden)).toMatchObject({ id: hidden })
    await owner.query('INSERT INTO assistant_project_grants(assistant_id,project_id,added_by_user_id) VALUES($1,$2,$3)', [assistantId, project, f.userId])
    await owner.query("UPDATE assistants SET project_scope_mode='assigned' WHERE id=$1", [assistantId])
    expect((await keys.authenticate(broad.oneTimeSecret))?.executionLimits?.projectIds).toEqual([project])
    expect(await records.get(visible)).toMatchObject({ id: visible })
    expect(await records.get(hidden)).toBeNull()
    const narrow = await keys.create(f.workspaceId, f.userId, requested)
    expect(narrow.departmentBinding?.execution?.projectIds).toEqual([project])
    await owner.query("UPDATE assistants SET project_scope_mode='all' WHERE id=$1", [assistantId])
    expect((await keys.authenticate(narrow.oneTimeSecret))?.executionLimits?.projectIds).toEqual([project])
    expect(await createCrmIntegrationRecordReadStore((await keys.authenticate(narrow.oneTimeSecret))!, owner).get(hidden)).toBeNull()
    expect(await records.get(hidden)).toMatchObject({ id: hidden })
  })

  it('requires the acting assistant edge independently and retains its issuance ceiling', async () => {
    const f = await fixture(), assistantId = randomUUID()
    await f.edge(f.cedar)
    await owner.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional assistant','primary','confidential')", [assistantId, f.workspaceId])
    // Provisioning may create edges; this negative fixture explicitly has none.
    await owner.query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2', [f.workspaceId, assistantId])
    const requested = { ...input, departmentBinding: { departmentIds: [f.cedar], assistantId, cap: 'confidential' as const } }
    expect((await keys.bindingOptions(f.workspaceId, f.userId, { assistantId, cap: 'confidential' })).choices.every(row => !row.binding.includes(f.cedar))).toBe(true)
    await expect(keys.create(f.workspaceId, f.userId, requested)).rejects.toThrow()
    await owner.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin)
      VALUES($1,$2,'assistant',$3,'internal','store')`, [f.workspaceId, f.cedar, assistantId])
    await expect(keys.create(f.workspaceId, f.userId, requested)).rejects.toThrow()
    expect((await keys.bindingOptions(f.workspaceId, f.userId, { assistantId, cap: 'confidential' })).choices.every(row => !row.binding.includes(f.cedar))).toBe(true)
    const assistantPreview = await keys.bindingOptions(f.workspaceId, f.userId, { assistantId, cap: 'internal' })
    expect(assistantPreview.assistants).toContainEqual({ id: assistantId, name: 'Fictional assistant' })
    expect(assistantPreview.choices.some(row => row.binding.includes(f.cedar))).toBe(true)
    await expect(keys.bindingOptions(f.workspaceId, f.userId, { assistantId: randomUUID() })).rejects.toMatchObject({ code: 'not_authorized' })
    const key = await keys.create(f.workspaceId, f.userId, { ...requested,
      departmentBinding: { ...requested.departmentBinding, cap: 'internal' } })
    const internal = await f.record([f.cedar], 'internal'), confidential = await f.record([f.cedar])
    const records = createCrmIntegrationRecordReadStore((await keys.authenticate(key.oneTimeSecret))!, owner)
    expect(await records.get(internal)).toMatchObject({ id: internal })
    expect(await records.get(confidential)).toBeNull()
    await owner.query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND assistant_id=$2", [f.workspaceId, assistantId])
    expect(await records.get(confidential)).toBeNull()
    await owner.query('DELETE FROM department_edges WHERE workspace_id=$1 AND assistant_id=$2', [f.workspaceId, assistantId])
    expect(await records.get(internal)).toBeNull()
    await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    expect(await keys.authenticate(key.oneTimeSecret)).toBeNull()
    await expect(records.list({})).rejects.toMatchObject({ code: 'not_authorized' })
  })
})
