import { describe, expect, it } from 'vitest'
import {
  bindingConfigSchema,
  savedViewCreateInputSchema,
} from '../schemas.js'
import { viewPayloadSchema } from '../a2ui.js'
import type { BindingConfig } from '../types.js'

describe('[COMP:views/schema] BindingConfig discriminated union', () => {
  it('accepts a tasks/table binding with no filters', () => {
    const cfg: BindingConfig = { entity: 'tasks', viewType: 'table' }
    expect(() => bindingConfigSchema.parse(cfg)).not.toThrow()
  })

  it('accepts a tasks/board binding requiring status groupBy', () => {
    const cfg: BindingConfig = {
      entity: 'tasks',
      viewType: 'board',
      groupBy: 'status',
    }
    expect(() => bindingConfigSchema.parse(cfg)).not.toThrow()
  })

  it('accepts a deals/board binding requiring stage groupBy', () => {
    const cfg: BindingConfig = {
      entity: 'deals',
      viewType: 'board',
      groupBy: 'stage',
    }
    expect(() => bindingConfigSchema.parse(cfg)).not.toThrow()
  })

  it('rejects companies/board (no board support per locked decision)', () => {
    const bad = { entity: 'companies', viewType: 'board' }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })

  it('rejects workflow_runs/board (status is executor-driven)', () => {
    const bad = { entity: 'workflow_runs', viewType: 'board', filters: { workflowId: '00000000-0000-0000-0000-000000000000' } }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })

  it('rejects contacts/board (no group field)', () => {
    const bad = { entity: 'contacts', viewType: 'board' }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })

  it('requires workflowId on workflow_runs/table', () => {
    const bad = { entity: 'workflow_runs', viewType: 'table' }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })

  it('rejects unknown column ids on tasks', () => {
    const bad = {
      entity: 'tasks',
      viewType: 'table',
      columns: ['title', 'unknown_col'],
    }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })

  it('rejects unknown deal stage values in filter', () => {
    const bad = {
      entity: 'deals',
      viewType: 'table',
      filters: { stage: ['lead', 'archived'] },
    }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })

  it('accepts ISO datetime in tasks dueBefore filter', () => {
    const cfg = {
      entity: 'tasks',
      viewType: 'table',
      filters: { dueBefore: '2026-05-09T12:00:00.000Z' },
    }
    expect(() => bindingConfigSchema.parse(cfg)).not.toThrow()
  })

  it('rejects non-ISO datetime in tasks dueBefore filter', () => {
    const bad = {
      entity: 'tasks',
      viewType: 'table',
      filters: { dueBefore: 'tomorrow' },
    }
    expect(() => bindingConfigSchema.parse(bad)).toThrow()
  })
})

describe('[COMP:views/schema] savedViewCreateInputSchema', () => {
  it('accepts a minimal create body', () => {
    const body = {
      name: 'Open Tasks',
      binding: { entity: 'tasks', viewType: 'table' },
    }
    expect(() => savedViewCreateInputSchema.parse(body)).not.toThrow()
  })

  it('rejects empty name', () => {
    const bad = { name: '', binding: { entity: 'tasks', viewType: 'table' } }
    expect(() => savedViewCreateInputSchema.parse(bad)).toThrow()
  })

  it('rejects name over 256 chars', () => {
    const bad = {
      name: 'x'.repeat(257),
      binding: { entity: 'tasks', viewType: 'table' },
    }
    expect(() => savedViewCreateInputSchema.parse(bad)).toThrow()
  })
})

