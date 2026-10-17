import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

// This is the initial real-DB fixture foundation, not certification of A01-A22.
// Later phases extend this suite through their real HTTP/module/source consumers.
describe('[COMP:api/application-platform-acceptance] disposable authority fixture', () => {
  const owner = getPool()
  const users = [randomUUID(), randomUUID()]
  const workspaces = [randomUUID(), randomUUID()]
  const types = [randomUUID(), randomUUID()]
  const records = [randomUUID(), randomUUID()]

  beforeAll(async () => {
    for (let index = 0; index < 2; index += 1) {
      await owner.query('INSERT INTO users(id, auth_provider_id) VALUES($1::uuid, $1::text)', [users[index]])
      await owner.query('INSERT INTO workspaces(id, name, owner_user_id) VALUES($1, $2, $3)',
        [workspaces[index], 'Application fixture', users[index]])
      await owner.query("INSERT INTO workspace_members(workspace_id, user_id, role, clearance) VALUES($1, $2, 'owner', 'confidential')",
        [workspaces[index], users[index]])
      await owner.query(`INSERT INTO entity_types(id, workspace_id, name, properties, created_by)
        VALUES($1, $2, 'Purchase request', '[{"name":"title","config":{"kind":"text"}}]', $3)`,
      [types[index], workspaces[index], users[index]])
      await owner.query(`INSERT INTO entity_instances(id, entity_type_id, workspace_id, data, created_by, last_edited_by)
        VALUES($1, $2, $3, '{"title":{"kind":"text","value":"Fixture request"}}', $4, $4)`,
      [records[index], types[index], workspaces[index], users[index]])
    }
  })

  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [workspaces])
    await owner.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [users])
    await getAppPool().end()
    await owner.end()
  })

  it('runs the reader on an actual non-owner, non-bypass application role', async () => {
    const result = await queryWithRLS(users[0], `SELECT current_user AS role,
      rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
    expect(result.rows[0]).toMatchObject({ role: 'assurance_app', rolsuper: false, rolbypassrls: false })
  })

  it('keeps equal type names and generic record IDs inside their current member workspace', async () => {
    for (let index = 0; index < 2; index += 1) {
      const result = await queryWithRLS(users[index],
        'SELECT id FROM entity_instances WHERE id = ANY($1::uuid[]) ORDER BY id', [records])
      expect(result.rows.map(row => row.id)).toEqual([records[index]])
      const foreign = await queryWithRLS(users[index],
        'SELECT id FROM entity_types WHERE id = $1', [types[1 - index]])
      expect(foreign.rows).toEqual([])
    }
  })

  it('rechecks membership rather than treating a prior read as a durable grant', async () => {
    await owner.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaces[0], users[0]])
    const result = await queryWithRLS(users[0], 'SELECT id FROM entity_instances WHERE id = $1', [records[0]])
    expect(result.rows).toEqual([])
  })
})
