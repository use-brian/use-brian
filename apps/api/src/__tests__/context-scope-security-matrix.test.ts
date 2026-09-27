/**
 * Fresh-database proof for the Team + Project access matrix.
 *
 * Applies the complete OSS migration chain, then runs every discovery shape
 * through the production `buildAccessPredicate`. The fixture deliberately
 * includes General, single-Team, all-of multi-Team, single-Project, and
 * all-of multi-Project rows at several sensitivity tiers.
 *
 * [COMP:api/context-scope-security-matrix]
 */

import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  buildAccessPredicate,
  type AccessContext,
} from '../../../../packages/api/src/db/access-predicate.js'
import { migratePglite } from '../migrate-pglite.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000003'
const ATLAS = '10000000-0000-4000-8000-000000000001'
const BEACON = '10000000-0000-4000-8000-000000000002'

const ROWS = {
  general: '20000000-0000-4000-8000-000000000001',
  salesGeneral: '20000000-0000-4000-8000-000000000002',
  accountingAtlas: '20000000-0000-4000-8000-000000000003',
  salesAtlas: '20000000-0000-4000-8000-000000000004',
  salesBeacon: '20000000-0000-4000-8000-000000000005',
  salesFinanceAtlas: '20000000-0000-4000-8000-000000000006',
  salesAtlasBeacon: '20000000-0000-4000-8000-000000000007',
} as const

type MatrixScope = Pick<AccessContext, 'clearance' | 'compartments' | 'projectIds'>

const SCOPES: Record<string, MatrixScope> = {
  salesAtlas: {
    clearance: 'confidential',
    compartments: ['team:sales'],
    projectIds: [ATLAS],
  },
  strategyAtlas: {
    clearance: 'confidential',
    compartments: ['team:strategy', 'team:sales', 'team:product', 'team:operations'],
    projectIds: [ATLAS],
  },
  managementAtlas: {
    clearance: 'confidential',
    compartments: null,
    projectIds: [ATLAS],
  },
  managementCompany: {
    clearance: 'confidential',
    compartments: null,
    projectIds: null,
  },
  accountingAtlas: {
    clearance: 'confidential',
    compartments: ['team:accounting'],
    projectIds: [ATLAS],
  },
  externalGeneral: {
    clearance: 'public',
    compartments: [],
    projectIds: [],
  },
}

const EXPECTED: Record<string, string[]> = {
  salesAtlas: [ROWS.general, ROWS.salesGeneral, ROWS.salesAtlas],
  strategyAtlas: [ROWS.general, ROWS.salesGeneral, ROWS.salesAtlas],
  managementAtlas: [
    ROWS.general,
    ROWS.salesGeneral,
    ROWS.accountingAtlas,
    ROWS.salesAtlas,
    ROWS.salesFinanceAtlas,
  ],
  managementCompany: Object.values(ROWS),
  accountingAtlas: [ROWS.general, ROWS.accountingAtlas],
  externalGeneral: [ROWS.general],
}

let db: PGlite

function access(scope: MatrixScope): AccessContext {
  return {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    assistantKind: 'primary',
    ...scope,
  }
}

async function listIds(scope: MatrixScope): Promise<string[]> {
  const predicate = buildAccessPredicate(access(scope), { alias: 'r' })
  const result = await db.query<{ id: string }>(
    `SELECT r.id
       FROM context_matrix_rows r
      WHERE ${predicate.sql}
      ORDER BY r.id`,
    predicate.params,
  )
  return result.rows.map((row) => row.id)
}

async function idLookupIds(scope: MatrixScope): Promise<string[]> {
  const visible: string[] = []
  for (const id of Object.values(ROWS)) {
    const predicate = buildAccessPredicate(access(scope), { alias: 'r', startIdx: 2 })
    const result = await db.query<{ id: string }>(
      `SELECT r.id FROM context_matrix_rows r
        WHERE r.id = $1 AND ${predicate.sql}`,
      [id, ...predicate.params],
    )
    if (result.rows[0]) visible.push(result.rows[0].id)
  }
  return visible.sort()
}

async function ftsIds(scope: MatrixScope): Promise<string[]> {
  const predicate = buildAccessPredicate(access(scope), { alias: 'r', startIdx: 2 })
  const result = await db.query<{ id: string }>(
    `SELECT r.id FROM context_matrix_rows r
      WHERE to_tsvector('english', r.body) @@ plainto_tsquery('english', $1)
        AND ${predicate.sql}
      ORDER BY r.id`,
    ['scope-proof', ...predicate.params],
  )
  return result.rows.map((row) => row.id)
}

