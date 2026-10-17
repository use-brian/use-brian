import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { executionToolContext, type Tool } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { createConnectorInstanceStore } from '../../db/connector-instance-store.js'
import { createDbConnectorStore } from '../../db/connector-store.js'
import { createConnectorGrantStore } from '../../db/connector-grant-store.js'
import { createDbMcpSettingsStore } from '../../db/mcp-settings-store.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { injectMcpTools } from '../../mcp/inject.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/connector-context] real common injector native admission', () => {
  const pool = getPool()
  afterAll(async () => { await getAppPool().end(); await pool.end() })
  it.each(['owned','exposed'] as const)('shares one actual actor floor across %s discovery/cache, gateway/direct aliases and result return', async lane => {
    const workspace = randomUUID(), owner = randomUUID(), member = randomUUID(), other = randomUUID(), assistant = randomUUID(), departments = [randomUUID(),randomUUID()]
    const encryptionKey = randomBytes(32), instances = createConnectorInstanceStore(encryptionKey)
    const grants = createConnectorGrantStore()
    let requests = 0, reads = 0, afterRead: (() => Promise<void>) | undefined
    const source = express(); source.use(express.json())
    source.all('/mcp', async (req, res) => {
      if (req.headers.authorization !== 'Bearer fictional-native-source-transport') { res.sendStatus(401); return }
      requests++
      const server = new McpServer({ name: 'Native admission fixture', version: '1' })
      server.registerTool('readFixture', { inputSchema: {} }, async () => {
        reads++
        expect(req.headers['x-usebrian-user-id']).toBe(member)
        expect(req.headers['x-usebrian-assistant-id']).toBe(assistant)
        await afterRead?.()
        return { content: [{ type: 'text', text: 'Fixture Department payload' }] }
      })
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.once('close', () => { void transport.close(); void server.close() })
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
    })
    const listener = source.listen(0, '127.0.0.1'); await once(listener, 'listening')
    const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`
    for (const id of [owner,member,other]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)", [id])
    try {
      await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Common connector fixture',$2,true)", [workspace,owner])
      for (const [id,role] of [[owner,'owner'],[member,'member'],[other,'member']]) await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspace,id,role])
      await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Shared connector assistant',$2,$3,'standard','confidential',NULL)", [assistant,workspace,owner])
      for (const department of departments) {
        await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fixture Department',$3,'team',$1::text,$4)", [department,workspace,owner,`team:${department}`])
        await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fixture Department',$3,'team',$4)", [workspace,`team:${department}`,owner,department])
        await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING", [workspace,department,assistant])
      }
      for (const [id,department] of [[member,departments[0]],[other,departments[1]]]) await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [workspace,department,id])
      const common = { provider: randomUUID(), label: 'Native admission fixture', createdBy: owner,
        url, custom: true, connected: true, config: { sendActorIdentity: true },
        credentials: { type: 'bearer' as const, token: 'fictional-native-source-transport' } }
      const instance = lane === 'owned'
        ? await instances.createWorkspaceInstance({ ...common, workspaceId: workspace, compartments: [`team:${departments[0]}`], projectIds: [] })
        : await instances.createUserInstance({ ...common, userId: owner })
      let exposure = lane === 'exposed' ? await grants.create({ actingUserId: owner, connectorInstanceId: instance.id,
        targetType: 'workspace', targetId: workspace, compartments: [`team:${departments[0]}`], projectIds: [] }) : null
      const inject = async (actor: string) => {
        const abort = new AbortController()
        const resolved = await resolveExecutionContextSystem({ userId: actor, workspaceId: workspace, assistant: (await findAssistantById(assistant))!, memberMode: 'member',
          identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: actor } }, ownership: { kind: 'workspace', workspaceId: workspace },
          lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelType: 'test', channelId: 'fixture', abortSignal: abort.signal } })
        const tools = new Map<string, Tool>()
        const result = await injectMcpTools({ userId: owner, assistantId: assistant, assistantTeamId: workspace, tools,
          connectorStore: createDbConnectorStore(encryptionKey), connectorInstanceStore: instances, connectorGrantStore: grants, settingsStore: createDbMcpSettingsStore(),
          contextScope: resolved.turnScope, actorIdentity: { channel: 'test', userId: actor }, keepDynamicToolsDirect: true })
        return { tools, result, abort, context: executionToolContext(resolved.executionContext, { appId: 'Fixture' }) }
      }
      const denied = await inject(other)
      expect(denied.tools.has('readFixture')).toBe(false); expect(requests).toBe(0)
      expect(JSON.stringify(denied.result.unavailable)).not.toContain('Native admission fixture')
      const allowed = await inject(member)
      expect(allowed.tools.has('readFixture')).toBe(true)
      const discovered = requests, cached = await inject(member)
      expect(cached.tools.has('readFixture')).toBe(true); expect(requests).toBe(discovered)
      expect(JSON.stringify(await allowed.tools.get('readFixture')!.execute({}, allowed.context))).toContain('Fixture Department payload')
      expect(reads).toBe(1)
      const revoke = () => pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3', [workspace,member,departments[0]])
      const restore = () => pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [workspace,departments[0],member])
      await revoke()
      await expect(allowed.tools.get('mcp_call')!.execute({ server: 'Native admission fixture', tool: 'readFixture', args: {} }, allowed.context))
        .rejects.toMatchObject({ reason: 'authority_changed' })
      expect(reads).toBe(1)
      await restore()
      await expect(allowed.tools.get('readFixture')!.execute({}, allowed.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(reads).toBe(1)
      const fresh = await inject(member)
      if (exposure) {
        expect(await grants.revoke(owner, exposure.id)).toBe(true)
        await expect(fresh.tools.get('readFixture')!.execute({}, fresh.context)).rejects.toMatchObject({ reason: 'authority_changed' })
        expect(reads).toBe(1)
        exposure = await grants.create({ actingUserId: owner, connectorInstanceId: instance.id, targetType: 'workspace', targetId: workspace,
          compartments: [`team:${departments[0]}`], projectIds: [] })
        await expect(fresh.tools.get('readFixture')!.execute({}, fresh.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      }
      const connected = await inject(member)
      await instances.setConnectedSystem(instance.id, false)
      await expect(connected.tools.get('readFixture')!.execute({}, connected.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(reads).toBe(1)
      await instances.setConnectedSystem(instance.id, true)
      await expect(connected.tools.get('readFixture')!.execute({}, connected.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      const credentialBound = await inject(member)
      await instances.updateCredentialsSystem(instance.id, { type: 'bearer', token: 'fictional-replaced-transport' })
      await expect(credentialBound.tools.get('readFixture')!.execute({}, credentialBound.context)).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(reads).toBe(1)
      await instances.updateCredentialsSystem(instance.id, { type: 'bearer', token: 'fictional-native-source-transport' })
      const current = await inject(member)
      afterRead = async () => { await revoke() }
      await expect(current.tools.get('readFixture')!.execute({}, current.context)).rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true })
      expect(reads).toBe(2)
      afterRead = undefined
      await restore()
      const cancelled = await inject(member)
      afterRead = async () => { cancelled.abort.abort() }
      await expect(cancelled.tools.get('readFixture')!.execute({}, cancelled.context)).rejects.toMatchObject({ reason: 'authority_changed', operationMayHaveExecuted: true })
      expect(reads).toBe(3)
    } finally {
      await new Promise<void>(resolve => listener.close(() => resolve()))
      await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace])
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner,member,other]])
    }
  })
})