describe('[COMP:views/schema] viewPayloadSchema (A2UI v0.8)', () => {
  it('accepts a minimal text widget root', () => {
    const payload = {
      a2ui: '0.8',
      root: { type: 'text', text: 'hello' },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a recursive container with nested table', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'container',
        direction: 'column',
        children: [
          { type: 'heading', level: 2, text: 'Tasks' },
          {
            type: 'table',
            columns: [{ field: 'title', header: 'Title' }],
            rows: [{ id: 't1', title: 'Buy milk' }],
          },
        ],
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a board with cards carrying nested badge widgets', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'board',
        groupBy: 'status',
        columns: [
          {
            id: 'todo',
            title: 'todo',
            cards: [
              {
                id: 'c1',
                data: {
                  title: 'Buy milk',
                  status: { type: 'badge', text: 'todo', tone: 'default' },
                },
              },
            ],
          },
        ],
        cardSchema: { type: 'text', text: '{{title}}' },
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('rejects mismatched a2ui version', () => {
    const bad = { a2ui: '0.9', root: { type: 'text', text: 'hi' } }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('rejects unknown widget type at runtime', () => {
    const bad = {
      a2ui: '0.8',
      root: { type: 'unknown_widget', text: 'hi' },
    }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('rejects badge with invalid tone', () => {
    const bad = {
      a2ui: '0.8',
      root: { type: 'badge', text: 'x', tone: 'crimson' },
    }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('accepts a DividerWidget root', () => {
    const payload = {
      a2ui: '0.8',
      root: { type: 'divider' },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a container with mixed inline blocks including a divider', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'container',
        direction: 'column',
        children: [
          { type: 'heading', level: 1, text: 'Title' },
          { type: 'divider' },
          { type: 'text', text: 'Body' },
        ],
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })
})

describe('[COMP:views/schema] property-typed widgets (Phase 1)', () => {
  it('accepts a PersonWidget with all fields', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'person',
        id: 'wm_123',
        name: 'Alice Chen',
        avatarUrl: 'https://example.com/a.png',
        initials: 'AC',
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a minimal PersonWidget (no avatar / initials)', () => {
    const payload = {
      a2ui: '0.8',
      root: { type: 'person', id: 'wm_1', name: 'Bob' },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('rejects a PersonWidget with empty id', () => {
    const bad = { a2ui: '0.8', root: { type: 'person', id: '', name: 'Bob' } }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('rejects PersonWidget initials longer than 2 chars', () => {
    const bad = {
      a2ui: '0.8',
      root: { type: 'person', id: 'm', name: 'X', initials: 'ABC' },
    }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('accepts a RelationWidget for each known entityType', () => {
    for (const entityType of ['company', 'contact', 'deal', 'task'] as const) {
      const payload = {
        a2ui: '0.8',
        root: { type: 'relation', entityType, id: 'x_1', label: 'X' },
      }
      expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
    }
  })

  it('rejects RelationWidget with unknown entityType', () => {
    const bad = {
      a2ui: '0.8',
      root: { type: 'relation', entityType: 'memo', id: 'x', label: 'M' },
    }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('accepts a DateWidget with null iso (empty cell)', () => {
    const payload = {
      a2ui: '0.8',
      root: { type: 'date', iso: null },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a DateWidget with iso + format', () => {
    const payload = {
      a2ui: '0.8',
      root: { type: 'date', iso: '2026-05-26T00:00:00.000Z', format: 'relative' },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('rejects DateWidget with empty-string iso (use null instead)', () => {
    const bad = { a2ui: '0.8', root: { type: 'date', iso: '' } }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('rejects DateWidget with unknown format', () => {
    const bad = { a2ui: '0.8', root: { type: 'date', iso: null, format: 'fancy' } }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('accepts a NumberWidget with null value', () => {
    const payload = { a2ui: '0.8', root: { type: 'number', value: null } }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a NumberWidget with currency', () => {
    const payload = {
      a2ui: '0.8',
      root: { type: 'number', value: 1234.5, format: 'currency', currency: 'USD' },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('rejects NumberWidget with non-finite value', () => {
    const bad = { a2ui: '0.8', root: { type: 'number', value: Infinity } }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('rejects NumberWidget with NaN value', () => {
    const bad = { a2ui: '0.8', root: { type: 'number', value: NaN } }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('rejects NumberWidget currency that is not 3 chars', () => {
    const bad = {
      a2ui: '0.8',
      root: { type: 'number', value: 1, format: 'currency', currency: 'US' },
    }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })
})

describe('[COMP:views/schema] A2UIColumn.kind extension (Phase 1)', () => {
  it('accepts a Table column with each known kind', () => {
    const kinds = ['text', 'select', 'tags', 'person', 'relation', 'date', 'number']
    for (const kind of kinds) {
      const payload = {
        a2ui: '0.8',
        root: {
          type: 'table',
          columns: [{ field: 'f', header: 'F', kind }],
          rows: [],
        },
      }
      expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
    }
  })

  it('accepts a Table column without kind (backward-compat default)', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'table',
        columns: [{ field: 'title', header: 'Title' }],
        rows: [],
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('rejects unknown kind on a Table column', () => {
    const bad = {
      a2ui: '0.8',
      root: {
        type: 'table',
        columns: [{ field: 'f', header: 'F', kind: 'rich_text' }],
        rows: [],
      },
    }
    expect(() => viewPayloadSchema.parse(bad)).toThrow()
  })

  it('accepts a Table row with a PersonWidget cell', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'table',
        columns: [{ field: 'assignee', header: 'Assignee', kind: 'person' }],
        rows: [
          {
            id: 't1',
            assignee: { type: 'person', id: 'wm_1', name: 'Alice' },
          },
        ],
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })

  it('accepts a Table row with a DateWidget cell carrying null iso', () => {
    const payload = {
      a2ui: '0.8',
      root: {
        type: 'table',
        columns: [{ field: 'due', header: 'Due', kind: 'date' }],
        rows: [{ id: 't1', due: { type: 'date', iso: null } }],
      },
    }
    expect(() => viewPayloadSchema.parse(payload)).not.toThrow()
  })
})