async function vectorIds(scope: MatrixScope): Promise<string[]> {
  const predicate = buildAccessPredicate(access(scope), { alias: 'r', startIdx: 2 })
  const result = await db.query<{ id: string }>(
    `SELECT r.id FROM context_matrix_rows r
      WHERE ${predicate.sql}
      ORDER BY r.embedding <=> $1::vector, r.id`,
    ['[1,0,0]', ...predicate.params],
  )
  return result.rows.map((row) => row.id)
}

async function graphIds(scope: MatrixScope): Promise<string[]> {
  const predicate = buildAccessPredicate(access(scope), { alias: 'r', startIdx: 2 })
  const result = await db.query<{ id: string }>(
    `SELECT r.id
       FROM context_matrix_edges e
       JOIN context_matrix_rows r ON r.id = e.target_id
      WHERE e.source_id = $1 AND ${predicate.sql}
      ORDER BY r.id`,
    [ROWS.general, ...predicate.params],
  )
  return result.rows.map((row) => row.id)
}

async function provenanceIds(scope: MatrixScope): Promise<string[]> {
  const predicate = buildAccessPredicate(access(scope), { alias: 'r' })
  const result = await db.query<{ id: string; provenance: string }>(
    `SELECT r.id, r.provenance FROM context_matrix_rows r
      WHERE ${predicate.sql}
      ORDER BY r.id`,
    predicate.params,
  )
  assert.equal(result.rows.every((row) => row.provenance === `source:${row.id}`), true)
  return result.rows.map((row) => row.id)
}

async function rollupIds(scope: MatrixScope): Promise<string[]> {
  const predicate = buildAccessPredicate(access(scope), { alias: 'r' })
  const result = await db.query<{ ids: string[]; count: number }>(
    `SELECT array_agg(r.id ORDER BY r.id) AS ids, count(*)::int AS count
       FROM context_matrix_rows r
      WHERE ${predicate.sql}`,
    predicate.params,
  )
  assert.equal(result.rows[0].count, result.rows[0].ids.length)
  return result.rows[0].ids
}

before(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } })
  await db.waitReady
  const migrationsDir = fileURLToPath(
    new URL('../../../../packages/api/migrations', import.meta.url),
  )
  await migratePglite(db, migrationsDir)
  await db.exec(`
    CREATE TABLE context_matrix_rows (
      id uuid PRIMARY KEY,
      workspace_id uuid,
      user_id uuid,
      assistant_id uuid,
      sensitivity text NOT NULL,
      compartments text[] NOT NULL,
      project_ids uuid[] NOT NULL,
      body text NOT NULL,
      embedding vector(3) NOT NULL,
      provenance text NOT NULL
    );
    CREATE TABLE context_matrix_edges (
      source_id uuid NOT NULL,
      target_id uuid NOT NULL
    );
  `)
  const fixtures = [
    [ROWS.general, 'public', [], []],
    [ROWS.salesGeneral, 'internal', ['team:sales'], []],
    [ROWS.accountingAtlas, 'confidential', ['team:accounting'], [ATLAS]],
    [ROWS.salesAtlas, 'internal', ['team:sales'], [ATLAS]],
    [ROWS.salesBeacon, 'internal', ['team:sales'], [BEACON]],
    [ROWS.salesFinanceAtlas, 'confidential', ['team:sales', 'team:finance'], [ATLAS]],
    [ROWS.salesAtlasBeacon, 'internal', ['team:sales'], [ATLAS, BEACON]],
  ] as const
  for (const [id, sensitivity, compartments, projectIds] of fixtures) {
    await db.query(
      `INSERT INTO context_matrix_rows
         (id, workspace_id, user_id, assistant_id, sensitivity, compartments,
          project_ids, body, embedding, provenance)
       VALUES ($1, $2, NULL, NULL, $3, $4::text[], $5::uuid[],
               'scope-proof', '[1,0,0]'::vector, $6)`,
      [id, WORKSPACE_ID, sensitivity, compartments, projectIds, `source:${id}`],
    )
    await db.query(
      'INSERT INTO context_matrix_edges (source_id, target_id) VALUES ($1, $2)',
      [ROWS.general, id],
    )
  }
})

