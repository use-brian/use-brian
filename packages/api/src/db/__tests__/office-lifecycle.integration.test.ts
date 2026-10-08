/** Executes store SQL in transaction-local fixtures, not the migrated schema/RLS. */
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createOfficeArtifactStore, type OfficeDbQuery } from '../office-artifacts.js'
import { createOfficeTemplateStore } from '../office-templates.js'
import { OFFICE_LIFECYCLE_SWEEP_SQL } from '../office-lifecycle.js'

const url = process.env.OFFICE_LIFECYCLE_TEST_DATABASE_URL
const pool = url ? new pg.Pool({ connectionString: url }) : null
let client: pg.PoolClient
const owner = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const db: OfficeDbQuery = async (_user, sql, params) => ({ rows: (await client.query(sql, params)).rows })
const templates = createOfficeTemplateStore(db)
const artifacts = createOfficeArtifactStore(db)
const transition = (action: 'trash' | 'restore' | 'purge' | 'deprecate', userId = owner) => templates.transitionLifecycle({ userId, templateId: 'template', action, reason: 'Test lifecycle' })
async function states() {
  return (await client.query(`SELECT t.lifecycle_state AS template, a.lifecycle_state AS draft,
    a.retain_at=t.retain_at AS same_retain, a.purge_at=t.purge_at AS same_purge
    FROM office_templates t JOIN office_artifacts a ON a.id=t.draft_artifact_id WHERE t.id='template'`)).rows[0]
}

