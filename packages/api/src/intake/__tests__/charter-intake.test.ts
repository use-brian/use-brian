import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  charterNeedsIntake,
  createSaveCharterTool,
  CHARTER_INTAKE_ADDENDUM,
} from '../charter-intake.js'
import { query } from '../../db/client.js'
import type { ToolContext } from '@use-brian/core'

const mockQuery = vi.mocked(query)
const ctx = {} as ToolContext

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/charter-intake] Charter intake interview', () => {
  describe('charterNeedsIntake', () => {
    it('true only for a standard assistant with neither mission nor success', () => {
      expect(charterNeedsIntake({}, 'standard')).toBe(true)
      expect(charterNeedsIntake({ instructions: 'be terse' }, 'standard')).toBe(true)
      expect(charterNeedsIntake({ mission: 'Own support' }, 'standard')).toBe(false)
      expect(charterNeedsIntake({ success: 'One-reply resolution' }, 'standard')).toBe(false)
    })

    it('never interviews primary or app assistants', () => {
      expect(charterNeedsIntake({}, 'primary')).toBe(false)
      expect(charterNeedsIntake({}, 'app')).toBe(false)
      expect(charterNeedsIntake({}, undefined)).toBe(false)
    })
  })

  it('the addendum names only the tool that rides with it', () => {
    // Tool-awareness: the block references saveCharter and nothing else.
    expect(CHARTER_INTAKE_ADDENDUM).toContain('saveCharter')
    expect(CHARTER_INTAKE_ADDENDUM).not.toMatch(/\b(gmail|google|notion|calendar|slack|mcp_)\b/i)
  })

  describe('saveCharter tool', () => {
    it('requires explicit confirmation - the mechanism behind the "get approval" protocol', () => {
      const tool = createSaveCharterTool({ assistantId: 'a-1' })
      expect(tool.name).toBe('saveCharter')
      expect(tool.requiresConfirmation).toBe(true)
      expect(tool.isReadOnly).toBe(false)
    })

    it('merges the approved fields onto the current effective charter and writes JSONB', async () => {
      const tool = createSaveCharterTool({ assistantId: 'a-1' })
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ charter: null, system_prompt: 'legacy instructions', bio: null }],
          rowCount: 1,
        } as never) // current row (legacy-only)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE

      const result = await tool.execute(
        { mission: 'Own weekly digests', success: 'Zero filler items', audience: 'The founder' },
        ctx,
      )

      expect(result.isError).toBeUndefined()
      const [updateSql, updateValues] = mockQuery.mock.calls[1]
      expect(updateSql).toContain('SET charter = $1::jsonb')
      const written = JSON.parse((updateValues as string[])[0])
      // Legacy instructions survive an interview that didn't cover them.
      expect(written).toEqual({
        mission: 'Own weekly digests',
        success: 'Zero filler items',
        audience: 'The founder',
        instructions: 'legacy instructions',
      })
    })

    it('errors without writing when the assistant row is gone', async () => {
      const tool = createSaveCharterTool({ assistantId: 'a-gone' })
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      const result = await tool.execute({ mission: 'M', success: 'S' }, ctx)

      expect(result.isError).toBe(true)
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('rejects empty-after-trim required fields at the schema boundary', () => {
      const tool = createSaveCharterTool({ assistantId: 'a-1' })
      expect(tool.inputSchema.safeParse({ mission: '', success: 'S' }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ mission: 'M' }).success).toBe(false)
      expect(tool.inputSchema.safeParse({ mission: 'M', success: 'S' }).success).toBe(true)
    })
  })
})
