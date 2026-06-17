/**
 * [COMP:entities/doc-tools] Doc v1 — chat tool builders for the
 * user-defined entity layer. Eight tools; tests cover Zod-input
 * validation, built-in vs user-defined dispatch, and store pass-through.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createDocEntityTools,
  createListEntityTypesTool,
  type EntityToolDeps,
} from '../doc-tools.js'
import {
  getBuiltInEntityType,
  listBuiltInEntityTypes,
} from '../doc-built-ins.js'
import type {
  CellValue,
  EntityFilter,
  EntityInstance,
  EntitySort,
  EntityStore,
  EntityType,
  PropertyDef,
} from '../doc-types.js'
import type { ToolContext } from '../../tools/types.js'

// ── Fixtures ─────────────────────────────────────────────────────────

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = 'user-1'
const USER_TYPE_ID = '11111111-1111-4111-8111-111111111111'
const USER_TYPE_ID_2 = '22222222-2222-4222-8222-222222222222'
const ENTITY_ID = '33333333-3333-4333-8333-333333333333'

const ctx: ToolContext = {
  userId: USER_ID,
  assistantId: 'asst-1',
  sessionId: 'sess-1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'web-1',
  workspaceId: WORKSPACE_ID,
  abortSignal: new AbortController().signal,
}

const RECIPE_PROPERTIES: PropertyDef[] = [
  { name: 'title', label: 'Title', config: { kind: 'text' }, required: true },
  { name: 'prep_time', label: 'Prep time', config: { kind: 'number' } },
]

function makeRecipeType(): EntityType {
  return {
    id: USER_TYPE_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Recipe',
    icon: 'utensils',
    properties: RECIPE_PROPERTIES,
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: USER_ID,
  }
}

function makeRecipeInstance(
  overrides: Partial<EntityInstance> = {},
): EntityInstance {
  return {
    id: ENTITY_ID,
    entityTypeId: USER_TYPE_ID,
    workspaceId: WORKSPACE_ID,
    data: {
      title: { kind: 'text', value: 'Bolognese' },
      prep_time: { kind: 'number', value: 30 },
    },
    sourceApp: 'chat',
    createdAt: '2026-05-01T00:00:00.000Z',
    createdBy: USER_ID,
    lastEditedAt: '2026-05-01T00:00:00.000Z',
    lastEditedBy: USER_ID,
    ...overrides,
  }
}

// ── Fake store ───────────────────────────────────────────────────────

type FakeStore = EntityStore & {
  calls: {
    createEntityType: Array<Parameters<EntityStore['createEntityType']>[0]>
    getEntityType: Array<{ workspaceId: string; id: string }>
    listEntityTypes: Array<{ workspaceId: string }>
    updateEntityType: Array<{
      workspaceId: string
      id: string
      patch: Parameters<EntityStore['updateEntityType']>[2]
    }>
    renameProperty: Array<{
      workspaceId: string
      entityTypeId: string
      oldName: string
      newName: string
    }>
    createEntity: Array<Parameters<EntityStore['createEntity']>[0]>
    getEntity: Array<{ workspaceId: string; id: string }>
    updateEntity: Array<{
      workspaceId: string
      id: string
      patch: Parameters<EntityStore['updateEntity']>[2]
    }>
    deleteEntity: Array<{ workspaceId: string; id: string }>
    queryEntities: Array<{
      workspaceId: string
      entityTypeId: string
      filters?: EntityFilter[]
      sort?: EntitySort[]
      limit?: number
      cursor?: string
    }>
  }
}

function makeFakeStore(seed?: {
  types?: EntityType[]
  entities?: EntityInstance[]
  queryResult?: { rows: EntityInstance[]; nextCursor?: string }
}): FakeStore {
  const types = new Map<string, EntityType>()
  const entities = new Map<string, EntityInstance>()
  for (const t of seed?.types ?? []) types.set(t.id, t)
  for (const e of seed?.entities ?? []) entities.set(e.id, e)

  const calls: FakeStore['calls'] = {
    createEntityType: [],
    getEntityType: [],
    listEntityTypes: [],
    updateEntityType: [],
    renameProperty: [],
    createEntity: [],
    getEntity: [],
    updateEntity: [],
    deleteEntity: [],
    queryEntities: [],
  }

  let nextId = 1
  const mintId = () =>
    `aaaaaaaa-aaaa-4aaa-8aaa-${String(nextId++).padStart(12, '0')}`

  const store: FakeStore = {
    calls,
    async createEntityType(input) {
      calls.createEntityType.push(input)
      const created: EntityType = {
        id: mintId(),
        workspaceId: input.workspaceId,
        name: input.name,
        icon: input.icon,
        properties: input.properties,
        schemaVersion: input.schemaVersion ?? 1,
        createdAt: '2026-05-01T00:00:00.000Z',
        createdBy: input.createdBy,
      }
      types.set(created.id, created)
      return created
    },
    async getEntityType(workspaceId, id) {
      calls.getEntityType.push({ workspaceId, id })
      const t = types.get(id)
      return t && t.workspaceId === workspaceId ? t : null
    },
    async getEntityTypeByName(workspaceId, name) {
      for (const t of types.values()) {
        if (t.workspaceId === workspaceId && t.name === name) return t
      }
      return null
    },
    async listEntityTypes(workspaceId) {
      calls.listEntityTypes.push({ workspaceId })
      return Array.from(types.values()).filter(
        t => t.workspaceId === workspaceId,
      )
    },
    async updateEntityType(workspaceId, id, patch) {
      calls.updateEntityType.push({ workspaceId, id, patch })
      const existing = types.get(id)
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new Error('not found')
      }
      const updated: EntityType = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
        ...(patch.properties !== undefined
          ? { properties: patch.properties }
          : {}),
        schemaVersion: existing.schemaVersion + 1,
      }
      types.set(id, updated)
      return updated
    },
    async renameProperty(workspaceId, entityTypeId, oldName, newName) {
      calls.renameProperty.push({ workspaceId, entityTypeId, oldName, newName })
      const existing = types.get(entityTypeId)
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new Error('not found')
      }
      const updated: EntityType = {
        ...existing,
        properties: existing.properties.map(p =>
          p.name === oldName ? { ...p, name: newName } : p,
        ),
        schemaVersion: existing.schemaVersion + 1,
      }
      types.set(entityTypeId, updated)
      // Data-migrate seeded rows so the fake mirrors the store contract.
      for (const [id, e] of entities) {
        if (
          e.workspaceId === workspaceId &&
          e.entityTypeId === entityTypeId &&
          oldName in e.data
        ) {
          const { [oldName]: moved, ...rest } = e.data
          entities.set(id, { ...e, data: { ...rest, [newName]: moved } })
        }
      }
      return updated
    },
    async deleteEntityType(workspaceId, id) {
      const existing = types.get(id)
      if (existing && existing.workspaceId === workspaceId) types.delete(id)
    },
    async createEntity(input) {
      calls.createEntity.push(input)
      const created: EntityInstance = {
        id: mintId(),
        ...input,
        createdAt: '2026-05-01T00:00:00.000Z',
        lastEditedAt: '2026-05-01T00:00:00.000Z',
      }
      entities.set(created.id, created)
      return created
    },
    async getEntity(workspaceId, id) {
      calls.getEntity.push({ workspaceId, id })
      const e = entities.get(id)
      return e && e.workspaceId === workspaceId ? e : null
    },
    async updateEntity(workspaceId, id, patch) {
      calls.updateEntity.push({ workspaceId, id, patch })
      const existing = entities.get(id)
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new Error('not found')
      }
      const updated: EntityInstance = {
        ...existing,
        ...(patch.data !== undefined ? { data: patch.data } : {}),
        ...(patch.lastEditedBy !== undefined
          ? { lastEditedBy: patch.lastEditedBy }
          : {}),
        lastEditedAt: '2026-05-02T00:00:00.000Z',
      }
      entities.set(id, updated)
      return updated
    },
    async deleteEntity(workspaceId, id) {
      calls.deleteEntity.push({ workspaceId, id })
      const existing = entities.get(id)
      if (!existing || existing.workspaceId !== workspaceId) {
        throw new Error('not found')
      }
      entities.delete(id)
    },
    async queryEntities(workspaceId, entityTypeId, filters, sort, limit, cursor) {
      calls.queryEntities.push({
        workspaceId,
        entityTypeId,
        filters,
        sort,
        limit,
        cursor,
      })
      return (
        seed?.queryResult ?? {
          rows: Array.from(entities.values()).filter(
            e =>
              e.workspaceId === workspaceId && e.entityTypeId === entityTypeId,
          ),
        }
      )
    },
  }
  return store
}

function makeDeps(
  overrides: Partial<EntityToolDeps> = {},
): EntityToolDeps & { store: FakeStore } {
  const store = (overrides.store as FakeStore | undefined) ?? makeFakeStore()
  const { store: _ignored, ...rest } = overrides
  return {
    store,
    workspaceId: WORKSPACE_ID,
    currentUserId: USER_ID,
    listBuiltInEntityTypes:
      overrides.listBuiltInEntityTypes ?? listBuiltInEntityTypes,
    ...rest,
  } as EntityToolDeps & { store: FakeStore }
}

// ── listEntityTypes ──────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] listEntityTypes', () => {
  it('merges built-ins (first) with user-defined types', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { listEntityTypes } = createDocEntityTools(deps)
    const result = await listEntityTypes.execute(
      { workspaceId: WORKSPACE_ID },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const data = result.data as { types: EntityType[] }
    expect(data.types.length).toBe(6) // 5 built-ins + 1 user-defined
    // Built-ins come first.
    expect(data.types[0].id).toBe('builtin:task')
    expect(data.types[1].id).toBe('builtin:contact')
    expect(data.types[2].id).toBe('builtin:company')
    expect(data.types[3].id).toBe('builtin:deal')
    expect(data.types[4].id).toBe('builtin:workflow_run')
    // User-defined last.
    expect(data.types[5].id).toBe(USER_TYPE_ID)
  })

  it('returns only built-ins when there are no user-defined types', async () => {
    const deps = makeDeps()
    const { listEntityTypes } = createDocEntityTools(deps)
    const result = await listEntityTypes.execute(
      { workspaceId: WORKSPACE_ID },
      ctx,
    )
    const data = result.data as { types: EntityType[] }
    expect(data.types.length).toBe(5)
  })

  it('is read-only and concurrency-safe', () => {
    const { listEntityTypes } = createDocEntityTools(makeDeps())
    expect(listEntityTypes.isReadOnly).toBe(true)
    expect(listEntityTypes.isConcurrencySafe).toBe(true)
  })

  it('rejects missing workspaceId at the Zod layer', () => {
    const { listEntityTypes } = createDocEntityTools(makeDeps())
    const parsed = listEntityTypes.inputSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  it('uses the injected listBuiltInEntityTypes (so callers can pin a fixed roster)', async () => {
    const onlyTask = vi.fn((workspaceId: string) => [
      getBuiltInEntityType(workspaceId, 'task'),
    ])
    const deps = makeDeps({ listBuiltInEntityTypes: onlyTask })
    const tool = createListEntityTypesTool(deps)
    const result = await tool.execute({ workspaceId: WORKSPACE_ID }, ctx)
    const data = result.data as { types: EntityType[] }
    expect(onlyTask).toHaveBeenCalledWith(WORKSPACE_ID)
    expect(data.types.length).toBe(1)
  })
})

// ── createEntityType ─────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] createEntityType', () => {
  it('writes through to store.createEntityType with currentUserId', async () => {
    const deps = makeDeps()
    const { createEntityType } = createDocEntityTools(deps)
    const result = await createEntityType.execute(
      {
        workspaceId: WORKSPACE_ID,
        name: 'Recipe',
        icon: 'utensils',
        properties: RECIPE_PROPERTIES,
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(deps.store.calls.createEntityType).toHaveLength(1)
    const args = deps.store.calls.createEntityType[0]
    expect(args.name).toBe('Recipe')
    expect(args.icon).toBe('utensils')
    expect(args.createdBy).toBe(USER_ID)
    expect(args.properties).toHaveLength(2)
  })

  it('returns the persisted entityType', async () => {
    const deps = makeDeps()
    const { createEntityType } = createDocEntityTools(deps)
    const result = await createEntityType.execute(
      {
        workspaceId: WORKSPACE_ID,
        name: 'Movie',
        properties: [
          { name: 'title', config: { kind: 'text' }, required: true },
        ],
      },
      ctx,
    )
    const data = result.data as { entityType: EntityType }
    expect(data.entityType.name).toBe('Movie')
    expect(data.entityType.schemaVersion).toBe(1)
    expect(data.entityType.id).toMatch(/^aaaaaaaa-/)
  })

  it('rejects an empty properties array at the Zod layer', () => {
    const { createEntityType } = createDocEntityTools(makeDeps())
    const parsed = createEntityType.inputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      name: 'Recipe',
      properties: [],
    })
    expect(parsed.success).toBe(false)
  })
})

// ── addProperty ──────────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] addProperty', () => {
  it('appends the property to the existing list', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { addProperty } = createDocEntityTools(deps)
    const newProp: PropertyDef = { name: 'photo', config: { kind: 'files' } }
    const result = await addProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        property: newProp,
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const data = result.data as { entityType: EntityType }
    expect(data.entityType.properties.map(p => p.name)).toEqual([
      'title',
      'prep_time',
      'photo',
    ])
  })

  it('rejects a built-in entity type id', async () => {
    const deps = makeDeps()
    const { addProperty } = createDocEntityTools(deps)
    const result = await addProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: 'builtin:task',
        property: { name: 'priority', config: { kind: 'text' } },
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/built-in/i)
    expect(deps.store.calls.updateEntityType).toHaveLength(0)
  })

  it('rejects a duplicate property name', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { addProperty } = createDocEntityTools(deps)
    const result = await addProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        property: { name: 'title', config: { kind: 'text' } },
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/already exists/i)
  })

  it('returns an error when the entity type is missing', async () => {
    const deps = makeDeps()
    const { addProperty } = createDocEntityTools(deps)
    const result = await addProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID_2,
        property: { name: 'photo', config: { kind: 'files' } },
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not found/i)
  })
})

// ── removeProperty ───────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] removeProperty', () => {
  it('drops the property by name', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { removeProperty } = createDocEntityTools(deps)
    const result = await removeProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        propertyName: 'prep_time',
      },
      ctx,
    )
    const data = result.data as { entityType: EntityType }
    expect(data.entityType.properties.map(p => p.name)).toEqual(['title'])
  })

  it('rejects a built-in entity type id', async () => {
    const deps = makeDeps()
    const { removeProperty } = createDocEntityTools(deps)
    const result = await removeProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: 'builtin:contact',
        propertyName: 'phone',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/built-in/i)
  })

  it('returns an error when the property does not exist', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { removeProperty } = createDocEntityTools(deps)
    const result = await removeProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        propertyName: 'nonexistent',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/does not exist/i)
  })
})

// ── renameProperty ───────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] renameProperty', () => {
  it('renames the property via the store, preserving order + config', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { renameProperty } = createDocEntityTools(deps)
    const result = await renameProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        oldName: 'prep_time',
        newName: 'cook_time',
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(deps.store.calls.renameProperty).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        oldName: 'prep_time',
        newName: 'cook_time',
      },
    ])
    const data = result.data as { entityType: EntityType }
    expect(data.entityType.properties.map(p => p.name)).toEqual([
      'title',
      'cook_time',
    ])
    // Config of the renamed property is preserved (still a number).
    const renamed = data.entityType.properties.find(p => p.name === 'cook_time')
    expect(renamed?.config).toEqual({ kind: 'number' })
    // schema_version bumped by the store.
    expect(data.entityType.schemaVersion).toBe(2)
  })

  it('rejects a built-in entity type id without calling the store', async () => {
    const deps = makeDeps()
    const { renameProperty } = createDocEntityTools(deps)
    const result = await renameProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: 'builtin:task',
        oldName: 'title',
        newName: 'headline',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/built-in/i)
    expect(deps.store.calls.renameProperty).toHaveLength(0)
  })

  it('returns an error when oldName does not exist', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { renameProperty } = createDocEntityTools(deps)
    const result = await renameProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        oldName: 'nonexistent',
        newName: 'cook_time',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/does not exist/i)
    expect(deps.store.calls.renameProperty).toHaveLength(0)
  })

  it('returns an error when newName collides with another property', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { renameProperty } = createDocEntityTools(deps)
    const result = await renameProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        oldName: 'prep_time',
        newName: 'title',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/already exists/i)
    expect(deps.store.calls.renameProperty).toHaveLength(0)
  })

  it('rejects a no-op rename (oldName === newName)', async () => {
    const recipe = makeRecipeType()
    const deps = makeDeps({ store: makeFakeStore({ types: [recipe] }) })
    const { renameProperty } = createDocEntityTools(deps)
    const result = await renameProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        oldName: 'title',
        newName: 'title',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(deps.store.calls.renameProperty).toHaveLength(0)
  })

  it('returns an error when the entity type is missing', async () => {
    const deps = makeDeps()
    const { renameProperty } = createDocEntityTools(deps)
    const result = await renameProperty.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID_2,
        oldName: 'title',
        newName: 'headline',
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not found/i)
  })
})

// ── createEntity ─────────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] createEntity', () => {
  it('writes through with sourceApp=chat and currentUserId stamped', async () => {
    const deps = makeDeps()
    const { createEntity } = createDocEntityTools(deps)
    const data: Record<string, CellValue> = {
      title: { kind: 'text', value: 'Bolognese' },
      prep_time: { kind: 'number', value: 30 },
    }
    const result = await createEntity.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        data,
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(deps.store.calls.createEntity).toHaveLength(1)
    const args = deps.store.calls.createEntity[0]
    expect(args.entityTypeId).toBe(USER_TYPE_ID)
    expect(args.sourceApp).toBe('chat')
    expect(args.createdBy).toBe(USER_ID)
    expect(args.lastEditedBy).toBe(USER_ID)
  })

  it('rejects all built-in entity type ids with a redirect to the typed tools', async () => {
    const deps = makeDeps()
    const { createEntity } = createDocEntityTools(deps)
    for (const id of [
      'builtin:task',
      'builtin:contact',
      'builtin:company',
      'builtin:deal',
      'builtin:workflow_run',
    ]) {
      const result = await createEntity.execute(
        {
          workspaceId: WORKSPACE_ID,
          entityTypeId: id,
          data: { title: { kind: 'text', value: 'X' } },
        },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(String(result.data)).toMatch(/saveTask|crmCreate/)
    }
    expect(deps.store.calls.createEntity).toHaveLength(0)
  })

  it('returns the persisted entity with auto fields populated', async () => {
    const deps = makeDeps()
    const { createEntity } = createDocEntityTools(deps)
    const result = await createEntity.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        data: { title: { kind: 'text', value: 'Carbonara' } },
      },
      ctx,
    )
    const out = result.data as { entity: EntityInstance }
    expect(out.entity.id).toMatch(/^aaaaaaaa-/)
    expect(out.entity.createdAt).toBe('2026-05-01T00:00:00.000Z')
    expect(out.entity.lastEditedAt).toBe('2026-05-01T00:00:00.000Z')
  })
})

// ── updateEntity ─────────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] updateEntity', () => {
  it('merges the patch into the existing data and stamps lastEditedBy', async () => {
    const recipe = makeRecipeType()
    const entity = makeRecipeInstance()
    const deps = makeDeps({
      store: makeFakeStore({ types: [recipe], entities: [entity] }),
    })
    const { updateEntity } = createDocEntityTools(deps)
    const result = await updateEntity.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityId: ENTITY_ID,
        patch: { prep_time: { kind: 'number', value: 45 } },
      },
      ctx,
    )
    const out = result.data as { entity: EntityInstance }
    // Existing title preserved; prep_time overwritten.
    expect(out.entity.data.title).toEqual({ kind: 'text', value: 'Bolognese' })
    expect(out.entity.data.prep_time).toEqual({ kind: 'number', value: 45 })
    expect(out.entity.lastEditedBy).toBe(USER_ID)
  })

  it('returns an error when the entity is missing', async () => {
    const deps = makeDeps()
    const { updateEntity } = createDocEntityTools(deps)
    const result = await updateEntity.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityId: ENTITY_ID,
        patch: { title: { kind: 'text', value: 'X' } },
      },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not found/i)
  })
})

// ── deleteEntity ─────────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] deleteEntity', () => {
  it('soft-deletes the row via the store', async () => {
    const deps = makeDeps({
      store: makeFakeStore({ entities: [makeRecipeInstance()] }),
    })
    const { deleteEntity } = createDocEntityTools(deps)
    const result = await deleteEntity.execute(
      { workspaceId: WORKSPACE_ID, entityId: ENTITY_ID },
      ctx,
    )
    expect(result.data).toEqual({ deleted: true })
    expect(deps.store.calls.deleteEntity).toEqual([
      { workspaceId: WORKSPACE_ID, id: ENTITY_ID },
    ])
  })

  it('returns an error from the store when the row is missing', async () => {
    const deps = makeDeps()
    const { deleteEntity } = createDocEntityTools(deps)
    const result = await deleteEntity.execute(
      { workspaceId: WORKSPACE_ID, entityId: ENTITY_ID },
      ctx,
    )
    expect(result.isError).toBe(true)
  })
})

// ── queryEntities ────────────────────────────────────────────────────

describe('[COMP:entities/doc-tools] queryEntities', () => {
  it('passes filters / sort / limit / cursor through to the store', async () => {
    const deps = makeDeps()
    const { queryEntities } = createDocEntityTools(deps)
    const filters: EntityFilter[] = [
      { field: 'prep_time', op: 'lt', value: 20 },
    ]
    const sort: EntitySort[] = [{ field: 'title', direction: 'asc' }]
    await queryEntities.execute(
      {
        workspaceId: WORKSPACE_ID,
        entityTypeId: USER_TYPE_ID,
        filters,
        sort,
        limit: 10,
        cursor: 'opaque-cursor',
      },
      ctx,
    )
    expect(deps.store.calls.queryEntities).toHaveLength(1)
    const args = deps.store.calls.queryEntities[0]
    expect(args.workspaceId).toBe(WORKSPACE_ID)
    expect(args.entityTypeId).toBe(USER_TYPE_ID)
    expect(args.filters).toEqual(filters)
    expect(args.sort).toEqual(sort)
    expect(args.limit).toBe(10)
    expect(args.cursor).toBe('opaque-cursor')
  })

  it('rejects a built-in entityTypeId with a redirect to the typed tools', async () => {
    const deps = makeDeps()
    const { queryEntities } = createDocEntityTools(deps)
    const result = await queryEntities.execute(
      { workspaceId: WORKSPACE_ID, entityTypeId: 'builtin:task' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(deps.store.calls.queryEntities).toHaveLength(0)
  })

  it('forwards nextCursor when the store returns one', async () => {
    const deps = makeDeps({
      store: makeFakeStore({
        queryResult: { rows: [], nextCursor: 'next-1' },
      }),
    })
    const { queryEntities } = createDocEntityTools(deps)
    const result = await queryEntities.execute(
      { workspaceId: WORKSPACE_ID, entityTypeId: USER_TYPE_ID },
      ctx,
    )
    const out = result.data as { rows: EntityInstance[]; nextCursor?: string }
    expect(out.nextCursor).toBe('next-1')
  })

  it('omits nextCursor when the store does not return one', async () => {
    const deps = makeDeps({
      store: makeFakeStore({ queryResult: { rows: [] } }),
    })
    const { queryEntities } = createDocEntityTools(deps)
    const result = await queryEntities.execute(
      { workspaceId: WORKSPACE_ID, entityTypeId: USER_TYPE_ID },
      ctx,
    )
    const out = result.data as { rows: EntityInstance[]; nextCursor?: string }
    expect(out.nextCursor).toBeUndefined()
  })

  it('is read-only and concurrency-safe', () => {
    const { queryEntities } = createDocEntityTools(makeDeps())
    expect(queryEntities.isReadOnly).toBe(true)
    expect(queryEntities.isConcurrencySafe).toBe(true)
  })

  it('rejects limit > 500 at the Zod layer', () => {
    const { queryEntities } = createDocEntityTools(makeDeps())
    const parsed = queryEntities.inputSchema.safeParse({
      workspaceId: WORKSPACE_ID,
      entityTypeId: USER_TYPE_ID,
      limit: 501,
    })
    expect(parsed.success).toBe(false)
  })
})

// ── Tool aggregate / shape ───────────────────────────────────────────

describe('[COMP:entities/doc-tools] createDocEntityTools', () => {
  it('exposes all nine tools with the expected names', () => {
    const tools = createDocEntityTools(makeDeps())
    expect(tools.listEntityTypes.name).toBe('listEntityTypes')
    expect(tools.createEntityType.name).toBe('createEntityType')
    expect(tools.addProperty.name).toBe('addProperty')
    expect(tools.removeProperty.name).toBe('removeProperty')
    expect(tools.renameProperty.name).toBe('renameProperty')
    expect(tools.createEntity.name).toBe('createEntity')
    expect(tools.updateEntity.name).toBe('updateEntity')
    expect(tools.deleteEntity.name).toBe('deleteEntity')
    expect(tools.queryEntities.name).toBe('queryEntities')
  })

  it('marks write tools as non-read-only', () => {
    const tools = createDocEntityTools(makeDeps())
    expect(tools.createEntityType.isReadOnly).toBe(false)
    expect(tools.addProperty.isReadOnly).toBe(false)
    expect(tools.removeProperty.isReadOnly).toBe(false)
    expect(tools.renameProperty.isReadOnly).toBe(false)
    expect(tools.createEntity.isReadOnly).toBe(false)
    expect(tools.updateEntity.isReadOnly).toBe(false)
    expect(tools.deleteEntity.isReadOnly).toBe(false)
  })
})
