import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 127 (CRM entity_id FK).
 * Verifies that contacts/companies/deals each carry a nullable, UNIQUE
 * entity_id column referencing entities(id) with ON DELETE RESTRICT.
 * Requires a local PostgreSQL `sidanclaw` database with migrations
 * applied; skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT entity_id FROM contacts LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'crm-entity-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'crm-entity-test-ws', 'test', $1, true)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function makeEntity(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
  kind: 'person' | 'company' | 'deal',
): Promise<string> {
  const r = await client.query(
    `INSERT INTO entities (kind, display_name, workspace_id, user_id, created_by_user_id, source)
     VALUES ($1, 'E-' || $1, $2, $3, $3, 'user')
     RETURNING id`,
    [kind, workspaceId, userId],
  )
  return r.rows[0].id
}

interface ColumnInfo {
  data_type: string
  is_nullable: string
}

async function getColumn(table: string, column: string): Promise<ColumnInfo | undefined> {
  const r = await pool!.query(
    `SELECT data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  return r.rows[0]
}

describeIf('[COMP:brain/crm-entity-link] CRM entity_id FK schema (mig 127)', () => {
  describe('Column shape', () => {
    it('contacts.entity_id exists, is uuid, is nullable', async () => {
      const col = await getColumn('contacts', 'entity_id')
      expect(col).toBeDefined()
      expect(col?.data_type).toBe('uuid')
      expect(col?.is_nullable).toBe('YES')
    })

    it('companies.entity_id exists, is uuid, is nullable', async () => {
      const col = await getColumn('companies', 'entity_id')
      expect(col).toBeDefined()
      expect(col?.data_type).toBe('uuid')
      expect(col?.is_nullable).toBe('YES')
    })

    it('deals.entity_id exists, is uuid, is nullable', async () => {
      const col = await getColumn('deals', 'entity_id')
      expect(col).toBeDefined()
      expect(col?.data_type).toBe('uuid')
      expect(col?.is_nullable).toBe('YES')
    })
  })

  describe('Constraints', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
      } finally {
        client.release()
      }
    })

    it('inserting a CRM row with entity_id = NULL is allowed (forward-only nullable)', async () => {
      const client = await pool!.connect()
      try {
        const r = await client.query(
          `INSERT INTO contacts (workspace_id, name)
           VALUES ($1, 'no-entity')
           RETURNING id, entity_id`,
          [workspaceId],
        )
        expect(r.rowCount).toBe(1)
        expect(r.rows[0].entity_id).toBeNull()
      } finally {
        client.release()
      }
    })

    it('inserting a contact with a valid entity_id succeeds', async () => {
      const client = await pool!.connect()
      try {
        const entityId = await makeEntity(client, workspaceId, userId, 'person')
        const r = await client.query(
          `INSERT INTO contacts (workspace_id, name, entity_id)
           VALUES ($1, 'with-entity', $2)
           RETURNING id`,
          [workspaceId, entityId],
        )
        expect(r.rowCount).toBe(1)
      } finally {
        client.release()
      }
    })

    it('FK rejects a contacts.entity_id that does not exist in entities', async () => {
      const client = await pool!.connect()
      try {
        await expect(
          client.query(
            `INSERT INTO contacts (workspace_id, name, entity_id)
             VALUES ($1, 'bad-fk', gen_random_uuid())`,
            [workspaceId],
          ),
        ).rejects.toThrow(/foreign key|entities/i)
      } finally {
        client.release()
      }
    })

    it('UNIQUE on contacts.entity_id rejects a second contact pointing at the same entity', async () => {
      const client = await pool!.connect()
      try {
        const entityId = await makeEntity(client, workspaceId, userId, 'person')
        await client.query(
          `INSERT INTO contacts (workspace_id, name, entity_id) VALUES ($1, 'first', $2)`,
          [workspaceId, entityId],
        )
        await expect(
          client.query(
            `INSERT INTO contacts (workspace_id, name, entity_id) VALUES ($1, 'second', $2)`,
            [workspaceId, entityId],
          ),
        ).rejects.toThrow(/duplicate key|unique/i)
      } finally {
        client.release()
      }
    })

    it('UNIQUE on contacts.entity_id allows multiple NULLs', async () => {
      const client = await pool!.connect()
      try {
        await client.query(
          `INSERT INTO contacts (workspace_id, name) VALUES ($1, 'null-1')`,
          [workspaceId],
        )
        const r = await client.query(
          `INSERT INTO contacts (workspace_id, name) VALUES ($1, 'null-2') RETURNING id`,
          [workspaceId],
        )
        expect(r.rowCount).toBe(1)
      } finally {
        client.release()
      }
    })

    it('ON DELETE RESTRICT blocks deleting an entity referenced by a contact', async () => {
      const client = await pool!.connect()
      try {
        const entityId = await makeEntity(client, workspaceId, userId, 'person')
        await client.query(
          `INSERT INTO contacts (workspace_id, name, entity_id) VALUES ($1, 'pinned', $2)`,
          [workspaceId, entityId],
        )
        await expect(
          client.query(`DELETE FROM entities WHERE id = $1`, [entityId]),
        ).rejects.toThrow(/foreign key|restrict|violates/i)
      } finally {
        client.release()
      }
    })

    it('UNIQUE applies to companies.entity_id', async () => {
      const client = await pool!.connect()
      try {
        const entityId = await makeEntity(client, workspaceId, userId, 'company')
        await client.query(
          `INSERT INTO companies (workspace_id, name, entity_id) VALUES ($1, 'co-1', $2)`,
          [workspaceId, entityId],
        )
        await expect(
          client.query(
            `INSERT INTO companies (workspace_id, name, entity_id) VALUES ($1, 'co-2', $2)`,
            [workspaceId, entityId],
          ),
        ).rejects.toThrow(/duplicate key|unique/i)
      } finally {
        client.release()
      }
    })

    it('UNIQUE applies to deals.entity_id', async () => {
      const client = await pool!.connect()
      try {
        const entityId = await makeEntity(client, workspaceId, userId, 'deal')
        await client.query(
          `INSERT INTO deals (workspace_id, entity_id) VALUES ($1, $2)`,
          [workspaceId, entityId],
        )
        await expect(
          client.query(
            `INSERT INTO deals (workspace_id, entity_id) VALUES ($1, $2)`,
            [workspaceId, entityId],
          ),
        ).rejects.toThrow(/duplicate key|unique/i)
      } finally {
        client.release()
      }
    })
  })
})
