/**
 * [COMP:api/doc-entity-store] Doc entity store — Phase 1 Batch 2.
 *
 * Mocks the pg client and verifies that the CRUD + query methods emit
 * the expected SQL shape + parameters, and that schema validation runs
 * at write time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Connection-level transaction mock (for `renameProperty`, which runs a
// multi-statement BEGIN/COMMIT on a single RLS-scoped connection — same
// shape as `crm.ts`). `clientQueries` records the statements in order so
// the transaction test can assert the schema-write + data-migration SQL.
const clientQueries: { text: string; values?: unknown[] }[] = []
let clientResponder:
  | ((text: string, values?: unknown[]) => { rows: unknown[]; rowCount: number })
  | null = null

const fakeClient = {
  query: vi.fn(async (text: string, values?: unknown[]) => {
    clientQueries.push({ text, values })
    return clientResponder
      ? clientResponder(text, values)
      : { rows: [], rowCount: 0 }
  }),
  release: vi.fn(),
}

const fakePool = {
  connect: vi.fn(async () => fakeClient),
}

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  // Two-role model: renameProperty is a workspace-schema (system) operation,
  // scoped by WHERE workspace_id → runs on the system pool (owner).
  getPool: () => fakePool,
  // `renameProperty`'s `finally` calls this; emulate the real helper's
  // ROLLBACK + release so the connection is released cleanly.
  rollbackAndRelease: async (client: { release: () => void }) => {
    client.release()
  },
}))

import { createDbDocEntityStore } from '../doc-entity-store.js'
import { queryWithRLS } from '../client.js'
import type {
  DocEntityInstance,
  DocEntityType,
  PropertyDef,
} from '@use-brian/core'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000003'
const USER_ID = '00000000-0000-0000-0000-000000000001'
const ENTITY_TYPE_ID = '00000000-0000-0000-0000-000000000010'
const ENTITY_ID = '00000000-0000-0000-0000-000000000020'

const SAMPLE_PROPERTIES: PropertyDef[] = [
  { name: 'title', config: { kind: 'text' }, required: true },
  { name: 'rating', config: { kind: 'number', format: 'decimal' } },
  {
    name: 'genre',
    config: {
      kind: 'select',
      options: [
        { id: 'g1', name: 'Drama' },
        { id: 'g2', name: 'Comedy' },
      ],
    },
  },
]

function entityTypeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ENTITY_TYPE_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Movie',
    icon: '🎬',
    properties: SAMPLE_PROPERTIES,
    schemaVersion: 1,
    createdAt: new Date('2026-05-27T00:00:00Z'),
    createdBy: USER_ID,
    ...overrides,
  }
}

function entityInstanceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ENTITY_ID,
    entityTypeId: ENTITY_TYPE_ID,
    workspaceId: WORKSPACE_ID,
    data: {
      title: { kind: 'text', value: 'Inception' },
      rating: { kind: 'number', value: 9.1 },
    },
    sourceApp: 'doc',
    createdAt: new Date('2026-05-27T00:00:00Z'),
    createdBy: USER_ID,
    lastEditedAt: new Date('2026-05-27T00:00:00Z'),
    lastEditedBy: USER_ID,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  clientQueries.length = 0
  clientResponder = null
})

const store = createDbDocEntityStore()

describe('[COMP:api/doc-entity-store] EntityType CRUD', () => {
  it('createEntityType inserts with default schemaVersion=1', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow()],
      rowCount: 1,
    } as never)

    const created = await store.createEntityType({
      workspaceId: WORKSPACE_ID,
      name: 'Movie',
      icon: '🎬',
      properties: SAMPLE_PROPERTIES,
      createdBy: USER_ID,
    })

    expect(created.id).toBe(ENTITY_TYPE_ID)
    expect(created.name).toBe('Movie')
    expect(created.icon).toBe('🎬')
    expect(created.schemaVersion).toBe(1)
    expect(created.properties).toEqual(SAMPLE_PROPERTIES)
    expect(created.createdAt).toBe('2026-05-27T00:00:00.000Z')

    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('INSERT INTO entity_types')
    expect(params[0]).toBe(WORKSPACE_ID)
    expect(params[1]).toBe('Movie')
    expect(params[2]).toBe('🎬')
    expect(JSON.parse(params[3] as string)).toEqual(SAMPLE_PROPERTIES)
    expect(params[4]).toBe(1)
    expect(params[5]).toBe(USER_ID)
  })

  it('createEntityType honors explicit schemaVersion', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow({ schemaVersion: 5 })],
      rowCount: 1,
    } as never)
    await store.createEntityType({
      workspaceId: WORKSPACE_ID,
      name: 'Movie',
      properties: SAMPLE_PROPERTIES,
      createdBy: USER_ID,
      schemaVersion: 5,
    })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params[4]).toBe(5)
  })

  it('createEntityType rejects an invalid property definition', async () => {
    await expect(
      store.createEntityType({
        workspaceId: WORKSPACE_ID,
        name: 'Bad',
        properties: [
          // Missing `options` on a `select` kind — should fail the
          // discriminated-union zod parse before any DB call.
          { name: 'bad', config: { kind: 'select' } as unknown as PropertyDef['config'] },
        ],
        createdBy: USER_ID,
      }),
    ).rejects.toThrow()
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('getEntityType returns the row', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow()],
      rowCount: 1,
    } as never)
    const t = await store.getEntityType(WORKSPACE_ID, ENTITY_TYPE_ID)
    expect(t?.id).toBe(ENTITY_TYPE_ID)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('SELECT')
    expect(sql).toContain('FROM entity_types')
    expect(params).toEqual([ENTITY_TYPE_ID, WORKSPACE_ID])
  })

  it('getEntityType returns null when missing', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getEntityType(WORKSPACE_ID, ENTITY_TYPE_ID)).toBeNull()
  })

  it('getEntityTypeByName uses the (workspace, name) UNIQUE constraint', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow()],
      rowCount: 1,
    } as never)
    const t = await store.getEntityTypeByName(WORKSPACE_ID, 'Movie')
    expect(t?.name).toBe('Movie')
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('workspace_id = $1 AND name = $2')
    expect(params).toEqual([WORKSPACE_ID, 'Movie'])
  })

  it('listEntityTypes returns all rows for the workspace', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow(), entityTypeRow({ id: 'other', name: 'Recipe' })],
      rowCount: 2,
    } as never)
    const list = await store.listEntityTypes(WORKSPACE_ID)
    expect(list).toHaveLength(2)
    expect(list[0].name).toBe('Movie')
  })

  it('updateEntityType bumps schema_version when properties change', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow({ schemaVersion: 2 })],
      rowCount: 1,
    } as never)
    const updated = await store.updateEntityType(WORKSPACE_ID, ENTITY_TYPE_ID, {
      properties: SAMPLE_PROPERTIES,
    })
    expect(updated.schemaVersion).toBe(2)
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('schema_version = schema_version + 1')
    expect(sql).toContain('properties =')
  })

  it('updateEntityType does NOT bump schema_version for name-only updates', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow({ name: 'Films' })],
      rowCount: 1,
    } as never)
    await store.updateEntityType(WORKSPACE_ID, ENTITY_TYPE_ID, {
      name: 'Films',
    })
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).not.toContain('schema_version =')
    expect(sql).toContain('name =')
  })

  it('updateEntityType with no patch returns the current row', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityTypeRow()],
      rowCount: 1,
    } as never)
    const t = await store.updateEntityType(WORKSPACE_ID, ENTITY_TYPE_ID, {})
    expect(t.id).toBe(ENTITY_TYPE_ID)
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    // No-op falls back to a plain SELECT.
    expect(sql).toContain('SELECT')
  })

  it('updateEntityType throws when row is missing', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await expect(
      store.updateEntityType(WORKSPACE_ID, ENTITY_TYPE_ID, { name: 'X' }),
    ).rejects.toThrow(/not found/)
  })

  it('deleteEntityType emits the DELETE (cascade handled by FK)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.deleteEntityType(WORKSPACE_ID, ENTITY_TYPE_ID)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('DELETE FROM entity_types')
    expect(params).toEqual([ENTITY_TYPE_ID, WORKSPACE_ID])
  })
})

describe('[COMP:api/doc-entity-store] renameProperty', () => {
  // Responder that returns the current type on the initial SELECT and the
  // renamed type on the UPDATE ... RETURNING. Other statements (BEGIN, SET,
  // the instance UPDATE, COMMIT) return empty.
  function respondWithRename(current = entityTypeRow()) {
    clientResponder = (text: string) => {
      const t = text.trim()
      if (t.startsWith('SELECT')) {
        return { rows: [current], rowCount: 1 }
      }
      if (t.startsWith('UPDATE entity_types')) {
        // Schema row after the rename: prep-mirror the renamed property.
        const props = (current.properties as PropertyDef[]).map((p) =>
          p.name === 'rating' ? { ...p, name: 'score' } : p,
        )
        return {
          rows: [
            entityTypeRow({
              properties: props,
              schemaVersion: (current.schemaVersion as number) + 1,
            }),
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    }
  }

  it('renames the schema property and preserves its config', async () => {
    respondWithRename()
    const updated = await store.renameProperty(
      WORKSPACE_ID,
      ENTITY_TYPE_ID,
      'rating',
      'score',
    )
    const names = updated.properties.map((p) => p.name)
    expect(names).toEqual(['title', 'score', 'genre'])
    // Config carried over untouched (still a decimal number).
    const renamed = updated.properties.find((p) => p.name === 'score')
    expect(renamed?.config).toEqual({ kind: 'number', format: 'decimal' })
  })

  it('bumps schema_version on the entity_types UPDATE', async () => {
    respondWithRename()
    const updated = await store.renameProperty(
      WORKSPACE_ID,
      ENTITY_TYPE_ID,
      'rating',
      'score',
    )
    expect(updated.schemaVersion).toBe(2)
    const typeUpdate = clientQueries.find((q) =>
      q.text.trim().startsWith('UPDATE entity_types'),
    )
    expect(typeUpdate!.text).toContain('schema_version = schema_version + 1')
    expect(typeUpdate!.text).toContain('properties = $1::jsonb')
    // The persisted property list carries the new name.
    const writtenProps = JSON.parse(typeUpdate!.values![0] as string)
    expect(writtenProps.map((p: PropertyDef) => p.name)).toEqual([
      'title',
      'score',
      'genre',
    ])
  })

  it('data-migrates instance rows: renames the JSONB key, scoped + guarded', async () => {
    respondWithRename()
    await store.renameProperty(WORKSPACE_ID, ENTITY_TYPE_ID, 'rating', 'score')
    const instanceUpdate = clientQueries.find((q) =>
      q.text.trim().startsWith('UPDATE entity_instances'),
    )
    expect(instanceUpdate).toBeDefined()
    // Key-rename expression: drop old key, merge in new key with old value.
    expect(instanceUpdate!.text).toContain(
      '(data - $1) || jsonb_build_object($2, data -> $1)',
    )
    // Only touches rows of this type, in this workspace, that HAVE the key
    // — rows without the key are left untouched by the `data ? $1` guard.
    expect(instanceUpdate!.text).toContain('entity_type_id = $3')
    expect(instanceUpdate!.text).toContain('workspace_id = $4')
    expect(instanceUpdate!.text).toContain('data ? $1')
    // Key names are bind params (no SQL injection), not interpolated.
    expect(instanceUpdate!.values).toEqual([
      'rating',
      'score',
      ENTITY_TYPE_ID,
      WORKSPACE_ID,
    ])
  })

  it('wraps both writes in one transaction (BEGIN ... COMMIT)', async () => {
    respondWithRename()
    await store.renameProperty(WORKSPACE_ID, ENTITY_TYPE_ID, 'rating', 'score')
    const texts = clientQueries.map((q) => q.text.trim())
    expect(texts).toContain('BEGIN')
    expect(texts).toContain('COMMIT')
    // System operation on the owner pool: no GUC scoping at all (no
    // system_bypass, and no current_user_id — scoped by WHERE workspace_id).
    expect(texts.some((t) => t.includes('system_bypass'))).toBe(false)
    expect(texts.some((t) => t.includes('app.current_user_id'))).toBe(false)
    // The schema UPDATE comes before the data-migration UPDATE.
    const typeIdx = texts.findIndex((t) => t.startsWith('UPDATE entity_types'))
    const instIdx = texts.findIndex((t) =>
      t.startsWith('UPDATE entity_instances'),
    )
    expect(typeIdx).toBeGreaterThanOrEqual(0)
    expect(instIdx).toBeGreaterThan(typeIdx)
    expect(fakeClient.release).toHaveBeenCalled()
  })

  it('ROLLBACKs and throws when the entity type is missing', async () => {
    clientResponder = (text: string) =>
      text.trim().startsWith('SELECT')
        ? { rows: [], rowCount: 0 }
        : { rows: [], rowCount: 0 }
    await expect(
      store.renameProperty(WORKSPACE_ID, ENTITY_TYPE_ID, 'rating', 'score'),
    ).rejects.toThrow(/not found/)
    expect(clientQueries.map((q) => q.text.trim())).toContain('ROLLBACK')
    // Never wrote anything.
    expect(
      clientQueries.some((q) => q.text.trim().startsWith('UPDATE')),
    ).toBe(false)
  })

  it('ROLLBACKs and throws when oldName is absent from the schema', async () => {
    respondWithRename()
    await expect(
      store.renameProperty(WORKSPACE_ID, ENTITY_TYPE_ID, 'nonexistent', 'score'),
    ).rejects.toThrow(/not found/)
    expect(clientQueries.map((q) => q.text.trim())).toContain('ROLLBACK')
    expect(
      clientQueries.some((q) => q.text.trim().startsWith('UPDATE')),
    ).toBe(false)
  })

  it('ROLLBACKs and throws when newName collides with another property', async () => {
    respondWithRename()
    await expect(
      store.renameProperty(WORKSPACE_ID, ENTITY_TYPE_ID, 'rating', 'title'),
    ).rejects.toThrow(/already exists/)
    expect(clientQueries.map((q) => q.text.trim())).toContain('ROLLBACK')
    expect(
      clientQueries.some((q) => q.text.trim().startsWith('UPDATE')),
    ).toBe(false)
  })
})

describe('[COMP:api/doc-entity-store] EntityInstance CRUD', () => {
  it('createEntity inserts with the JSONB data column', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityInstanceRow()],
      rowCount: 1,
    } as never)

    const created = await store.createEntity({
      entityTypeId: ENTITY_TYPE_ID,
      workspaceId: WORKSPACE_ID,
      data: {
        title: { kind: 'text', value: 'Inception' },
        rating: { kind: 'number', value: 9.1 },
      },
      sourceApp: 'doc',
      createdBy: USER_ID,
      lastEditedBy: USER_ID,
    })

    expect(created.id).toBe(ENTITY_ID)
    expect(created.data.title).toEqual({ kind: 'text', value: 'Inception' })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('INSERT INTO entity_instances')
    expect(params[0]).toBe(ENTITY_TYPE_ID)
    expect(params[1]).toBe(WORKSPACE_ID)
    expect(JSON.parse(params[2] as string)).toEqual({
      title: { kind: 'text', value: 'Inception' },
      rating: { kind: 'number', value: 9.1 },
    })
    expect(params[3]).toBe('doc')
  })

  it('createEntity rejects an invalid cell discriminator', async () => {
    await expect(
      store.createEntity({
        entityTypeId: ENTITY_TYPE_ID,
        workspaceId: WORKSPACE_ID,
        data: {
          rating: { kind: 'number', value: 'not-a-number' } as unknown as DocEntityInstance['data'][string],
        },
        sourceApp: 'doc',
        createdBy: USER_ID,
        lastEditedBy: USER_ID,
      }),
    ).rejects.toThrow()
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('getEntity returns the row', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityInstanceRow()],
      rowCount: 1,
    } as never)
    const e = await store.getEntity(WORKSPACE_ID, ENTITY_ID)
    expect(e?.id).toBe(ENTITY_ID)
  })

  it('getEntity returns null when missing', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getEntity(WORKSPACE_ID, ENTITY_ID)).toBeNull()
  })

  it('updateEntity emits jsonb cast + bumps last_edited_at', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityInstanceRow()],
      rowCount: 1,
    } as never)
    await store.updateEntity(WORKSPACE_ID, ENTITY_ID, {
      data: { title: { kind: 'text', value: 'Dune' } },
      lastEditedBy: USER_ID,
    })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('UPDATE entity_instances')
    expect(sql).toContain('data = $1::jsonb')
    expect(sql).toContain('last_edited_at = now()')
    expect(JSON.parse(params[0] as string)).toEqual({
      title: { kind: 'text', value: 'Dune' },
    })
  })

  it('updateEntity throws when row is missing', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await expect(
      store.updateEntity(WORKSPACE_ID, ENTITY_ID, { lastEditedBy: USER_ID }),
    ).rejects.toThrow(/not found/)
  })

  it('deleteEntity emits the DELETE scoped to workspace', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    await store.deleteEntity(WORKSPACE_ID, ENTITY_ID)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('DELETE FROM entity_instances')
    expect(params).toEqual([ENTITY_ID, WORKSPACE_ID])
  })
})

describe('[COMP:api/doc-entity-store] queryEntities filters', () => {
  beforeEach(() => {
    mockQueryWithRLS.mockResolvedValue({
      rows: [],
      rowCount: 0,
    } as never)
  })

  it('always scopes by workspace + entity type', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('workspace_id = $1')
    expect(sql).toContain('entity_type_id = $2')
    expect(params[0]).toBe(WORKSPACE_ID)
    expect(params[1]).toBe(ENTITY_TYPE_ID)
  })

  it('eq with a number casts to ::numeric', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
      { field: 'rating', op: 'eq', value: 9.1 },
    ])
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("(data->>'rating')::numeric = $3")
    expect(params[2]).toBe(9.1)
  })

  it('eq with a string compares text', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
      { field: 'title', op: 'eq', value: 'Inception' },
    ])
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("data->>'title' = $3")
    expect(params[2]).toBe('Inception')
  })

  it('neq', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
      { field: 'rating', op: 'neq', value: 0 },
    ])
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("(data->>'rating')::numeric <> $3")
  })

  it('gt / gte / lt / lte', async () => {
    for (const [op, sym] of [
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<='],
    ] as const) {
      mockQueryWithRLS.mockClear()
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
        { field: 'rating', op, value: 5 },
      ])
      const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain(`(data->>'rating')::numeric ${sym}`)
    }
  })

  it('in uses ANY(text[])', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
      { field: 'genre', op: 'in', value: ['g1', 'g2'] },
    ])
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("data->>'genre' = ANY($3::text[])")
    expect(params[2]).toEqual(['g1', 'g2'])
  })

  it('contains uses ILIKE substring match', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
      { field: 'title', op: 'contains', value: 'inc' },
    ])
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("data->>'title' ILIKE $3")
    expect(params[2]).toBe('%inc%')
  })

  it('rejects an invalid field name (defense against SQL injection)', async () => {
    await expect(
      store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
        { field: "title'; DROP TABLE entity_instances; --", op: 'eq', value: 'x' },
      ]),
    ).rejects.toThrow(/Invalid filter/)
  })

  it('multiple filters AND together', async () => {
    await store.queryEntities(WORKSPACE_ID, ENTITY_TYPE_ID, [
      { field: 'rating', op: 'gte', value: 5 },
      { field: 'title', op: 'contains', value: 'in' },
    ])
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql.match(/ AND /g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('honors sort direction', async () => {
    await store.queryEntities(
      WORKSPACE_ID,
      ENTITY_TYPE_ID,
      undefined,
      [{ field: 'rating', direction: 'asc' }],
    )
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("ORDER BY data->>'rating' ASC")
  })

  it('returns nextCursor when more rows are available', async () => {
    const rows: ReturnType<typeof entityInstanceRow>[] = []
    // Limit = 2, store fetches 3 to detect "more available" → returns 2 rows + cursor.
    for (let i = 0; i < 3; i++) {
      rows.push(
        entityInstanceRow({
          id: `id-${i}`,
          createdAt: new Date(`2026-05-${10 + i}T00:00:00Z`),
        }),
      )
    }
    mockQueryWithRLS.mockReset()
    mockQueryWithRLS.mockResolvedValueOnce({
      rows,
      rowCount: 3,
    } as never)
    const result = await store.queryEntities(
      WORKSPACE_ID,
      ENTITY_TYPE_ID,
      undefined,
      undefined,
      2,
    )
    expect(result.rows).toHaveLength(2)
    expect(result.nextCursor).toBeDefined()
    // Cursor encodes the LAST returned row's (createdAt, id) — `id-1`.
    const decoded = Buffer.from(result.nextCursor!, 'base64url').toString('utf8')
    expect(decoded).toContain('id-1')
  })

  it('round-trips a cursor into a WHERE predicate', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const cursor = Buffer.from(
      '2026-05-27T00:00:00.000Z|id-1',
      'utf8',
    ).toString('base64url')
    await store.queryEntities(
      WORKSPACE_ID,
      ENTITY_TYPE_ID,
      undefined,
      undefined,
      10,
      cursor,
    )
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('(created_at, id) <')
    // The createdAt + id come AFTER workspaceId + entityTypeId.
    expect(params).toEqual(
      expect.arrayContaining(['2026-05-27T00:00:00.000Z', 'id-1']),
    )
  })

  it('omits nextCursor when fewer rows than limit are returned', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [entityInstanceRow()],
      rowCount: 1,
    } as never)
    const result = await store.queryEntities(
      WORKSPACE_ID,
      ENTITY_TYPE_ID,
      undefined,
      undefined,
      10,
    )
    expect(result.rows).toHaveLength(1)
    expect(result.nextCursor).toBeUndefined()
  })
})

describe('[COMP:api/doc-entity-store] RLS routing', () => {
  it('every read/write goes through queryWithRLS with the workspace context', async () => {
    mockQueryWithRLS.mockResolvedValue({
      rows: [entityTypeRow()],
      rowCount: 1,
    } as never)
    await store.getEntityType(WORKSPACE_ID, ENTITY_TYPE_ID)
    await store.listEntityTypes(WORKSPACE_ID)
    await store.deleteEntityType(WORKSPACE_ID, ENTITY_TYPE_ID)
    // Each call carries the workspaceId as the RLS userId; the RLS
    // policy resolves workspace membership for the acting principal.
    for (const call of mockQueryWithRLS.mock.calls) {
      expect(call[0]).toBe(WORKSPACE_ID)
    }
  })
})
