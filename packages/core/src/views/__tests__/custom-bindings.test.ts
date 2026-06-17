/**
 * [COMP:views/bindings] buildPayload — custom (user-defined) entity tables.
 *
 * Phase B: a `{ entity: 'custom', entityTypeId }` binding renders an
 * `entity_types` row's instances as a table whose columns ARE the type's
 * properties. Verifies the property→column mapping (kind / options /
 * statusGroups), the 16-kind cell→widget mapping, the `columns` subset, and the
 * graceful empty-table fallbacks (missing type / no store wired).
 */

import { describe, expect, it } from 'vitest'
import { buildPayload, type BindingDeps } from '../bindings.js'
import type {
  EntityInstance,
  EntityStore,
  EntityType,
} from '../../entities/doc-types.js'
import type { TableWidget } from '../a2ui.js'

const ENTITY_TYPE: EntityType = {
  id: 'et1',
  workspaceId: 'ws1',
  name: 'Movie',
  properties: [
    { name: 'title', config: { kind: 'text' } },
    { name: 'rating', label: 'Rating', config: { kind: 'number', format: 'decimal' } },
    {
      name: 'genre',
      config: {
        kind: 'select',
        options: [
          { id: 'g_scifi', name: 'Sci-Fi' },
          { id: 'g_drama', name: 'Drama' },
        ],
      },
    },
    {
      name: 'tags',
      config: {
        kind: 'multi_select',
        options: [
          { id: 't_a', name: 'A24' },
          { id: 't_classic', name: 'Classic' },
        ],
      },
    },
    {
      name: 'state',
      config: {
        kind: 'status',
        groups: [
          { id: 'pending', label: 'To watch', options: [{ id: 's_queued', name: 'Queued' }] },
          { id: 'done', label: 'Watched', options: [{ id: 's_seen', name: 'Seen' }] },
        ],
      },
    },
    { name: 'watched_on', config: { kind: 'date' } },
    { name: 'owner', config: { kind: 'person' } },
    { name: 'fav', config: { kind: 'checkbox' } },
    { name: 'created', config: { kind: 'created_time' } },
  ],
  schemaVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'u1',
}

const INSTANCE: EntityInstance = {
  id: 'i1',
  entityTypeId: 'et1',
  workspaceId: 'ws1',
  data: {
    title: { kind: 'text', value: 'Dune' },
    rating: { kind: 'number', value: 9.1 },
    genre: { kind: 'select', value: 'g_scifi' },
    tags: { kind: 'multi_select', value: ['t_a', 't_classic'] },
    state: { kind: 'status', value: 's_seen' },
    watched_on: { kind: 'date', value: { start: '2026-02-02T00:00:00.000Z' } },
    owner: { kind: 'person', value: 'u_jack' },
    fav: { kind: 'checkbox', value: true },
  },
  sourceApp: 'doc',
  createdAt: '2026-01-05T00:00:00.000Z',
  createdBy: 'u1',
  lastEditedAt: '2026-01-06T00:00:00.000Z',
  lastEditedBy: 'u1',
}

function mockStore(type: EntityType | null, instances: EntityInstance[]): EntityStore {
  return {
    getEntityType: async () => type,
    queryEntities: async () => ({ rows: instances }),
    // The custom read path never calls these:
    createEntityType: async () => { throw new Error('unused') },
    getEntityTypeByName: async () => null,
    listEntityTypes: async () => [],
    updateEntityType: async () => { throw new Error('unused') },
    renameProperty: async () => { throw new Error('unused') },
    deleteEntityType: async () => {},
    createEntity: async () => { throw new Error('unused') },
    getEntity: async () => null,
    updateEntity: async () => { throw new Error('unused') },
    deleteEntity: async () => {},
  } as EntityStore
}

function deps(store: EntityStore | undefined): BindingDeps {
  return {
    taskStore: {} as never,
    crmStore: {} as never,
    workflowRunStore: {} as never,
    workspaceDirectory: {
      batchGet: async (_ws: string, ids: string[]) =>
        new Map(ids.map((id) => [id, { id, name: id === 'u_jack' ? 'Jack' : id }])),
    } as never,
    userId: 'u1',
    workspaceId: 'ws1',
    docEntityStore: store,
  }
}

describe('[COMP:views/bindings] custom entity table', () => {
  it('maps properties to columns (kind + options + statusGroups)', async () => {
    const payload = await buildPayload(
      { entity: 'custom', entityTypeId: 'et1', viewType: 'table' },
      deps(mockStore(ENTITY_TYPE, [INSTANCE])),
    )
    const t = payload.root as TableWidget
    expect(t.type).toBe('table')
    const byField = new Map(t.columns.map((c) => [c.field, c]))
    expect(byField.get('title')?.kind).toBe('text')
    expect(byField.get('rating')?.header).toBe('Rating')
    expect(byField.get('rating')?.kind).toBe('number')
    expect(byField.get('genre')?.kind).toBe('select')
    expect(byField.get('genre')?.options).toEqual(['g_scifi', 'g_drama'])
    // multi_select projects to the renderer's `tags` kind.
    expect(byField.get('tags')?.kind).toBe('tags')
    expect(byField.get('state')?.kind).toBe('status')
    expect(byField.get('state')?.statusGroups?.length).toBe(2)
    expect(byField.get('created')?.kind).toBe('created_time')
  })

  it('maps cell values to the renderer widgets', async () => {
    const payload = await buildPayload(
      { entity: 'custom', entityTypeId: 'et1', viewType: 'table' },
      deps(mockStore(ENTITY_TYPE, [INSTANCE])),
    )
    const row = (payload.root as TableWidget).rows[0]
    expect(row.id).toBe('i1')
    expect(row.title).toBe('Dune')
    expect(row.rating).toEqual({ type: 'number', value: 9.1, format: 'plain' })
    expect(row.genre).toMatchObject({ type: 'badge', text: 'Sci-Fi' })
    expect(row.tags).toMatchObject({ type: 'container', direction: 'row' })
    expect(row.state).toMatchObject({ type: 'status', optionId: 's_seen', groupId: 'done', label: 'Seen' })
    expect(row.owner).toMatchObject({ type: 'person', id: 'u_jack', name: 'Jack' })
    expect(row.fav).toBe('✓')
    // Auto-stamp: created_time reads the instance row, not a data cell.
    expect(row.created).toMatchObject({ type: 'date', format: 'datetime' })
  })

  it('honors a columns subset', async () => {
    const payload = await buildPayload(
      { entity: 'custom', entityTypeId: 'et1', viewType: 'table', columns: ['title', 'rating'] },
      deps(mockStore(ENTITY_TYPE, [INSTANCE])),
    )
    expect((payload.root as TableWidget).columns.map((c) => c.field)).toEqual(['title', 'rating'])
  })

  it('renders an empty table when the type is missing or no store is wired', async () => {
    const missing = await buildPayload(
      { entity: 'custom', entityTypeId: 'nope', viewType: 'table' },
      deps(mockStore(null, [])),
    )
    expect((missing.root as TableWidget).rows).toEqual([])
    const noStore = await buildPayload(
      { entity: 'custom', entityTypeId: 'et1', viewType: 'table' },
      deps(undefined),
    )
    expect((noStore.root as TableWidget).columns).toEqual([])
  })
})
