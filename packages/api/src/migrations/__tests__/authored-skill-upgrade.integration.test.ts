import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

// An isolated native PG18 cluster: never use DATABASE_URL or workspace dotenv.
// PG_BIN=/opt/homebrew/opt/postgresql@18/bin pnpm --filter @use-brian/api exec vitest run --config vitest.integration.config.ts src/migrations/__tests__/authored-skill-upgrade.integration.test.ts
const bin = process.env.PG_BIN
const repairName = '82200_skill_scope_owner_access.sql'
const backfillName = '8220_authored_skill_scope_roots.sql'
const migrationDir = new URL('../../../migrations/', import.meta.url)
const { runMigrations } = await import(new URL('../../../scripts/migrate.ts', import.meta.url).href)

describe.skipIf(!bin)('[COMP:api/skill-store] authored receipt migration owner access', () => {
  it('recovers the real backfill and runtime writes without relaxing application-role RLS', async () => {
    const root = await mkdtemp('/tmp/brian-skill-upgrade-')
    const cmd = (name: string, args: string[]) => execFileSync(join(bin!, name), args, { encoding: 'utf8' })
    const port = 58220
    const client = (user: string) => new pg.Client({ host: root, port, user, database: 'postgres' })
    const admin = client('bootstrap')
    const owner = client('migration_owner')
    const app = client('app_user')
    const databaseUrl = `postgresql://migration_owner@localhost:${port}/postgres?host=${encodeURIComponent(root)}`
    let started = false
    try {
      expect(cmd('postgres', ['--version'])).toMatch(/PostgreSQL\) 18\./)
      cmd('initdb', ['-D', join(root, 'data'), '-A', 'trust', '-U', 'bootstrap', '--no-locale', '-E', 'UTF8'])
      cmd('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'server.log'), '-o', `-k ${root} -p ${port} -c listen_addresses=''`, '-w', 'start'])
      started = true
      await admin.connect()
      await admin.query(`CREATE ROLE migration_owner LOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS;
        CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;
        UPDATE pg_extension SET extowner='migration_owner'::regrole WHERE extname IN ('vector','pg_trgm');
        ALTER DATABASE postgres OWNER TO migration_owner;
        ALTER SCHEMA public OWNER TO migration_owner;`)
      await owner.connect()
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO app_user;`)
      expect((await owner.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
        .toEqual([{ rolsuper: false, rolbypassrls: false }])
      // Replay the actual prerequisite schema through 602, then exercise the
      // receipt migrations directly without unrelated native-reader upgrades.
      const boundary = new Error('pre-repair fixture boundary')
      await expect(runMigrations({ databaseUrl, beforeApply({ file }: { file: string }) {
        if (file === '603_complete_scope_inventory.sql') throw boundary
      } })).rejects.toBe(boundary)

      const userId = randomUUID()
      const outsiderId = randomUUID()
      const workspaceId = randomUUID()
      await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text)', [userId, outsiderId])
      await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Upgrade fixture',$2)", [workspaceId, userId])
      await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
      async function skill(slug: string, induction = 'authored', origin = 'foreground') {
        return (await owner.query(`INSERT INTO workspace_skills(workspace_id,author_id,slug,name,description,content,sensitivity,induction_source,write_origin)
          VALUES($1,$2,$3,$3,'Fixture skill','Fixture content','confidential',$4,$5) RETURNING id`,
        [workspaceId, userId, slug, induction, origin])).rows[0].id as string
      }
      const authored = await skill('existing-authored')
      const derived = await skill('existing-derived', 'self', 'background_review')
      const backfill = await readFile(new URL(backfillName, migrationDir), 'utf8')
      await expect(owner.query(backfill)).rejects.toMatchObject({
        code: '42501', message: 'new row violates row-level security policy for table "workspace_skill_scope_revisions"',
      })
      await owner.query('ROLLBACK')
      expect((await owner.query('SELECT scope_revision_id FROM workspace_skills WHERE id=$1', [authored])).rows)
        .toEqual([{ scope_revision_id: null }])

      const policies = (await owner.query("SELECT * FROM pg_policy WHERE polrelid='workspace_skill_scope_revisions'::regclass ORDER BY polname")).rows
      for (const file of [repairName, backfillName, '8222_authored_skill_revision_changes.sql', '8223_authored_skill_receipt_publication.sql']) {
        await owner.query(await readFile(new URL(file, migrationDir), 'utf8'))
      }
      expect((await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='workspace_skill_scope_revisions'::regclass")).rows)
        .toEqual([{ relrowsecurity: true, relforcerowsecurity: false }])
      expect((await owner.query("SELECT * FROM pg_policy WHERE polrelid='workspace_skill_scope_revisions'::regclass ORDER BY polname")).rows).toEqual(policies)
      expect((await owner.query('SELECT sensitivity,user_id,assistant_id,compartments,project_ids FROM workspace_skill_scope_revisions WHERE skill_id=$1', [authored])).rows)
        .toEqual([{ sensitivity: 'confidential', user_id: null, assistant_id: null, compartments: [], project_ids: [] }])
      expect((await owner.query('SELECT scope_revision_id FROM workspace_skills WHERE id=$1', [derived])).rows)
        .toEqual([{ scope_revision_id: null }])
      const fresh = await skill('new-authored')
      expect((await owner.query('SELECT scope_revision_id IS NOT NULL AS rooted FROM workspace_skills WHERE id=$1', [fresh])).rows)
        .toEqual([{ rooted: true }])
      await owner.query("UPDATE workspace_skills SET content='Updated content' WHERE id=$1", [fresh])
      expect((await owner.query('SELECT revision,scope_held FROM workspace_skill_scope_revisions WHERE skill_id=$1 ORDER BY revision', [fresh])).rows)
        .toEqual([{ revision: '1', scope_held: true }, { revision: '2', scope_held: false }])

      await app.connect()
      await app.query("SELECT set_config('app.system_bypass','false',false),set_config('app.current_user_id',$1,false)", [outsiderId])
      expect((await app.query('SELECT id FROM workspace_skill_scope_revisions WHERE workspace_id=$1', [workspaceId])).rows).toEqual([])
      await app.query("SELECT set_config('app.current_user_id',$1,false)", [userId])
      expect((await app.query('SELECT revision FROM workspace_skill_scope_revisions WHERE skill_id=$1 ORDER BY revision', [fresh])).rows)
        .toEqual([{ revision: '2' }])
      await expect(app.query(`INSERT INTO workspace_skill_scope_revisions(workspace_id,skill_id,revision,sensitivity,compartments,project_ids)
        VALUES($1,$2,3,'public','{}','{}')`, [workspaceId, fresh])).rejects.toMatchObject({ code: '42501' })
      expect((await app.query("UPDATE workspace_skill_scope_revisions SET scope_held=true WHERE skill_id=$1", [fresh])).rowCount).toBe(0)
      const receipts = (await owner.query('SELECT * FROM workspace_skill_scope_revisions ORDER BY id')).rows
      await owner.query(await readFile(new URL(repairName, migrationDir), 'utf8'))
      expect((await owner.query('SELECT * FROM workspace_skill_scope_revisions ORDER BY id')).rows).toEqual(receipts)
    } finally {
      await Promise.allSettled([app.end(), owner.end(), admin.end()])
      if (started) cmd('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', 'stop'])
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
