import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import {
  buildViewingBrainEntryBlock,
  createBrainEntryEditTools,
  parseBrainEditChannelId,
} from '../brain-entry-edit-tools.js'
import type {
  BrainEntryMutator,
  EditableBrainEntry,
} from '../brain-entry-mutation.js'

const entry: EditableBrainEntry = {
  primitive: 'memory',
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: 'workspace-1',
  createdAt: new Date('2026-08-10T00:00:00.000Z'),
  updatedAt: new Date('2026-08-11T08:48:30.359Z'),
  createdByAssistantId: 'assistant-1',
  verifiedByUserId: null,
  verifiedAt: null,
  label: 'Application essay draft',
  editableFields: ['summary', 'detail', 'scope', 'sensitivity'],
  body: {
    summary: 'Application essay draft',
    detail: 'Third-year student applying to Berkeley.',
    scope: 'shared',
    sensitivity: 'public',
  },
}

const context: ToolContext = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'Use Brian',
  channelType: 'brain_edit',
  channelId: `memory:${entry.id}:nonce`,
  workspaceId: 'workspace-1',
  abortSignal: new AbortController().signal,
}

function mutator(overrides: Partial<BrainEntryMutator> = {}): BrainEntryMutator {
  return {
    getEditableEntry: vi.fn().mockResolvedValue(entry),
    findEditableEntries: vi.fn().mockResolvedValue([entry]),
    mutate: vi.fn().mockResolvedValue({
      status: 200,
      body: { memory: { id: '22222222-2222-4222-8222-222222222222' } },
    }),
    ...overrides,
  }
}

const updateInput = {
  primitive: 'memory' as const,
  rowId: entry.id,
  expectedUpdatedAt: entry.updatedAt.toISOString(),
  detail: 'Graduate applying to the Outward Bound programme.',
}

