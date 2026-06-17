/**
 * Pure-unit shape tests for brain-inbox-store. No DB required — these
 * catch the obvious "added a primitive to the BrainInboxPrimitive type
 * but forgot to handle it everywhere" mistake that breaks the inbox
 * detail page silently.
 *
 * Integration tests against actual migration 174 partial indexes are
 * still tracked as a gap in docs/workflow/component-map.md.
 */

import { describe, expect, it } from 'vitest'
import {
  primitiveToTable,
  type BrainInboxPrimitive,
} from '../brain-inbox-store.js'

const ALL_PRIMITIVES: BrainInboxPrimitive[] = [
  'memory',
  'entity',
  'entity_link',
  'task',
  'contact',
  'company',
  'deal',
  'workspace_file',
]

describe('[COMP:brain/inbox-store] BrainInboxPrimitive shape', () => {
  it('primitiveToTable returns a non-empty string for every primitive', () => {
    for (const p of ALL_PRIMITIVES) {
      const table = primitiveToTable(p)
      expect(table).toBeTypeOf('string')
      expect(table.length).toBeGreaterThan(0)
    }
  })

  it('primitiveToTable resolves to the expected per-primitive table', () => {
    expect(primitiveToTable('memory')).toBe('memories')
    expect(primitiveToTable('entity')).toBe('entities')
    expect(primitiveToTable('entity_link')).toBe('entity_links')
    expect(primitiveToTable('task')).toBe('tasks')
    expect(primitiveToTable('contact')).toBe('contacts')
    expect(primitiveToTable('company')).toBe('companies')
    expect(primitiveToTable('deal')).toBe('deals')
    expect(primitiveToTable('workspace_file')).toBe('workspace_files')
  })
})
