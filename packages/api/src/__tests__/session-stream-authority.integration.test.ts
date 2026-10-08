import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getAppPool, getPool, query } from '../db/client.js'
import { sessionRoutes } from '../routes/sessions.js'
import type { SessionEvent } from '../session-event-port.js'

const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe('[COMP:api/session-stream-authority] live HTTP revocation with real department facts', () => {
  it.each(['workspace', 'owner'])('closes an open %s session after revocation without sending the next payload, then refuses reconnect', async visibility => {
    const workspace = randomUUID(), owner = randomUUID(), viewer = randomUUID(), department = randomUUID(), assistant = randomUUID(), session = randomUUID()
    for (const user of [owner, viewer]) await query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [user])
    await query("INSERT INTO workspaces(id,name,purpose,owner_user_id) VALUES($1,'Fictional stream fixture','test',$2)", [workspace, owner])
    for (const [user, role] of [[owner, 'owner'], [viewer, 'member']]) await query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'confidential')", [workspace, user, role])
    await query("INSERT INTO assistants(id,name,workspace_id,kind,clearance,owner_user_id) VALUES($1,'Fixture assistant',$2,'primary','internal',$3)", [assistant, workspace, owner])
    await query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Research',$3,'team',$1::text,$4)", [department, workspace, owner, `team:${department}`])
    await query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [workspace, department, viewer])
    await query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspace])
    await query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id,visibility,effective_clearance,context_compartments,context_group_id,status) VALUES($1::uuid,$2,$3,$4,'web',$1::text,$7,'internal',$5,$6,'running')", [session, workspace, assistant, visibility === 'owner' ? viewer : owner, [`team:${department}`], department, visibility])

    let listener: ((event: SessionEvent) => void) | undefined
    const unsubscribe = vi.fn()
    const app = express()
    app.use((req, _res, next) => { Object.assign(req, { userId: viewer }); next() })
    app.use('/sessions', sessionRoutes({ subscribeSessionEvents: ({ cb }) => { listener = cb; return unsubscribe } }))
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/sessions/${session}/stream`
    const controller = new AbortController()
    try {
      const response = await fetch(url, { signal: controller.signal })
      expect(response.status).toBe(200)
      let received = ''
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      const consume = (async () => { for (;;) { const next = await reader.read(); if (next.done) return; received += decoder.decode(next.value) } })()
      await vi.waitFor(() => expect(listener).toBeTypeOf('function'))
      listener!({ kind: 'turn_stream', sessionId: session, payload: { text: 'Admitted fixture text', activity: null } })
      await vi.waitFor(() => expect(received).toContain('Admitted fixture text'))
      await query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [workspace, viewer])
      listener!({ kind: 'turn_stream', sessionId: session, payload: { text: 'Revoked fixture text', activity: null } })
      await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
      await consume
      expect(received).not.toContain('Revoked fixture text')
      expect((await fetch(url)).status).toBe(403)
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
