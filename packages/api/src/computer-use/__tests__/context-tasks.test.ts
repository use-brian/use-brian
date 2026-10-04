import type { TaskStore } from '@use-brian/core'
import { expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
vi.mock('../../db/client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn() }))
import { query, queryWithRLS } from '../../db/client.js'
import { NativeComputerService } from '../service.js'
import { nativeComputerRoutes } from '../../routes/native-computer.js'

it('context tasks reads and explicit creation intersect exact native ownership and normal task access', async () => {
  const db = new PGlite()
  const id = '00000000-0000-4000-8000-000000000001'
  const other = '00000000-0000-4000-8000-000000000002'
  try {
    await db.exec(`
      CREATE TABLE assistants(id uuid, workspace_id uuid, clearance text DEFAULT 'confidential');
      CREATE TABLE sessions(id uuid, user_id uuid, assistant_id uuid);
      CREATE TABLE workspace_members(workspace_id uuid, user_id uuid, role text DEFAULT 'member',
        clearance text DEFAULT 'confidential', compartments text[], team_scope_mode text DEFAULT 'assigned');
      CREATE TABLE workspace_groups(id uuid, workspace_id uuid, kind text, compartment_key text, read_all boolean, status text);
      CREATE TABLE workspace_group_members(group_id uuid, user_id uuid);
      CREATE TABLE workspace_group_compartment_grants(group_id uuid, compartment_key text);
      CREATE TABLE workspace_access_grants(workspace_id uuid, target_team_id uuid, beneficiary_kind text,
        beneficiary_id uuid, revoked_at timestamptz, starts_at timestamptz, expires_at timestamptz);
      CREATE TABLE assistant_capabilities(assistant_id uuid, capability text, revoked_at timestamptz);
      CREATE TABLE tasks(id uuid, title text, workspace_id uuid, user_id uuid, assistant_id uuid,
        valid_to timestamptz, retracted_at timestamptz, scope_held boolean, sensitivity text DEFAULT 'internal', compartments text[] DEFAULT '{}');
      INSERT INTO assistants(id,workspace_id) VALUES ('${id}','${id}');
      INSERT INTO sessions VALUES ('${id}','${id}','${id}');
      INSERT INTO workspace_members(workspace_id,user_id) VALUES ('${id}','${id}');
      INSERT INTO assistant_capabilities VALUES ('${id}','native_computer',NULL);
      INSERT INTO tasks(id,title,workspace_id,user_id,assistant_id,valid_to,retracted_at,scope_held) VALUES ('${id}',repeat('x',300),'${id}','${id}','${id}',NULL,NULL,false);
    `)
    // Minimal relational columns above match the production schema. Load the
    // actual clearance/Team/read-grant functions and current member RLS floor,
    // rather than replacing the security controls with permissive SQL stubs.
    const installFunction = async (file: string, name: string) => {
      const source = await readFile(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8')
      const start = source.indexOf(`CREATE FUNCTION ${name}(`)
      expect(start).toBeGreaterThanOrEqual(0)
      const end = source.indexOf('$$;', source.indexOf('$$', start) + 2) + 3
      await db.exec(source.slice(start, end))
    }
    await installFunction('000_open_schema_v1.sql', 'public.sensitivity_rank')
    await installFunction('473_context_principal_bindings.sql', 'public.effective_member_team_compartments')
    await installFunction('566_department_read_requests.sql', 'effective_member_read_compartments')
    await installFunction('615_member_operation_floor_per_statement.sql', 'member_operation_grants')
    await installFunction('615_member_operation_floor_per_statement.sql', 'member_operation_row_allows')
    await db.exec(`
      CREATE ROLE native_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO native_reader;
      ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
      CREATE POLICY task_fixture_read ON tasks FOR SELECT USING (true);
      CREATE POLICY member_operation_read ON tasks AS RESTRICTIVE FOR SELECT USING
        (member_operation_row_allows((SELECT member_operation_grants(false)), workspace_id, sensitivity, compartments));
    `)
    vi.mocked(queryWithRLS).mockImplementation((async (userId: string, sql: string, params: unknown[]) => {
      await db.query("SELECT set_config('app.current_user_id',$1,false)", [userId])
      await db.exec('SET ROLE native_reader')
      try { return await db.query(sql, params) }
      finally { await db.exec('RESET ROLE') }
    }) as typeof queryWithRLS)
    vi.mocked(query).mockImplementation(((sql: string, params: unknown[]) => db.query(sql, params)) as typeof query)
    const service = new NativeComputerService({ relayUrl: 'http://relay', relaySecret: 'fixture', jwtSecret: 'fixture', deploymentId: 'fixture' })
    const relay = vi.spyOn(service, 'relay')
    let userId: string | undefined = id
    let authSessionId: string | undefined = id
    const create = vi.fn<TaskStore['create']>().mockResolvedValue({ id, title: 'Created task' } as Awaited<ReturnType<TaskStore['create']>>)
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.userId = userId; req.authSessionId = authSessionId; next() })
    app.use(nativeComputerRoutes(service, undefined, undefined, { create }))
    const context = { workspaceId: id, assistantId: id, conversationId: id }
    const get = (params = context) => request(app).get('/context-tasks').query(params)
    const post = (body: unknown = { ...context, title: '  Created task  ' }) => request(app).post('/context-tasks').send(body as object)
    expect((await post()).status).toBe(201)
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      userId: id, workspaceId: id, title: 'Created task', status: 'todo',
      visibility: { userId: id, assistantId: id }, sensitivity: 'internal',
      source: 'user', sourceSessionId: id, writtenBy: 'user',
      access: expect.objectContaining({ userId: id, workspaceId: id, assistantId: id, clearance: 'confidential' }),
    }))
    for (const field of ['workspaceId', 'assistantId', 'conversationId']) {
      create.mockClear()
      expect((await post({ ...context, title: 'Task', [field]: other })).status).toBe(403)
      expect(create).not.toHaveBeenCalled()
    }
    for (const title of ['', '   ', 'x'.repeat(513)]) expect((await post({ ...context, title })).status).toBe(400)
    for (const field of ['userId', 'visibility', 'deviceId', 'grant', 'sensitivity']) {
      expect((await post({ ...context, title: 'Task', [field]: other })).status).toBe(400)
    }
    create.mockRejectedValueOnce(new Error('private database detail'))
    const failed = await post()
    expect(failed.status).toBe(503)
    expect(failed.body).toEqual({ error: 'Native task creation unavailable' })
    create.mockRejectedValueOnce(Object.assign(new Error('private scope detail'), { code: 'scope_operation_denied' }))
    expect((await post()).status).toBe(403)
    const response = await get()
    expect(response.status).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body).toEqual({ tasks: [{ id, title: 'x'.repeat(256) }] })
    for (const field of ['workspaceId', 'assistantId', 'conversationId']) {
      expect((await get({ ...context, [field]: other })).body).toEqual({ tasks: [] })
    }
    // Each row mutation must deny both discovery and the existing dispatch scope.
    const mutations = [
      ['tasks', 'user_id', `'${other}'`], ['tasks', 'assistant_id', `'${other}'`],
      ['tasks', 'workspace_id', `'${other}'`], ['tasks', 'valid_to', 'now()'],
      ['tasks', 'retracted_at', 'now()'], ['tasks', 'scope_held', 'true'],
      ['sessions', 'user_id', `'${other}'`], ['sessions', 'assistant_id', `'${other}'`],
      ['assistants', 'workspace_id', `'${other}'`], ['workspace_members', 'user_id', `'${other}'`],
      ['assistant_capabilities', 'revoked_at', 'now()'], ['assistant_capabilities', 'capability', "'other'"],
    ]
    for (const [table, column, value] of mutations) {
      await db.exec(`BEGIN; UPDATE ${table} SET ${column}=${value}`)
      expect((await get()).body, `${table}.${column}`).toEqual({ tasks: [] })
      expect(await service.authorized({ ...context, userId: id, taskId: id })).toBe(false)
      if (table !== 'tasks') {
        create.mockClear()
        expect((await post()).status, `${table}.${column} create`).toBe(403)
        expect(create).not.toHaveBeenCalled()
      }
      await db.exec('ROLLBACK')
    }
    // Native ownership is deliberately unchanged by read-scope reductions.
    // The real workspace viewpoint, universal predicate and app-role RLS must
    // suppress titles even though the native dispatch predicate still matches.
    const readScopeDenials = [
      "UPDATE workspace_members SET clearance='public'",
      "UPDATE assistants SET clearance='public'",
      "UPDATE tasks SET compartments=ARRAY['team:private']",
    ]
    for (const sql of readScopeDenials) {
      await db.exec(`BEGIN; ${sql}`)
      expect(await service.authorized({ ...context, userId: id, taskId: id })).toBe(true)
      expect((await get()).body, sql).toEqual({ tasks: [] })
      if (!sql.startsWith('UPDATE tasks')) {
        create.mockClear()
        expect((await post()).status).toBe(403)
        expect(create).not.toHaveBeenCalled()
      }
      await db.exec('ROLLBACK')
    }
    // The app-role floor also catches a reduction after viewpoint resolution;
    // a captured access predicate alone must not authorize the title query.
    const readWithRLS = vi.mocked(queryWithRLS).getMockImplementation()!
    await db.exec('BEGIN')
    vi.mocked(queryWithRLS).mockImplementationOnce((async (...args: Parameters<typeof queryWithRLS>) => {
      await db.exec("UPDATE workspace_members SET clearance='public'")
      return readWithRLS(...args)
    }) as typeof queryWithRLS)
    expect((await get()).body).toEqual({ tasks: [] })
    await db.exec('ROLLBACK')
    await db.exec(`BEGIN;
      INSERT INTO workspace_groups VALUES ('${other}','${id}','team','team:private',false,'active');
      INSERT INTO workspace_group_members VALUES ('${other}','${id}');
      UPDATE tasks SET compartments=ARRAY['team:private'];
    `)
    expect((await get()).body.tasks).toHaveLength(1)
    await db.exec('DELETE FROM workspace_group_members')
    expect((await get()).body).toEqual({ tasks: [] })
    await db.exec(`INSERT INTO workspace_access_grants VALUES ('${id}','${other}','member','${id}',NULL,now(),NULL)`)
    expect((await get()).body.tasks).toHaveLength(1)
    await db.exec('UPDATE workspace_access_grants SET revoked_at=now()')
    expect((await get()).body).toEqual({ tasks: [] })
    await db.exec('ROLLBACK')
    expect(queryWithRLS).toHaveBeenCalledWith(id, expect.stringContaining('sensitivity_rank(t.sensitivity)'), expect.any(Array))
    userId = other; expect((await get()).body).toEqual({ tasks: [] }); expect((await post()).status).toBe(403)
    userId = undefined; expect((await get()).status).toBe(403); expect((await post()).status).toBe(403)
    userId = id; authSessionId = undefined; expect((await get()).status).toBe(403); expect((await post()).status).toBe(403)
    authSessionId = id
    expect((await get({ ...context, assistantId: 'bad' })).status).toBe(400)
    expect((await request(app).get('/context-tasks').query({ ...context, userId: other })).status).toBe(400)
    await db.exec(`INSERT INTO tasks(id,title,workspace_id,user_id,assistant_id,valid_to,retracted_at,scope_held) SELECT md5(i::text)::uuid,'task','${id}','${id}','${id}',NULL,NULL,false FROM generate_series(1,600) i`)
    expect((await get()).body.tasks).toHaveLength(500)
    expect(relay).not.toHaveBeenCalled()
    expect(vi.mocked(query).mock.calls.some(([sql]) => String(sql).includes('left(t.title'))).toBe(false)
    expect(vi.mocked(query).mock.calls.every(([sql]) => String(sql).startsWith('SELECT'))).toBe(true)
  } finally { await db.close() }
}, 60000)
