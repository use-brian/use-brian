/**
 * Tests for the doc v1 built-in entity type projections.
 *
 * The built-ins (tasks / contacts / companies / deals / workflow_runs)
 * have to satisfy three invariants to land cleanly alongside user-defined
 * `DocEntityType`s in `listEntityTypes()`:
 *
 *   1. The enum vocabulary stays exactly the five primitives Lock #11
 *      named — drifting that list would break `EntityTypeRef.builtin`.
 *   2. Each projection carries reasonable properties (the chat layer
 *      relies on these to surface property pickers).
 *   3. The projection round-trips through `docEntityTypeSchema` so a
 *      future store can mix builtin + user-defined rows behind one Zod.
 *
 * [COMP:entities/doc-built-ins]
 */

import { describe, it, expect } from 'vitest'

import {
  BUILTIN_ENTITY_TYPE_NAMES,
  getBuiltInEntityType,
  isBuiltInEntityTypeId,
  listBuiltInEntityTypes,
  type BuiltInEntityTypeName,
} from '../doc-built-ins.js'
import { entityTypeSchema as docEntityTypeSchema } from '../doc-schemas.js'
import type { PropertyDef, StatusGroup, SelectOption } from '../doc-types.js'

const WORKSPACE_ID = 'ws-1'

describe('[COMP:entities/doc-built-ins] BUILTIN_ENTITY_TYPE_NAMES vocabulary', () => {
  it('has exactly five entries matching the Lock #11 primitives', () => {
    expect(BUILTIN_ENTITY_TYPE_NAMES).toHaveLength(5)
    expect([...BUILTIN_ENTITY_TYPE_NAMES]).toEqual([
      'task',
      'contact',
      'company',
      'deal',
      'workflow_run',
    ])
  })
})

describe('[COMP:entities/doc-built-ins] getBuiltInEntityType - task projection', () => {
  it('returns a schema with id "builtin:task" and the core task columns', () => {
    const task = getBuiltInEntityType(WORKSPACE_ID, 'task')
    expect(task.id).toBe('builtin:task')
    expect(task.workspaceId).toBe(WORKSPACE_ID)
    expect(task.schemaVersion).toBe(1)
    expect(task.createdBy).toBeNull()

    const names = task.properties.map((p: PropertyDef) => p.name)
    expect(names).toContain('title')
    expect(names).toContain('status')
    expect(names).toContain('due_date')
    expect(names).toContain('assignee')
  })

  it('declares the task status enum via the grouped `status` kind (todo / in_progress / blocked / done / archived)', () => {
    const task = getBuiltInEntityType(WORKSPACE_ID, 'task')
    const status = task.properties.find((p: PropertyDef) => p.name === 'status')
    expect(status).toBeDefined()
    expect(status?.config.kind).toBe('status')
    if (status?.config.kind !== 'status') throw new Error('unreachable')

    const allOptionIds = status.config.groups.flatMap((g: StatusGroup) =>
      g.options.map((o: SelectOption) => o.id),
    )
    expect(allOptionIds).toEqual(
      expect.arrayContaining(['todo', 'in_progress', 'blocked', 'done', 'archived']),
    )
  })
})

describe('[COMP:entities/doc-built-ins] getBuiltInEntityType - CRM projections', () => {
  it('contact relates to company via a builtin EntityTypeRef', () => {
    const contact = getBuiltInEntityType(WORKSPACE_ID, 'contact')
    const company = contact.properties.find((p: PropertyDef) => p.name === 'company')
    expect(company?.config.kind).toBe('relation')
    if (company?.config.kind !== 'relation') throw new Error('unreachable')
    expect(company.config.targetEntityTypeRef).toEqual({
      kind: 'builtin',
      name: 'company',
    })
  })

  it('deal carries amount (dollar number) + stage (status with locked enum) + contact/company relations', () => {
    const deal = getBuiltInEntityType(WORKSPACE_ID, 'deal')
    const amount = deal.properties.find((p: PropertyDef) => p.name === 'amount')
    expect(amount?.config.kind).toBe('number')
    if (amount?.config.kind !== 'number') throw new Error('unreachable')
    expect(amount.config.format).toBe('dollar')

    const stage = deal.properties.find((p: PropertyDef) => p.name === 'stage')
    expect(stage?.config.kind).toBe('status')
    if (stage?.config.kind !== 'status') throw new Error('unreachable')
    const stageOptions = stage.config.groups.flatMap((g: StatusGroup) =>
      g.options.map((o: SelectOption) => o.id),
    )
    expect(stageOptions).toEqual(
      expect.arrayContaining([
        'lead',
        'qualified',
        'proposal',
        'negotiation',
        'won',
        'lost',
      ]),
    )

    const contact = deal.properties.find((p: PropertyDef) => p.name === 'contact')
    const company = deal.properties.find((p: PropertyDef) => p.name === 'company')
    expect(contact?.config.kind).toBe('relation')
    expect(company?.config.kind).toBe('relation')
  })
})