describe('[COMP:api/brain-entry-edit] Brain entry assistant tools', () => {
  it('builds trusted open-entry context with exact target and editable fields', () => {
    const block = buildViewingBrainEntryBlock(entry)
    expect(block).toContain('Application essay draft')
    expect(block).toContain(`Row id: ${entry.id}`)
    expect(block).toContain(`Revision: ${entry.updatedAt.toISOString()}`)
    expect(block).toContain('summary, detail, scope, sensitivity')
    expect(block).toContain('Do not create or edit a Document page')
  })

  it('parses the nonce-bearing server channel binding without widening the row id', () => {
    expect(parseBrainEditChannelId(`memory:${entry.id}:nonce`)).toEqual({
      primitive: 'memory',
      rowId: entry.id,
    })
    expect(parseBrainEditChannelId(`entity_link:${entry.id}:nonce`)).toBeNull()
  })

  it('find returns exact target metadata and never mutates', async () => {
    const port = mutator()
    const { findEditableBrainEntries } = createBrainEntryEditTools({ mutator: port })
    const result = await findEditableBrainEntries.execute(
      { query: 'essay', limit: 5 },
      context,
    )
    expect(result.isError).not.toBe(true)
    expect(result.data).toEqual({
      status: 'single_match',
      matches: [
        expect.objectContaining({
          primitive: 'memory',
          rowId: entry.id,
          revision: entry.updatedAt.toISOString(),
        }),
      ],
    })
    expect(port.mutate).not.toHaveBeenCalled()
  })

  it('returns a bounded no-match receipt that forbids replacement artifacts', async () => {
    const port = mutator({
      findEditableEntries: vi.fn().mockResolvedValue([]),
    })
    const { findEditableBrainEntries } = createBrainEntryEditTools({ mutator: port })
    const result = await findEditableBrainEntries.execute(
      { query: 'missing title', limit: 5 },
      context,
    )
    expect(result.data).toEqual({
      status: 'no_match',
      matches: [],
      instruction: expect.stringContaining('Do not create a replacement'),
    })
    expect(port.mutate).not.toHaveBeenCalled()
  })

  it('marks multiple matches ambiguous and explicitly forbids updating one', async () => {
    const second = {
      ...entry,
      id: '22222222-2222-4222-8222-222222222222',
      label: 'Essay notes',
    }
    const port = mutator({
      findEditableEntries: vi.fn().mockResolvedValue([entry, second]),
    })
    const { findEditableBrainEntries, updateBrainEntry } =
      createBrainEntryEditTools({ mutator: port })
    const result = await findEditableBrainEntries.execute(
      { query: 'essay', limit: 5 },
      context,
    )
    expect(result.data).toMatchObject({
      status: 'ambiguous',
      instruction: expect.stringContaining('Ask the user to choose'),
      matches: [{ rowId: entry.id }, { rowId: second.id }],
    })
    const attempted = await updateBrainEntry.execute(updateInput, context)
    expect(attempted.isError).toBe(true)
    expect(String(attempted.data)).toMatch(/multiple matches/)
    expect(port.mutate).not.toHaveBeenCalled()
  })

  it('refuses an arbitrary unscoped target that discovery did not return', async () => {
    const port = mutator()
    const { updateBrainEntry } = createBrainEntryEditTools({ mutator: port })
    const result = await updateBrainEntry.execute(updateInput, context)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not returned by Brain Review discovery/)
    expect(port.mutate).not.toHaveBeenCalled()
  })

  it('allows the one exact target and revision returned by discovery', async () => {
    const port = mutator()
    const { findEditableBrainEntries, updateBrainEntry } =
      createBrainEntryEditTools({ mutator: port })
    await findEditableBrainEntries.execute({ query: 'essay' }, context)
    const result = await updateBrainEntry.execute(updateInput, context)
    expect(result.isError).not.toBe(true)
    expect(port.mutate).toHaveBeenCalledTimes(1)
  })

  it('renders a server-read before/after preview and writes only after execution', async () => {
    const port = mutator()
    const { updateBrainEntry } = createBrainEntryEditTools({
      mutator: port,
      scopedEntry: entry,
    })
    const lines = await updateBrainEntry.describeConfirmation?.(
      updateInput,
      context,
    )
    expect(lines).toEqual([
      'Entry: Application essay draft',
      '@@ detail',
      '- Third-year student applying to Berkeley.',
      '+ Graduate applying to the Outward Bound programme.',
    ])
    expect(port.mutate).not.toHaveBeenCalled()

    const result = await updateBrainEntry.execute(updateInput, context)
    expect(result.isError).not.toBe(true)
    expect(port.mutate).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      primitive: 'memory',
      rowId: entry.id,
      expectedUpdatedAt: entry.updatedAt.toISOString(),
      changes: { detail: updateInput.detail },
    })
    expect(result.data).toMatchObject({
      kind: 'brain_entry_updated',
      previousRowId: entry.id,
      liveRowId: '22222222-2222-4222-8222-222222222222',
    })
  })

  it('warns in the confirmation preview when the fresh server revision changed', async () => {
    const changed = {
      ...entry,
      updatedAt: new Date('2026-08-11T09:00:00.000Z'),
    }
    const port = mutator({
      getEditableEntry: vi.fn().mockResolvedValue(changed),
    })
    const { updateBrainEntry } = createBrainEntryEditTools({
      mutator: port,
      scopedEntry: entry,
    })
    const lines = await updateBrainEntry.describeConfirmation?.(
      updateInput,
      context,
    )
    expect(lines).toContain('This entry changed after the proposal was prepared.')
    expect(port.mutate).not.toHaveBeenCalled()
  })

  it('refuses a different row or revision in a server-scoped edit session', async () => {
    const port = mutator()
    const { updateBrainEntry } = createBrainEntryEditTools({
      mutator: port,
      scopedEntry: entry,
    })
    const result = await updateBrainEntry.execute(
      { ...updateInput, expectedUpdatedAt: '2026-08-11T00:00:00.000Z' },
      context,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/does not match/)
    expect(port.mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['memory', { summary: 'Updated memory' }],
    ['entity', { display_name: 'Updated entity' }],
    ['task', { title: 'Updated task' }],
    ['contact', { email: 'person@example.com' }],
    ['company', { domain: 'company.example' }],
    ['deal', { amount: 1250 }],
    ['workspace_file', { tags: ['reviewed'] }],
  ] as const)('accepts the shipped %s editable-field contract', (primitive, patch) => {
    const { updateBrainEntry } = createBrainEntryEditTools({
      mutator: mutator(),
    })
    expect(updateBrainEntry.inputSchema.safeParse({
      primitive,
      rowId: entry.id,
      expectedUpdatedAt: entry.updatedAt.toISOString(),
      ...patch,
    }).success).toBe(true)
  })

  it('rejects unknown keys instead of stripping them before the mutation boundary', () => {
    const { updateBrainEntry } = createBrainEntryEditTools({
      mutator: mutator(),
    })
    expect(updateBrainEntry.inputSchema.safeParse({
      ...updateInput,
      unexpected_field: 'must fail',
    }).success).toBe(false)
  })

  it('rejects fields outside the primitive matrix at the schema boundary', () => {
    const { updateBrainEntry } = createBrainEntryEditTools({
      mutator: mutator(),
    })
    const parsed = updateBrainEntry.inputSchema.safeParse({
      ...updateInput,
      domain: 'example.com',
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/not editable for memory/)
    }
  })
})