after(async () => {
  await db.close()
})

describe('[COMP:api/context-scope-security-matrix] cross-path security matrix', () => {
  it('bounds member media lifetime and refuses a different workspace after fresh migration replay',async()=>{
    await db.query('INSERT INTO users(id,auth_provider_id) VALUES($1,$2)',[USER_ID,'media-fixture'])
    await db.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Media fixture',$2)",[WORKSPACE_ID,USER_ID])
    await db.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[WORKSPACE_ID,USER_ID])
    await db.query("SELECT set_config('app.current_user_id',$1,false)",[USER_ID])
    const allowed=await db.query<{ttl:number}>('SELECT department_media_valid_for_ms($1) AS ttl',[WORKSPACE_ID])
    assert.ok(allowed.rows[0].ttl>0&&allowed.rows[0].ttl<=30000)
    const denied=await db.query<{ttl:number}>('SELECT department_media_valid_for_ms($1) AS ttl',['00000000-0000-4000-8000-000000000099'])
    assert.equal(denied.rows[0].ttl,0)
    await db.query("SELECT set_config('app.current_user_id','',false)")
    assert.equal((await db.query<{ttl:number}>('SELECT department_media_valid_for_ms($1) AS ttl',[WORKSPACE_ID])).rows[0].ttl,0)
  })

  for (const [principal, scope] of Object.entries(SCOPES)) {
    it(`${principal} receives the exact same row set through every discovery shape`, async () => {
      const expected = [...EXPECTED[principal]].sort()
      assert.deepEqual(await listIds(scope), expected)
      assert.deepEqual(await idLookupIds(scope), expected)
      assert.deepEqual(await ftsIds(scope), expected)
      assert.deepEqual(await vectorIds(scope), expected)
      assert.deepEqual(await graphIds(scope), expected)
      assert.deepEqual(await provenanceIds(scope), expected)
      assert.deepEqual(await rollupIds(scope), expected)
    })
  }

  it('upgrades a staged financial migration ledger without replaying its DDL', async () => {
    const previousName = '537_association_order_financial_evidence.sql'
    const currentName = '552_association_order_financial_evidence.sql'
    const migrationsDir = fileURLToPath(new URL('../../../../packages/api/migrations', import.meta.url))
    // The suite's fresh bootstrap already created these columns through 552.
    // Represent the same schema installed by the old staged filename.
    await db.query('UPDATE public._migrations SET name = $1 WHERE name = $2', [previousName, currentName])
    try {
      assert.equal(await migratePglite(db, migrationsDir), 1)
      assert.equal(await migratePglite(db, migrationsDir), 0)
      const ledger = await db.query<{ name: string }>(
        'SELECT name FROM public._migrations WHERE name = ANY($1::text[]) ORDER BY name',
        [[previousName, currentName, '537_saved_views_scope_guc_casts.sql']],
      )
      assert.deepEqual(ledger.rows.map(row => row.name),
        [previousName, '537_saved_views_scope_guc_casts.sql', currentName])
    } finally {
      await db.query('INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [currentName])
      await db.query('DELETE FROM public._migrations WHERE name = $1', [previousName])
    }
  })

  it('reports an inaccessible id exactly like an unknown id and leaks no count', async () => {
    const scope = SCOPES.salesAtlas
    const predicate = buildAccessPredicate(access(scope), { alias: 'r', startIdx: 2 })
    const hidden = await db.query(
      `SELECT r.id FROM context_matrix_rows r
        WHERE r.id = $1 AND ${predicate.sql}`,
      [ROWS.accountingAtlas, ...predicate.params],
    )
    const unknown = await db.query(
      `SELECT r.id FROM context_matrix_rows r
        WHERE r.id = $1 AND ${predicate.sql}`,
      ['ffffffff-ffff-4fff-8fff-ffffffffffff', ...predicate.params],
    )
    assert.deepEqual(hidden.rows, unknown.rows)
    assert.deepEqual(hidden.rows, [])
  })

  it('proves owner/read-all still narrows through a Sales assistant and active Atlas', async () => {
    assert.deepEqual(await listIds(SCOPES.salesAtlas), EXPECTED.salesAtlas)
    assert.equal((await listIds(SCOPES.salesAtlas)).includes(ROWS.accountingAtlas), false)
    assert.equal((await listIds(SCOPES.salesAtlas)).includes(ROWS.salesBeacon), false)
    assert.equal((await listIds(SCOPES.salesAtlas)).includes(ROWS.salesAtlasBeacon), false)
  })
})