describe.skipIf(!url)('[COMP:api/office-store] template lifecycle SQL', () => {
  beforeAll(async () => { client = await pool!.connect() })
  afterAll(async () => { client?.release(); await pool?.end() })
  beforeEach(async () => {
    await client.query(`BEGIN;
      CREATE TEMP TABLE office_artifacts (
        id text PRIMARY KEY, workspace_id text DEFAULT 'workspace', family text DEFAULT 'document',
        mode text DEFAULT 'artifact', title text DEFAULT 'Example', creator_user_id uuid, owner_user_id uuid,
        template_version_id text, head_version_id text, head_version bigint DEFAULT 0,
        capability_version int DEFAULT 1, sensitivity text DEFAULT 'internal', compartments text[], project_ids uuid[],
        default_workspace_role text DEFAULT 'edit', lifecycle_state text DEFAULT 'active',
        legal_hold boolean DEFAULT false, archived_at timestamptz, trashed_at timestamptz,
        retain_at timestamptz, purge_at timestamptz, expires_at timestamptz, updated_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE office_templates (
        id text PRIMARY KEY, workspace_id text DEFAULT 'workspace', owner_user_id uuid,
        draft_artifact_id text, current_version_id text, lifecycle_state text DEFAULT 'draft',
        legal_hold boolean DEFAULT false, trashed_at timestamptz, retain_at timestamptz,
        purge_at timestamptz, updated_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE office_template_versions (id text, template_id text) ON COMMIT DROP;
      CREATE TEMP TABLE workspace_members (workspace_id text, user_id uuid, role text) ON COMMIT DROP;
      CREATE TEMP TABLE office_offline_packages (artifact_id text, revoked_at timestamptz, complete boolean DEFAULT true, updated_at timestamptz) ON COMMIT DROP;
      CREATE TEMP TABLE office_audit_events (workspace_id text, artifact_id text, actor_user_id uuid,
        event_type text, artifact_version bigint, reason text, metadata jsonb) ON COMMIT DROP;
      INSERT INTO office_artifacts(id,mode) VALUES ('draft','template'),('normal','artifact');
      INSERT INTO office_templates(id,owner_user_id,draft_artifact_id) VALUES ('template','${owner}','draft');
      INSERT INTO office_offline_packages(artifact_id) VALUES ('draft'),('normal');`)
  })
  afterEach(async () => { await client.query('ROLLBACK') })

  it('filters by durable mode before the limit for every lifecycle, without hiding empty normal imports', async () => {
    // More than a page of orphan template shells must not crowd out real files.
    await client.query(`INSERT INTO office_artifacts(id,mode) SELECT 'orphan-'||n,'template' FROM generate_series(1,201) n`)
    for (const state of ['active', 'archived', 'trash', 'retained'] as const) {
      await client.query('UPDATE office_artifacts SET lifecycle_state=$1', [state])
      expect((await artifacts.list(owner, 'workspace', state)).map(row => row.id)).toEqual(['normal'])
    }
    expect(await artifacts.list(owner, 'other-workspace', 'active')).toEqual([])
  })

  it('atomically trashes, restores and purges only the linked draft, with clocks, audit and offline revocation', async () => {
    expect(await transition('trash')).toMatchObject({ lifecycleState: 'trash' })
    expect(await states()).toMatchObject({ template: 'trash', draft: 'trash', same_retain: true, same_purge: true })
    expect(await transition('restore')).toMatchObject({ lifecycleState: 'draft' })
    expect(await states()).toMatchObject({ template: 'draft', draft: 'active' })
    expect((await client.query(`SELECT retain_at,purge_at FROM office_artifacts WHERE id='draft'`)).rows[0]).toEqual({ retain_at: null, purge_at: null })
    await transition('trash')
    expect(await transition('purge')).toMatchObject({ lifecycleState: 'purged' })
    expect(await states()).toMatchObject({ template: 'purged', draft: 'purged' })
    expect((await client.query(`SELECT artifact_id,complete FROM office_offline_packages ORDER BY artifact_id`)).rows).toEqual([{ artifact_id: 'draft', complete: false }, { artifact_id: 'normal', complete: true }])
    expect((await client.query(`SELECT lifecycle_state FROM office_artifacts WHERE id='normal'`)).rows[0].lifecycle_state).toBe('active')
    expect((await client.query(`SELECT * FROM office_audit_events`)).rowCount).toBe(8)
  })

  it('rolls back both rows if a downstream audit write fails', async () => {
    await client.query(`ALTER TABLE office_audit_events ADD CHECK (event_type NOT LIKE 'office.template.%'); SAVEPOINT lifecycle`)
    await expect(transition('trash')).rejects.toThrow()
    await client.query('ROLLBACK TO SAVEPOINT lifecycle')
    expect(await states()).toMatchObject({ template: 'draft', draft: 'active' })
    expect((await client.query('SELECT * FROM office_audit_events')).rowCount).toBe(0)
  })

  it('keeps legacy unlinked registry transitions and invalid-state guards', async () => {
    expect(await transition('purge')).toBeNull()
    await client.query(`UPDATE office_templates SET draft_artifact_id=NULL`)
    expect(await transition('trash')).toMatchObject({ lifecycleState: 'trash' })
    expect(await transition('purge')).toMatchObject({ lifecycleState: 'purged' })
    expect((await client.query(`SELECT lifecycle_state FROM office_artifacts WHERE id='draft'`)).rows[0].lifecycle_state).toBe('active')
  })

  it('prevents a linked draft from bypassing registry retention through artifact lifecycle', async () => {
    expect(await artifacts.transitionLifecycle({ userId: owner, artifactId: 'draft', action: 'trash', reason: 'Test' })).toBeNull()
    expect(await artifacts.transitionLifecycle({ userId: owner, artifactId: 'normal', action: 'trash', reason: 'Test' })).toMatchObject({ lifecycleState: 'trash' })
    expect(await states()).toMatchObject({ template: 'draft', draft: 'active' })
  })

  it('preserves admitted versions through deprecate, trash and restore', async () => {
    await client.query(`INSERT INTO office_template_versions VALUES ('version','template'); UPDATE office_templates SET current_version_id='version',lifecycle_state='admitted'`)
    await transition('deprecate')
    expect(await states()).toMatchObject({ template: 'deprecated', draft: 'active' })
    await transition('trash')
    expect(await transition('restore')).toMatchObject({ lifecycleState: 'admitted' })
    expect((await client.query('SELECT * FROM office_template_versions')).rows).toEqual([{ id: 'version', template_id: 'template' }])
  })

  it.each(['office_templates', 'office_artifacts'])('blocks both rows under a legal hold on %s', async table => {
    await client.query(`UPDATE ${table} SET legal_hold=true`)
    expect(await transition('trash')).toBeNull()
    expect(await states()).toMatchObject({ template: 'draft', draft: 'active' })
  })

  it('blocks unauthorized actors and bad links rather than mutating unrelated content', async () => {
    expect(await transition('trash', other)).toBeNull()
    await client.query(`UPDATE office_templates SET draft_artifact_id='normal'`)
    expect(await transition('trash')).toBeNull()
    await client.query(`UPDATE office_templates SET draft_artifact_id='draft'; UPDATE office_artifacts SET workspace_id='other' WHERE id='draft'`)
    expect(await transition('trash')).toBeNull()
  })

  it('allows owner/admin recovery of a legacy trash row whose draft is still active', async () => {
    await client.query(`UPDATE office_templates SET lifecycle_state='trash'; INSERT INTO workspace_members VALUES ('workspace','${other}','admin')`)
    expect(await transition('restore', other)).toMatchObject({ lifecycleState: 'draft' })
    await transition('trash', other)
    expect(await states()).toMatchObject({ template: 'trash', draft: 'trash' })
  })

  it('retains both rows and blocks manual and timed purge while any non-purged artifact pins a version', async () => {
    await client.query(`INSERT INTO office_template_versions VALUES ('version','template'); UPDATE office_artifacts SET template_version_id='version' WHERE id='normal'`)
    await transition('trash')
    await client.query(`UPDATE office_templates SET retain_at=now()-interval '31 days',purge_at=now()-interval '1 day'`)
    await client.query(OFFICE_LIFECYCLE_SWEEP_SQL)
    expect(await states()).toMatchObject({ template: 'retained', draft: 'retained', same_retain: true, same_purge: true })
    for (const state of ['active', 'archived', 'trash', 'retained']) {
      await client.query(`UPDATE office_artifacts SET lifecycle_state=$1 WHERE id='normal'`, [state])
      expect(await transition('purge')).toBeNull()
      await client.query(OFFICE_LIFECYCLE_SWEEP_SQL)
      expect(await states()).toMatchObject({ template: 'retained', draft: 'retained' })
    }
    await client.query(`UPDATE office_artifacts SET lifecycle_state='purged' WHERE id='normal'`)
    await client.query(OFFICE_LIFECYCLE_SWEEP_SQL)
    expect(await states()).toMatchObject({ template: 'purged', draft: 'purged' })
    expect((await client.query(`SELECT complete FROM office_offline_packages WHERE artifact_id='draft'`)).rows[0].complete).toBe(false)
  })

  it.each(['office_templates', 'office_artifacts'])('pauses both retention clocks under a hold on %s', async table => {
    await transition('trash')
    await client.query(`UPDATE office_templates SET retain_at=now()-interval '31 days'; UPDATE office_artifacts SET retain_at=now()-interval '31 days'; UPDATE ${table} SET legal_hold=true`)
    await client.query(OFFICE_LIFECYCLE_SWEEP_SQL)
    expect(await states()).toMatchObject({ template: 'trash', draft: 'trash' })
  })
})
