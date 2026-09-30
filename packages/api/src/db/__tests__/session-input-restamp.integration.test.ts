import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../client.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

// The migration's statements, run inside a rolled-back transaction so its
// table-wide UPDATEs cannot touch rows other suites in this fixture wrote.
const restamp = readFileSync(new URL('../../../migrations/612_session_input_audience_restamp.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*$/m, '').replace(/^\s*COMMIT;\s*$/m, '')

describe('[COMP:api/session-context] input rows stamped under the superseded rules', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it('drops the answering assistant from input and makes shared-audience input user-less', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const userId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
      await client.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
      await client.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Restamp fixture',$2)", [workspaceId, userId])
      await client.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','internal')", [workspaceId, userId])
      await client.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Fixture','standard','internal')", [assistantId, workspaceId, userId])
      const session = async (visibility: string, mode: string | null) => {
        const id = randomUUID()
        await client.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,visibility,mode,effective_clearance) VALUES($1,$2,$3,'web',$7,$4,$5,$6,'internal')",
          [id, assistantId, userId, workspaceId, visibility, mode, `fixture-${id}`])
        return id
      }
      const message = async (sessionId: string, role: string) => (await client.query<{ id: string }>(
        `INSERT INTO session_messages(session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
         VALUES($1,$2,'[]'::jsonb,1,$3,$4,$5,'internal','{}','{}',1,false) RETURNING id`,
        [sessionId, role, workspaceId, userId, assistantId])).rows[0].id
      const personal = await message(await session('owner', null), 'user')
      const docThread = await message(await session('workspace', null), 'user')
      const draft = await message(await session('owner', 'draft'), 'user')
      const reply = await message(await session('owner', null), 'assistant')

      await client.query(restamp)

      const row = async (id: string) => (await client.query(
        'SELECT user_id, assistant_id, scope_version FROM session_messages WHERE id=$1', [id])).rows[0]
      // A person's input keeps its owner but no longer belongs to one assistant.
      expect(await row(personal)).toMatchObject({ user_id: userId, assistant_id: null })
      // Shared-audience input is the room's.
      expect(await row(docThread)).toMatchObject({ user_id: null, assistant_id: null })
      expect(await row(draft)).toMatchObject({ user_id: null, assistant_id: null })
      // Assistant output keeps the envelope it was derived under.
      expect(await row(reply)).toMatchObject({ user_id: userId, assistant_id: assistantId })
      // The version advances, so evidence captured before the restamp is judged afresh.
      expect(Number((await row(personal)).scope_version)).toBeGreaterThan(1)
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})