describe('[COMP:tasks/project-context] legacy Project-tag backfill', () => {
  it('creates stable Projects, consumes one tag, and is idempotent', async () => {
    const legacyDb = new PGlite({ extensions: { vector, pg_trgm } })
    await legacyDb.waitReady
    const migrationsDir = fileURLToPath(
      new URL('../../../../packages/api/migrations', import.meta.url),
    )

    try {
      await migratePglite(legacyDb, migrationsDir, {
        through: '474_project_scope_columns.sql',
      })
      await legacyDb.query(
        `INSERT INTO users (id, auth_provider, auth_provider_id)
         VALUES ($1, 'test', 'legacy-project-owner')`,
        [USER_ID],
      )
      await legacyDb.query(
        `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
         VALUES ($1, 'Legacy Project test', 'test', $2, false)`,
        [WORKSPACE_ID, USER_ID],
      )
      await legacyDb.query(
        `INSERT INTO tasks (workspace_id, title, tags, user_id, created_at)
         VALUES
           ($1, 'First legacy task', ARRAY['ops', 'project:Atlas', 'project:Beacon'], $2, '2026-01-01T00:00:00Z'),
           ($1, 'Second legacy task', ARRAY['project: atlas ', 'keep'], $2, '2026-01-02T00:00:00Z')`,
        [WORKSPACE_ID, USER_ID],
      )

      assert.equal(
        await migratePglite(legacyDb, migrationsDir, {
          through: '475_context_surface_bindings.sql',
        }),
        1,
      )

      const projects = await legacyDb.query<{
        id: string
        name: string
        normalized_name: string
      }>(
        `SELECT id, name, normalized_name
           FROM workspace_projects
          WHERE workspace_id = $1`,
        [WORKSPACE_ID],
      )
      assert.equal(projects.rows.length, 1)
      assert.equal(projects.rows[0].name, 'Atlas')
      assert.equal(projects.rows[0].normalized_name, 'atlas')

      const tasks = await legacyDb.query<{ project_ids: string[]; tags: string[] }>(
        `SELECT project_ids, tags FROM tasks
          WHERE workspace_id = $1
          ORDER BY created_at`,
        [WORKSPACE_ID],
      )
      assert.deepEqual(tasks.rows, [
        {
          project_ids: [projects.rows[0].id],
          tags: ['ops', 'project:Beacon'],
        },
        {
          project_ids: [projects.rows[0].id],
          tags: ['keep'],
        },
      ])
      assert.equal(
        await migratePglite(legacyDb, migrationsDir, {
          through: '475_context_surface_bindings.sql',
        }),
        0,
      )
      assert.deepEqual(
        (await legacyDb.query<{ id: string }>(
          'SELECT id FROM workspace_projects WHERE workspace_id = $1',
          [WORKSPACE_ID],
        )).rows,
        [{ id: projects.rows[0].id }],
      )
    } finally {
      await legacyDb.close()
    }
  })
})


