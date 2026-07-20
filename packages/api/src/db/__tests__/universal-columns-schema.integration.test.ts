import { describe, it, expect, afterAll } from 'vitest'
import pg from 'pg'

/**
 * Schema-application test for migration 128 (universal column-set
 * rollout). Verifies that every targeted primitive (memories, tasks,
 * workspace_files, companies, contacts, deals) carries the universal
 * column set, the visibility + valid indexes are present, defaults
 * apply, and the memories Q11 visibility CHECK exists. Requires a
 * local PostgreSQL `Use Brian` database with migrations applied;
 * skips silently when unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'Use Brian', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM memories LIMIT 1')
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

/**
 * Universal column-set names that WU-2.1 mandates on every primitive.
 * `workspace_id` is part of the visibility partition but is owned by
 * each primitive's creation migration (and the mig-110 team→workspace
 * rename for memories), not this one — checked via the visibility
 * index assertion rather than the column-presence assertion.
 */
const UNIVERSAL_COLUMNS = [
  'sensitivity',
  'user_id',
  'assistant_id',
  'created_by_user_id',
  'created_by_assistant_id',
  'source_episode_id',
  'source',
  'verified_by_user_id',
  'verified_at',
  'valid_from',
  'valid_to',
  'superseded_by',
  'retracted_at',
  'retracted_reason',
  'retracted_by',
] as const

const PRIMITIVES = [
  { table: 'memories' },
  { table: 'tasks' },
  { table: 'workspace_files' },
  { table: 'companies' },
  { table: 'contacts' },
  { table: 'deals' },
] as const

describeIf('[COMP:brain/universal-column-set] mig 128 universal columns', () => {
  describe.each(PRIMITIVES)('$table', ({ table }) => {
    it('carries every universal column', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
      const got = new Set(r.rows.map((row) => row.column_name as string))
      for (const expected of UNIVERSAL_COLUMNS) {
        expect(got, `${table} missing column ${expected}`).toContain(expected)
      }
    })

    it('has the visibility + valid indexes', async () => {
      const r = await pool!.query(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      )
      const got = new Set(r.rows.map((row) => row.indexname as string))
      expect(got, `${table} missing visibility index`).toContain(
        `idx_${table}_visibility`,
      )
      expect(got, `${table} missing valid index`).toContain(`idx_${table}_valid`)
    })

    it('visibility index covers (workspace_id, user_id, assistant_id)', async () => {
      const r = await pool!.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = $1
           AND indexname = $2`,
        [table, `idx_${table}_visibility`],
      )
      const def = r.rows[0]?.indexdef as string | undefined
      expect(def).toBeDefined()
      expect(def).toMatch(/\(workspace_id, user_id, assistant_id\)/)
    })

    it('valid index is partial on valid_to IS NULL', async () => {
      const r = await pool!.query(
        `SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = $1
           AND indexname = $2`,
        [table, `idx_${table}_valid`],
      )
      const def = r.rows[0]?.indexdef as string | undefined
      expect(def).toBeDefined()
      expect(def).toMatch(/WHERE \(?valid_to IS NULL\)?/)
    })

    it('valid_from is NOT NULL with DEFAULT now()', async () => {
      const r = await pool!.query(
        `SELECT is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = 'valid_from'`,
        [table],
      )
      expect(r.rows[0]?.is_nullable).toBe('NO')
      expect(r.rows[0]?.column_default).toMatch(/now\(\)/)
    })

    it('sensitivity is NOT NULL with DEFAULT internal', async () => {
      const r = await pool!.query(
        `SELECT is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = $1
           AND column_name = 'sensitivity'`,
        [table],
      )
      expect(r.rows[0]?.is_nullable).toBe('NO')
      expect(r.rows[0]?.column_default).toMatch(/'internal'/)
    })
  })

  describe('memories', () => {
    it('user_id stays NOT NULL; assistant_id relaxed to NULLABLE in mig 240 (workspace_shared)', async () => {
      // mig 128 left both NOT NULL; mig 240 relaxed `assistant_id` to
      // support the `workspace_shared` scope (a primary assistant's
      // memories store assistant_id = NULL, user_id kept). `user_id`
      // stays NOT NULL. The `memories_visibility_check` then blocks the
      // (NULL, NULL) shape. See docs/architecture/platform/sensitivity.md
      // → "saveMemory resolution".
      const r = await pool!.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'memories'
           AND column_name IN ('user_id', 'assistant_id')`,
      )
      const byCol = Object.fromEntries(r.rows.map((row) => [row.column_name, row.is_nullable]))
      expect(byCol.user_id, 'memories.user_id should be NOT NULL').toBe('NO')
      expect(byCol.assistant_id, 'memories.assistant_id should be NULLABLE (mig 240)').toBe('YES')
    })

    it('source default stays "extracted" (not overwritten by mig 128)', async () => {
      const r = await pool!.query(
        `SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'memories'
           AND column_name = 'source'`,
      )
      expect(r.rows[0]?.column_default).toMatch(/'extracted'/)
    })

    it('memories_visibility_check constraint is present', async () => {
      const r = await pool!.query(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'public.memories'::regclass
           AND conname = 'memories_visibility_check'`,
      )
      expect(r.rowCount).toBe(1)
    })
  })

  describe('workspace_files', () => {
    it('renamed created_by → created_by_user_id (legacy column gone)', async () => {
      const r = await pool!.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'workspace_files'`,
      )
      const cols = new Set(r.rows.map((row) => row.column_name as string))
      expect(cols).toContain('created_by_user_id')
      expect(cols).not.toContain('created_by')
    })

    it('source defaults to "user" (universal default, not memories-style "extracted")', async () => {
      const r = await pool!.query(
        `SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'workspace_files'
           AND column_name = 'source'`,
      )
      expect(r.rows[0]?.column_default).toMatch(/'user'/)
    })
  })
})
