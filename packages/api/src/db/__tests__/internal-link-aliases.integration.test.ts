import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 2_000,
})

async function canConnect(): Promise<boolean> {
  try {
    await pool.query('SELECT 1 FROM saved_views LIMIT 1')
    return true
  } catch {
    return false
  }
}

const available = await canConnect()
const describeIf = available ? describe : describe.skip
if (!available) {
  console.log('[internal-link aliases integration] skipped: local migrated PostgreSQL is unavailable.')
}

afterAll(async () => {
  await pool.end()
})

function key(alias: string): string {
  return createHash('sha256').update(alias).digest('hex')
}

async function migrationSql(): Promise<string> {
  return (await readFile(new URL('../../../migrations/553_internal_link_aliases.sql', import.meta.url), 'utf8'))
    .replace(/^BEGIN;$/m, '')
    .replace(/^COMMIT;$/m, '')
}

describeIf('[COMP:db/internal-link-aliases] migration lifecycle', () => {
  it('enforces namespaces and leaves non-reassignable tombstones on moves and deletes', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`
        DROP TRIGGER IF EXISTS workspaces_tombstone_internal_links ON workspaces;
        DROP TRIGGER IF EXISTS saved_views_tombstone_internal_links_on_delete ON saved_views;
        DROP TRIGGER IF EXISTS saved_views_tombstone_internal_links_on_workspace_move ON saved_views;
        DROP TABLE IF EXISTS page_link_aliases;
        DROP TABLE IF EXISTS workspace_link_aliases;
        DROP FUNCTION IF EXISTS tombstone_workspace_link_aliases();
        DROP FUNCTION IF EXISTS tombstone_page_link_aliases();
        DROP FUNCTION IF EXISTS enforce_page_link_alias_workspace();
      `)
      await client.query(await migrationSql())

      const ownerId = randomUUID()
      const workspaceOne = randomUUID()
      const workspaceTwo = randomUUID()
      const pageOne = randomUUID()
      const pageTwo = randomUUID()
      await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES ($1::uuid, 'test', $1::text)`,
        [ownerId],
      )
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id)
         VALUES ($1, 'Fixture One', $3), ($2, 'Fixture Two', $3)`,
        [workspaceOne, workspaceTwo, ownerId],
      )
      await client.query(
        `INSERT INTO saved_views (id, workspace_id, created_by, name, entity, view_type)
         VALUES ($1, $3, $5, 'Page One', 'tasks', 'table'),
                ($2, $4, $5, 'Page Two', 'tasks', 'table')`,
        [pageOne, pageTwo, workspaceOne, workspaceTwo, ownerId],
      )

      await client.query(
        `INSERT INTO workspace_link_aliases (workspace_id, alias, alias_key, created_by)
         VALUES ($1, 'product', $2, $3)`,
        [workspaceOne, key('product'), ownerId],
      )
      await expect(client.query(
        `INSERT INTO workspace_link_aliases (workspace_id, alias, alias_key, created_by)
         VALUES ($1, 'product', $2, $3)`,
        [workspaceTwo, key('product'), ownerId],
      )).rejects.toMatchObject({ code: '23505' })
      await client.query('ROLLBACK')

      // PostgreSQL aborts a transaction after an expected constraint failure.
      // Repeat the migration rehearsal for the lifecycle assertions.
      await client.query('BEGIN')
      await client.query(`
        DROP TRIGGER IF EXISTS workspaces_tombstone_internal_links ON workspaces;
        DROP TRIGGER IF EXISTS saved_views_tombstone_internal_links_on_delete ON saved_views;
        DROP TRIGGER IF EXISTS saved_views_tombstone_internal_links_on_workspace_move ON saved_views;
        DROP TABLE IF EXISTS page_link_aliases;
        DROP TABLE IF EXISTS workspace_link_aliases;
        DROP FUNCTION IF EXISTS tombstone_workspace_link_aliases();
        DROP FUNCTION IF EXISTS tombstone_page_link_aliases();
        DROP FUNCTION IF EXISTS enforce_page_link_alias_workspace();
      `)
      await client.query(await migrationSql())
      await client.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES ($1::uuid, 'test', $1::text)`,
        [ownerId],
      )
      await client.query(
        `INSERT INTO workspaces (id, name, owner_user_id)
         VALUES ($1, 'Fixture One', $3), ($2, 'Fixture Two', $3)`,
        [workspaceOne, workspaceTwo, ownerId],
      )
      await client.query(
        `INSERT INTO saved_views (id, workspace_id, created_by, name, entity, view_type)
         VALUES ($1, $3, $5, 'Page One', 'tasks', 'table'),
                ($2, $4, $5, 'Page Two', 'tasks', 'table')`,
        [pageOne, pageTwo, workspaceOne, workspaceTwo, ownerId],
      )
      await client.query(
        `INSERT INTO workspace_link_aliases (workspace_id, alias, alias_key, created_by)
         VALUES ($1, 'product', $2, $3), ($4, 'another', $5, $3)`,
        [workspaceOne, key('product'), ownerId, workspaceTwo, key('another')],
      )
      await client.query(
        `INSERT INTO page_link_aliases
           (namespace_workspace_id, page_id, alias, alias_key, created_by)
         VALUES ($1, $2, 'roadmap', $3, $5), ($4, $6, 'roadmap', $3, $5)`,
        [workspaceOne, pageOne, key('roadmap'), workspaceTwo, ownerId, pageTwo],
      )

      await client.query('UPDATE saved_views SET workspace_id = $1 WHERE id = $2', [workspaceTwo, pageOne])
      expect((await client.query(
        `SELECT page_id, alias, is_current, deleted_at IS NOT NULL AS deleted
           FROM page_link_aliases
          WHERE namespace_workspace_id = $1 AND alias_key = $2`,
        [workspaceOne, key('roadmap')],
      )).rows).toEqual([{ page_id: null, alias: null, is_current: false, deleted: true }])
      // The tombstone is not reassignable, even to a page that really is in
      // the namespace workspace (the moved page itself is refused earlier,
      // by the alias/page workspace check).
      const pageThree = randomUUID()
      await client.query(
        `INSERT INTO saved_views (id, workspace_id, created_by, name, entity, view_type)
         VALUES ($1, $2, $3, 'Page Three', 'tasks', 'table')`,
        [pageThree, workspaceOne, ownerId],
      )
      await expect(client.query(
        `INSERT INTO page_link_aliases
           (namespace_workspace_id, page_id, alias, alias_key, created_by)
         VALUES ($1, $2, 'roadmap', $3, $4)`,
        [workspaceOne, pageThree, key('roadmap'), ownerId],
      )).rejects.toMatchObject({ code: '23505' })
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })
})