describe('[COMP:api/context-scope-security-matrix] media lifetime upgrade',()=>{
  it('upgrades the preceding open schema through the real migrator and preserves existing membership',async()=>{
    const previous=new PGlite({extensions:{vector,pg_trgm}})
    const directory=fileURLToPath(new URL('../../../../packages/api/migrations',import.meta.url))
    try {
      await previous.waitReady
      await migratePglite(previous,directory,{through:'592_meeting_tag_state.sql'})
      await previous.query('INSERT INTO users(id,auth_provider_id) VALUES($1,$2)',[USER_ID,'media-upgrade-fixture'])
      await previous.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Media upgrade fixture',$2)",[WORKSPACE_ID,USER_ID])
      await previous.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[WORKSPACE_ID,USER_ID])
      assert.equal((await previous.query<{name:string|null}>("SELECT to_regprocedure('department_media_valid_for_ms(uuid)')::text AS name")).rows[0].name,null)
      assert.equal(await migratePglite(previous,directory,{through:'594_department_media_projection_lifetime.sql'}),1)
      assert.equal(await migratePglite(previous,directory,{through:'594_department_media_projection_lifetime.sql'}),0)
      await previous.query("SELECT set_config('app.current_user_id',$1,false)",[USER_ID])
      const ttl=(await previous.query<{ttl:number}>('SELECT department_media_valid_for_ms($1) AS ttl',[WORKSPACE_ID])).rows[0].ttl
      assert.ok(ttl>0&&ttl<=30000)
      assert.deepEqual((await previous.query<{role:string}>('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[WORKSPACE_ID,USER_ID])).rows,[{role:'owner'}])
    } finally {await previous.close()}
  })
})

describe('[COMP:api/context-scope-security-matrix] temporary preview upgrade',()=>{
  it('upgrades 594 cache rows through 595 and enforces current app-role membership and holding',async()=>{
    const previous=new PGlite({extensions:{vector,pg_trgm}})
    const directory=fileURLToPath(new URL('../../../../packages/api/migrations',import.meta.url))
    const sessionId='30000000-0000-4000-8000-000000000001'
    const fileId='40000000-0000-4000-8000-000000000001'
    try {
      await previous.waitReady
      await migratePglite(previous,directory,{through:'594_department_media_projection_lifetime.sql'})
      await previous.query('INSERT INTO users(id,auth_provider_id) VALUES($1,$2)',[USER_ID,'cache-upgrade-fixture'])
      await previous.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Cache upgrade fixture',$2)",[WORKSPACE_ID,USER_ID])
      await previous.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[WORKSPACE_ID,USER_ID])
      await previous.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Cache fixture',$2,$3,'standard')",[ASSISTANT_ID,WORKSPACE_ID,USER_ID])
      await previous.query("INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,status) VALUES($1,$2,$3,'web','web:cache-upgrade','idle')",[sessionId,ASSISTANT_ID,USER_ID])
      await previous.query("INSERT INTO file_cache(id,session_id,workspace_id,file_name,mime_type,content,original_content,size_bytes,expires_at) VALUES($1,$2,$3,'fixture.txt','text/plain','existing text','data:text/plain;base64,ZXhpc3RpbmcgdGV4dA==',13,now()+interval '1 day')",[fileId,sessionId,WORKSPACE_ID])
      const before=(await previous.query('SELECT content,original_content,compartments FROM file_cache WHERE id=$1',[fileId])).rows
      assert.equal(await migratePglite(previous,directory,{through:'595_file_cache_preview_scope.sql'}),1)
      assert.equal(await migratePglite(previous,directory,{through:'595_file_cache_preview_scope.sql'}),0)
      assert.deepEqual((await previous.query('SELECT content,original_content,compartments FROM file_cache WHERE id=$1',[fileId])).rows,before)
      assert.equal((await previous.query<{scope_held:boolean}>('SELECT scope_held FROM file_cache WHERE id=$1',[fileId])).rows[0].scope_held,false)
      // The schema dump leaves row_security=off for migration replay. Restore the
      // application setting before testing a role that must obey RLS.
      await previous.exec('SET row_security=on; CREATE ROLE cache_preview_fixture NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO cache_preview_fixture; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO cache_preview_fixture; SET ROLE cache_preview_fixture')
      await previous.query("SELECT set_config('app.current_user_id',$1,false)",[USER_ID])
      const role=(await previous.query<{rolsuper:boolean;rolbypassrls:boolean}>('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
      assert.deepEqual(role,{rolsuper:false,rolbypassrls:false})
      const read=async()=>(await previous.query('SELECT content FROM file_cache WHERE id=$1',[fileId])).rows
      assert.deepEqual(await read(),[{content:'existing text'}])
      await previous.exec('RESET ROLE')
      await previous.query('UPDATE file_cache SET scope_held=true WHERE id=$1',[fileId])
      await previous.exec('SET ROLE cache_preview_fixture')
      assert.deepEqual(await read(),[])
      await previous.exec('RESET ROLE')
      await previous.query('UPDATE file_cache SET scope_held=false WHERE id=$1',[fileId])
      await previous.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[WORKSPACE_ID,USER_ID])
      await previous.exec('SET ROLE cache_preview_fixture')
      assert.deepEqual(await read(),[])
      assert.deepEqual((await previous.query('DELETE FROM file_cache WHERE id=$1 RETURNING id',[fileId])).rows,[])
    } finally {await previous.close()}
  })
})
