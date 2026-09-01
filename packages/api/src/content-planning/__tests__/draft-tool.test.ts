import { describe, expect, it } from 'vitest'
import {
  buildProposeDraftsTool,
  MAX_PROPOSED_DRAFT_CHARS,
  PROPOSE_DRAFTS_TOOL_NAME,
} from '../draft-tool.js'

describe('[COMP:feed/content-planning-tool] proposeDrafts', () => {
  const tool = buildProposeDraftsTool()

  it('is a provider-independent, read-only UI signal', () => {
    expect(tool.name).toBe(PROPOSE_DRAFTS_TOOL_NAME)
    expect(tool.name).toBe('proposeDrafts')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })

  it('accepts indexed text and image-first alternatives', () => {
    expect(() => tool.inputSchema.parse({
      rationale: 'Two different openings.',
      drafts: [
        { index: 1, text: 'First draft' },
        {
          index: 2,
          text: 'Second draft',
          label: 'visual',
          imageBrief: 'Product on a quiet desk, morning light.',
        },
      ],
    })).not.toThrow()
  })

  it('rejects duplicate indices and an empty alternative list', () => {
    expect(() => tool.inputSchema.parse({
      rationale: 'No options.',
      drafts: [],
    })).toThrow()
    expect(() => tool.inputSchema.parse({
      rationale: 'Collision.',
      drafts: [
        { index: 1, text: 'A' },
        { index: 1, text: 'B' },
      ],
    })).toThrow(/unique index/i)
  })

  it('accepts long-form draft bodies beyond 3000 characters within the storage guard', () => {
    expect(() => tool.inputSchema.parse({
      rationale: 'One long-form draft.',
      drafts: [{ index: 1, text: 'L'.repeat(12_000) }],
    })).not.toThrow()
    expect(() => tool.inputSchema.parse({
      rationale: 'Too large.',
      drafts: [{ index: 1, text: 'L'.repeat(MAX_PROPOSED_DRAFT_CHARS + 1) }],
    })).toThrow()
  })

  it('executes without external or database dependencies', async () => {
    const result = await tool.execute(
      {
        rationale: 'Two.',
        drafts: [
          { index: 2, text: 'A' },
          { index: 4, text: 'B' },
        ],
      },
      // The implementation intentionally ignores execution context.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    )
    expect(result.data).toEqual({ ok: true, count: 2, indices: [2, 4] })
  })
})
