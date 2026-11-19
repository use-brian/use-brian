/**
 * [COMP:api/charter-intake] Chat import-graph frontier edges (M4 "Left for M2"):
 * loading the web chat route evaluates neither the charter intake tool, the
 * recording recovery implementation nor Office access; each loads at its own
 * point of use. The intake condition and addendum come from the leaf contract.
 * Each assertion fails against the former static imports.
 */
import { describe, expect, it, vi } from 'vitest'

const loaded = vi.hoisted(() => ({ charter: 0, recovery: 0, office: 0 }))
vi.mock('../../intake/charter-intake.js', () => {
  loaded.charter++
  return { createSaveCharterTool: () => ({ name: 'saveCharter' }) }
})
vi.mock('../../recordings/recovery.js', () => {
  loaded.recovery++
  return { resolveCurrentRecordingId: async () => null }
})
vi.mock('../../office/access.js', () => {
  loaded.office++
  return { resolveOfficeAccess: vi.fn(async (userId: string, artifactId: string) => ({ fictional: `${userId}:${artifactId}` })) }
})

describe('[COMP:api/charter-intake] chat frontier edges load at their point of use', () => {
  it('imports the chat route without evaluating the intake, recovery or Office access modules', async () => {
    const chat = await import('../chat.js')
    expect(typeof chat.chatRoutes).toBe('function')
    expect(loaded).toEqual({ charter: 0, recovery: 0, office: 0 })
    const contract = await import('../../charter-intake-contract.js')
    expect(contract.charterNeedsIntake({ mission: '', success: '' } as never, 'standard')).toBe(true)
    expect(contract.CHARTER_INTAKE_ADDENDUM).toContain('saveCharter')
    expect(loaded.charter).toBe(0)
  }, 60_000)

  it('loads Office access only when the default lane resolver is first called, and delegates to it', async () => {
    const { DEFAULT_OFFICE_LANE_DEPS } = await import('../office-chat-lane.js')
    expect(loaded.office).toBe(0)
    await expect(DEFAULT_OFFICE_LANE_DEPS.resolveAccess('fictional-user', 'fictional-file')).resolves.toEqual({ fictional: 'fictional-user:fictional-file' })
    expect(loaded.office).toBe(1)
  })
})
