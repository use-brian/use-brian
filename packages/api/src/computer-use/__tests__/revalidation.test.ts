import { expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import type { NativeCommand, NativeGrant } from '@use-brian/computer-control/protocol.js'
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../../db/client.js'
import { NativeComputerService } from '../service.js'
import { nativeComputerRoutes } from '../../routes/native-computer.js'

it('HTTP execution checks use one real SQL authorization snapshot, exact auth session and live command', async () => {
  const db = new PGlite()
  let finish: (() => void) | undefined
  let dispatch: Promise<unknown> | undefined
  const id = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  try {
    // Minimal relational fixture for the existing authorization predicates;
    // the native session/audit schema is the production migration.
    await db.exec(`
      CREATE TABLE users(id uuid PRIMARY KEY, auth_version int);
      CREATE TABLE workspaces(id uuid PRIMARY KEY);
      CREATE TABLE assistants(id uuid PRIMARY KEY, workspace_id uuid);
      CREATE TABLE sessions(id uuid PRIMARY KEY, user_id uuid, assistant_id uuid);
      CREATE TABLE tasks(id uuid PRIMARY KEY, workspace_id uuid, user_id uuid, assistant_id uuid,
        valid_to timestamptz, retracted_at timestamptz, scope_held boolean);
      CREATE TABLE auth_sessions(id uuid PRIMARY KEY, user_id uuid, revoked_at timestamptz, expires_at timestamptz, auth_version int);
      CREATE TABLE workspace_members(workspace_id uuid, user_id uuid);
      CREATE TABLE assistant_capabilities(assistant_id uuid, capability text, revoked_at timestamptz);
      CREATE TABLE mcp_tool_settings(assistant_id uuid, user_id uuid, server_name text, tool_name text, policy text);
      CREATE TABLE workspace_tool_policy(workspace_id uuid, server_name text, tool_name text, policy text);
      INSERT INTO users VALUES ('${id}',1),('${other}',1);
      INSERT INTO workspaces VALUES ('${id}'),('${other}');
      INSERT INTO assistants VALUES ('${id}','${id}'),('${other}','${other}');
      INSERT INTO sessions VALUES ('${id}','${id}','${id}'),('${other}','${other}','${other}');
      INSERT INTO tasks VALUES ('${id}','${id}','${id}','${id}',NULL,NULL,false),('${other}','${other}','${other}','${other}',NULL,NULL,false);
      INSERT INTO auth_sessions VALUES ('${id}','${id}',NULL,now()+interval '1 hour',1),('${other}','${id}',NULL,now()+interval '1 hour',1);
      INSERT INTO workspace_members VALUES ('${id}','${id}');
      INSERT INTO assistant_capabilities VALUES ('${id}','native_computer',NULL);
      INSERT INTO mcp_tool_settings VALUES ('${id}','${id}','native_computer','nativeComputerTask','ask');
      INSERT INTO workspace_tool_policy VALUES ('${id}','native_computer','nativeComputerTask','allow');
    `)
    await db.exec(await readFile(new URL('../../../migrations/620_native_computer_sessions.sql', import.meta.url), 'utf8'))
    vi.mocked(query).mockImplementation(((sql: string, params: unknown[]) => db.query(sql, params)) as typeof query)
    const service = new NativeComputerService({ relayUrl: 'http://relay', relaySecret: 'secret', jwtSecret: 'secret', deploymentId: 'deployment' })
    const relay = vi.spyOn(service, 'relay').mockResolvedValue({})
    const scope = { userId: id, workspaceId: id, assistantId: id, conversationId: id, taskId: id }
    const verifier = 'v'.repeat(43)
    const created = await service.create({ ...scope, deviceId: 'device', authSessionId: id, challenge: createHash('sha256').update(verifier).digest('base64url') })
    const grant: NativeGrant = { protocol: 'native-computer-v1', identity: created.identity, grantId: 'grant', epoch: 1,
      expiresAt: Date.now()+60000, targets: [{ appId: 'fixture', processId: 1, processInstanceId: 'p', windowId: 'w', windowInstanceId: 'wi' }], allowControl: true, allowCapture: false, requester: 'local', goal: 'fixture' }
    await service.exchange(created.identity.sessionId, id, verifier, grant)
    let wire!: NativeCommand
    relay.mockImplementation(async (path, _method, body) => {
      if (path !== '/command') return {}
      wire = body as NativeCommand
      return new Promise(resolve => { finish = () => resolve({ commandId: wire.commandId, outcome: 'not_executed', code: 'denied' }) })
    })
    dispatch = service.dispatch(scope, { protocol: grant.protocol, identity: grant.identity, grantId: grant.grantId, epoch: grant.epoch,
      commandId: 'pending', deadlineAt: Date.now()+30000, action: { kind: 'observe', target: grant.targets[0] } })
    await vi.waitFor(() => expect(wire).toBeDefined())
    const check = { commandId: wire.commandId, grantId: wire.grantId, epoch: wire.epoch, deadlineAt: wire.deadlineAt, digest: createHash('sha256').update(JSON.stringify(wire)).digest('hex') }
    let currentAuth = id
    const app = express(); app.use(express.json())
    app.use((req, _res, next) => { req.userId = id; req.authSessionId = currentAuth; next() })
    app.use(nativeComputerRoutes(service))
    const path = `/sessions/${grant.identity.sessionId}/revalidate`
    const validate = async (status: number) => {
      vi.mocked(query).mockClear()
      const response = await request(app).post(path).send(check)
      expect(response.status).toBe(status)
      expect(query).toHaveBeenCalledTimes(1)
      expect(vi.mocked(query).mock.calls[0][0]).toMatch(/^SELECT 1 FROM native_computer_sessions n/)
      expect(vi.mocked(query).mock.calls[0][1]).toEqual([grant.identity.sessionId,id,currentAuth,id,id,id,id,'grant',1,'deployment','device'])
    }
    await validate(200); await validate(200) // Repeated exact checks while in flight are permitted.
    currentAuth = other; await validate(403); currentAuth = id // Same user, different live auth session.
    const mutations = [
      "UPDATE native_computer_sessions SET revoked_at=now()",
      "UPDATE native_computer_sessions SET expires_at=now()-interval '1 second'",
      "UPDATE native_computer_sessions SET state='active'",
      "UPDATE native_computer_sessions SET epoch=2",
      "UPDATE native_computer_sessions SET grant_id='other'",
      "UPDATE native_computer_sessions SET deployment_id='other'",
      "UPDATE native_computer_sessions SET device_id='other'",
      ...['user_id','auth_session_id','workspace_id','assistant_id','conversation_id','task_id'].map(column => `UPDATE native_computer_sessions SET ${column}='${other}'`),
      `UPDATE auth_sessions SET revoked_at=now() WHERE id='${id}'`,
      `UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id='${id}'`,
      `UPDATE auth_sessions SET auth_version=2 WHERE id='${id}'`,
      `UPDATE auth_sessions SET user_id='${other}' WHERE id='${id}'`,
      `UPDATE users SET auth_version=2 WHERE id='${id}'`,
      'DELETE FROM workspace_members',
      'DELETE FROM assistant_capabilities',
      'UPDATE assistant_capabilities SET revoked_at=now()',
      "UPDATE assistant_capabilities SET capability='other'",
      `UPDATE assistants SET workspace_id='${other}' WHERE id='${id}'`,
      `UPDATE sessions SET user_id='${other}' WHERE id='${id}'`,
      `UPDATE sessions SET assistant_id='${other}' WHERE id='${id}'`,
      ...['workspace_id','user_id','assistant_id'].map(column => `UPDATE tasks SET ${column}='${other}' WHERE id='${id}'`),
      `UPDATE tasks SET valid_to=now() WHERE id='${id}'`,
      `UPDATE tasks SET retracted_at=now() WHERE id='${id}'`,
      `UPDATE tasks SET scope_held=true WHERE id='${id}'`,
      "UPDATE mcp_tool_settings SET policy='block'",
      "UPDATE workspace_tool_policy SET policy='block'",
    ]
    for (const mutation of mutations) {
      await db.exec('BEGIN')
      try { await db.exec(mutation); await validate(403) }
      finally { await db.exec('ROLLBACK') }
    }
    // Preserve existing allow/ask semantics and exact policy scope.
    await db.exec("UPDATE mcp_tool_settings SET policy='block',tool_name='other'; UPDATE workspace_tool_policy SET policy='ask'")
    await validate(200)
    for (const patch of [{ commandId: 'other' }, { grantId: 'other' }, { epoch: 2 }, { digest: '0'.repeat(64) }, { deadlineAt: check.deadlineAt+1 }]) {
      vi.mocked(query).mockClear()
      await request(app).post(path).send({ ...check, ...patch }).expect(403)
      expect(query).not.toHaveBeenCalled()
    }
    finish!(); await dispatch
    vi.mocked(query).mockClear()
    await request(app).post(path).send(check).expect(403)
    expect(query).not.toHaveBeenCalled() // Durable state alone never grants authority.
  } finally {
    finish?.(); await dispatch
    vi.restoreAllMocks(); vi.mocked(query).mockReset()
    await db.close()
  }
}, 60000)
