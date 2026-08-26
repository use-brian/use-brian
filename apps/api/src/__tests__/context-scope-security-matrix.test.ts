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
