import { describe, it, expect } from 'vitest'
import { buildProposeDraftsTool, PROPOSE_DRAFTS_TOOL_NAME } from '../draft-tools.js'

const tool = buildProposeDraftsTool()

describe('[COMP:feed/draft-sessions] proposeDrafts tool — schema', () => {
  it('exposes the canonical name so frontend SSE filtering matches', () => {
    expect(tool.name).toBe(PROPOSE_DRAFTS_TOOL_NAME)
    expect(tool.name).toBe('proposeDrafts')
  })

  it('is read-only and concurrency-safe — no DB writes, no side effects', () => {
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })

  it('accepts 1-5 drafts with unique indices', () => {
    expect(() =>
      tool.inputSchema.parse({
        rationale: 'three angles',
        drafts: [
          { index: 1, text: 'one' },
          { index: 2, text: 'two' },
          { index: 3, text: 'three' },
        ],
      }),
    ).not.toThrow()
  })

  it('rejects empty drafts array — at least one required', () => {
    expect(() =>
      tool.inputSchema.parse({ rationale: 'r', drafts: [] }),
    ).toThrow()
  })

  it('rejects more than 5 drafts per call', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ index: i + 1, text: `d${i + 1}` }))
    expect(() => tool.inputSchema.parse({ rationale: 'r', drafts: six })).toThrow()
  })

  it('rejects duplicate indices in a single call (would clobber upsert intent)', () => {
    expect(() =>
      tool.inputSchema.parse({
        rationale: 'r',
        drafts: [
          { index: 1, text: 'a' },
          { index: 1, text: 'b' },
        ],
      }),
    ).toThrow(/unique index/)
  })

  it('rejects non-integer or zero/negative indices', () => {
    for (const bad of [0, -1, 1.5, 100]) {
      expect(() =>
        tool.inputSchema.parse({ rationale: 'r', drafts: [{ index: bad, text: 'x' }] }),
      ).toThrow()
    }
  })

  it('rejects drafts with empty text or text > 4000 chars', () => {
    expect(() =>
      tool.inputSchema.parse({ rationale: 'r', drafts: [{ index: 1, text: '' }] }),
    ).toThrow()
    expect(() =>
      tool.inputSchema.parse({ rationale: 'r', drafts: [{ index: 1, text: 'x'.repeat(4_001) }] }),
    ).toThrow()
  })

  it('clamps label to 30 chars at the schema layer', () => {
    expect(() =>
      tool.inputSchema.parse({
        rationale: 'r',
        drafts: [{ index: 1, text: 'ok', label: 'x'.repeat(31) }],
      }),
    ).toThrow()
  })

  it('clamps rationale to 800 chars to bound system-prompt feedback noise', () => {
    expect(() =>
      tool.inputSchema.parse({
        rationale: 'x'.repeat(801),
        drafts: [{ index: 1, text: 'ok' }],
      }),
    ).toThrow()
  })
})

describe('[COMP:feed/draft-sessions] proposeDrafts tool — execute', () => {
  it('returns ok with the count and indices it received — pure UI signal', async () => {
    const result = await tool.execute(
      {
        rationale: 'three angles',
        drafts: [
          { index: 1, text: 'a', label: 'short' },
          { index: 2, text: 'b' },
        ],
      },
      // Tool context is unused by this tool; cast through any to satisfy the type.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    )
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ ok: true, count: 2, indices: [1, 2] })
  })
})