describe('[COMP:entities/doc-built-ins] getBuiltInEntityType - workflow_run projection', () => {
  it('carries name, status (with workflow run enum), workflow_id, and started_at', () => {
    const run = getBuiltInEntityType(WORKSPACE_ID, 'workflow_run')
    const names = run.properties.map((p: PropertyDef) => p.name)
    expect(names).toContain('name')
    expect(names).toContain('status')
    expect(names).toContain('workflow_id')
    expect(names).toContain('started_at')

    const status = run.properties.find((p: PropertyDef) => p.name === 'status')
    expect(status?.config.kind).toBe('status')
    if (status?.config.kind !== 'status') throw new Error('unreachable')
    const ids = status.config.groups.flatMap((g: StatusGroup) =>
      g.options.map((o: SelectOption) => o.id),
    )
    expect(ids).toEqual(
      expect.arrayContaining([
        'pending',
        'running',
        'awaiting_wait',
        'awaiting_input',
        'completed',
        'failed',
        'timeout',
      ]),
    )
  })
})

describe('[COMP:entities/doc-built-ins] all five built-ins carry the common audit-trail properties', () => {
  it('every projection has created_time / created_by / last_edited_time / last_edited_by', () => {
    for (const name of BUILTIN_ENTITY_TYPE_NAMES) {
      const type = getBuiltInEntityType(WORKSPACE_ID, name as BuiltInEntityTypeName)
      const kinds = type.properties.map((p: PropertyDef) => p.config.kind)
      expect(kinds).toContain('created_time')
      expect(kinds).toContain('created_by')
      expect(kinds).toContain('last_edited_time')
      expect(kinds).toContain('last_edited_by')
    }
  })
})

describe('[COMP:entities/doc-built-ins] listBuiltInEntityTypes', () => {
  it('returns 5 entities, all with builtin: prefixed ids in declaration order', () => {
    const types = listBuiltInEntityTypes(WORKSPACE_ID)
    expect(types).toHaveLength(5)
    expect(types.map(t => t.id)).toEqual([
      'builtin:task',
      'builtin:contact',
      'builtin:company',
      'builtin:deal',
      'builtin:workflow_run',
    ])
    // Every entity is scoped to the requested workspace.
    for (const type of types) {
      expect(type.workspaceId).toBe(WORKSPACE_ID)
    }
  })

  it('honors the workspaceId parameter (built-ins are workspace-scoped at the projection layer)', () => {
    const types = listBuiltInEntityTypes('ws-other')
    for (const type of types) {
      expect(type.workspaceId).toBe('ws-other')
    }
  })
})

describe('[COMP:entities/doc-built-ins] docEntityTypeSchema round-trip', () => {
  it('every built-in parses cleanly via docEntityTypeSchema', () => {
    for (const name of BUILTIN_ENTITY_TYPE_NAMES) {
      const type = getBuiltInEntityType(WORKSPACE_ID, name as BuiltInEntityTypeName)
      const parsed = docEntityTypeSchema.parse(type)
      // Parser preserves the projection — no silent coercion losing fields.
      expect(parsed.id).toBe(type.id)
      expect(parsed.properties.length).toBe(type.properties.length)
    }
  })
})

describe('[COMP:entities/doc-built-ins] isBuiltInEntityTypeId', () => {
  it('returns true for any builtin: id and false for UUIDs / unknown names', () => {
    expect(isBuiltInEntityTypeId('builtin:task')).toBe(true)
    expect(isBuiltInEntityTypeId('builtin:contact')).toBe(true)
    expect(isBuiltInEntityTypeId('builtin:workflow_run')).toBe(true)
    expect(isBuiltInEntityTypeId('builtin:unknown')).toBe(false)
    expect(isBuiltInEntityTypeId('00000000-0000-0000-0000-000000000000')).toBe(false)
    expect(isBuiltInEntityTypeId('')).toBe(false)
  })
})
