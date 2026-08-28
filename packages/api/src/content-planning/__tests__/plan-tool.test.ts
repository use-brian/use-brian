import { describe, expect, it } from 'vitest'
import { buildProposePlanTool, PROPOSE_PLAN_TOOL_NAME } from '../plan-tool.js'

describe('[COMP:feed/content-plan-tool] proposePlan schema (P11 briefPatch)', () => {
  const tool = buildProposePlanTool()

  it('is a provider-independent, read-only UI signal', () => {
    expect(tool.name).toBe(PROPOSE_PLAN_TOOL_NAME)
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })

  it('slots-only calls are unchanged — briefPatch stays optional', () => {
    expect(() =>
      tool.inputSchema.parse({
        month: '2026-08',
        rationale: 'Fill the gaps.',
        slots: [
          {
            index: 1,
            date: '2026-08-12',
            platform: 'threads',
            title: 'Launch teaser',
          },
        ],
      }),
    ).not.toThrow()
  })

  it('accepts a brief-only direction change with zero slots', () => {
    const parsed = tool.inputSchema.parse({
      month: '2026-08',
      rationale: 'Pivot to hiring content.',
      briefPatch: { brief: 'Hiring-first month', cadencePerWeek: 2 },
    })
    expect(parsed.slots).toEqual([])
    expect(parsed.briefPatch).toEqual({
      brief: 'Hiring-first month',
      cadencePerWeek: 2,
    })
    // null clears the cadence; the accept path forwards it as a clear.
    expect(() =>
      tool.inputSchema.parse({
        month: '2026-08',
        rationale: 'Drop the cadence target.',
        briefPatch: { cadencePerWeek: null },
      }),
    ).not.toThrow()
  })

  it('refuses a call proposing nothing at all', () => {
    expect(() =>
      tool.inputSchema.parse({
        month: '2026-08',
        rationale: 'Empty.',
        slots: [],
      }),
    ).toThrow(/at least one slot/i)
    expect(() =>
      tool.inputSchema.parse({
        month: '2026-08',
        rationale: 'Empty patch.',
        briefPatch: {},
        slots: [],
      }),
    ).toThrow(/at least one slot/i)
  })

  it('bounds the cadence and keeps duplicate slot indices rejected', () => {
    expect(() =>
      tool.inputSchema.parse({
        month: '2026-08',
        rationale: 'Too eager.',
        briefPatch: { cadencePerWeek: 40 },
      }),
    ).toThrow()
    expect(() =>
      tool.inputSchema.parse({
        month: '2026-08',
        rationale: 'Collision.',
        slots: [
          { index: 1, date: '2026-08-12', platform: 'threads', title: 'A' },
          { index: 1, date: '2026-08-13', platform: 'threads', title: 'B' },
        ],
      }),
    ).toThrow(/unique index/i)
  })

  it('reports whether a briefPatch rode the call', async () => {
    const withPatch = await tool.execute(
      {
        month: '2026-08',
        rationale: 'Pivot.',
        briefPatch: { brief: 'New direction' },
        slots: [],
      },
      {} as never,
    )
    expect(withPatch.data).toMatchObject({ ok: true, count: 0, briefPatch: true })
    const withoutPatch = await tool.execute(
      {
        month: '2026-08',
        rationale: 'Slots.',
        slots: [
          { index: 1, date: '2026-08-12', platform: 'threads', title: 'A' },
        ],
      },
      {} as never,
    )
    expect(withoutPatch.data).toMatchObject({ ok: true, count: 1, briefPatch: false })
  })
})
