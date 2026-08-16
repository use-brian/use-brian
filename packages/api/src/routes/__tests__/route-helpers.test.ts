import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  findUserById: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
}))

vi.mock('../../mcp/inject.js', () => ({
  injectMcpTools: vi.fn(),
}))

import {
  computePercent,
  isValidDateString,
  buildBrowserEscalationPrompt,
  buildUnavailableCapabilitiesPrompt,
  requireAssistantMember,
  requireAssistantOwner,
  applyMcpInjection,
} from '../route-helpers.js'
import { query } from '../../db/client.js'
import { injectMcpTools } from '../../mcp/inject.js'

const mockQuery = vi.mocked(query)

describe('[COMP:api/route-helpers] Route helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('computePercent', () => {
    it('returns 0 for zero cost', () => {
      expect(computePercent(0, 100)).toEqual({ percent: 0, rawPercent: 0 })
    })

    it('floors to 1% when any usage exists but rawPercent < 1', () => {
      const result = computePercent(0.5, 100)
      expect(result.percent).toBe(1)
      expect(result.rawPercent).toBe(0.5)
    })

    it('returns correct percent for normal usage', () => {
      expect(computePercent(50, 100)).toEqual({ percent: 50, rawPercent: 50 })
    })

    it('returns 100% at cap', () => {
      expect(computePercent(100, 100)).toEqual({ percent: 100, rawPercent: 100 })
    })

    it('caps at 100% when over budget', () => {
      const result = computePercent(150, 100)
      expect(result.percent).toBe(100)
      expect(result.rawPercent).toBe(150)
    })

    it('returns 0 for zero cap', () => {
      expect(computePercent(50, 0)).toEqual({ percent: 0, rawPercent: 0 })
    })
  })

  describe('isValidDateString', () => {
    it('returns true for valid YYYY-MM-DD', () => {
      expect(isValidDateString('2024-01-15')).toBe(true)
    })

    it('returns false for invalid format', () => {
      expect(isValidDateString('not-a-date')).toBe(false)
      expect(isValidDateString('01-15-2024')).toBe(false)
      expect(isValidDateString('2024/01/15')).toBe(false)
      expect(isValidDateString('')).toBe(false)
    })
  })

  describe('buildUnavailableCapabilitiesPrompt', () => {
    // No search surface: `injectMcpTools` skips the mcp_search pair when no
    // source exists, and these three pin the original strict behaviour.
    const noSearch = new Map()

    it('returns empty string for empty array', () => {
      expect(buildUnavailableCapabilitiesPrompt([], noSearch)).toBe('')
    })

    it('includes capability names and NOT available text', () => {
      const result = buildUnavailableCapabilitiesPrompt(['Gmail', 'Google Calendar'], noSearch)
      expect(result).toContain('Gmail')
      expect(result).toContain('Google Calendar')
      expect(result).toContain('not available')
      expect(result.match(/Studio → Connectors/g)).toHaveLength(1)
    })

    it('scopes the Settings suggestion to the listed services (closed world)', () => {
      const result = buildUnavailableCapabilitiesPrompt(['Gmail'], noSearch)
      // The template must be scoped to the list, not a general habit the
      // model extends to arbitrary services (the invented-Jira-connector
      // class caught by the WS2 probe battery).
      expect(result).toContain('For any other service')
      expect(result).toContain('Do not suggest a connector setting for an unlisted service')
      expect(result).not.toContain('an unavailable service')
    })

    // ── Deferred-surface carve-out (prod incident 2026-07-23) ──────
    // `injectMcpTools` DELETES every built-in connector tool from the map and
    // folds it behind `mcp_search`. A granted+connected connector is therefore
    // in NEITHER `capabilities` (it is connected) NOR the tool map (plucked),
    // so the bare closed-world sentence told the model to deny it. TaskMaster
    // refused a GitHub write it held a live grant for, then found 8 GitHub
    // tools the moment it was pushed into running `mcp_search`.
    const withSearch = new Map([['mcp_search', {}], ['mcp_call', {}]])

    it('does NOT claim the visible tools are the whole surface when mcp_search is present', () => {
      const result = buildUnavailableCapabilitiesPrompt(['Gmail'], withSearch)
      expect(result).not.toContain('The list and visible tools are the complete integration surface')
    })

    it('orders a search before any denial when mcp_search is present', () => {
      const result = buildUnavailableCapabilitiesPrompt(['Gmail'], withSearch)
      expect(result).toContain('mcp_search')
      expect(result).toMatch(/before .{0,60}unavailable/i)
      // The listed services stay closed-world — searching for them is still banned.
      expect(result).toContain('Do not suggest a connector setting for an unlisted service')
    })

    it('emits the search guidance even when nothing is unavailable', () => {
      // The old builder returned '' at length 0, so an assistant with every
      // connector healthy got NO guidance at all and still denied from absence.
      const result = buildUnavailableCapabilitiesPrompt([], withSearch)
      expect(result).toContain('mcp_search')
      expect(result).not.toContain('# Unavailable capabilities')
    })

    it('keeps the strict closed world when there is no search surface', () => {
      // Tool-awareness rule: never name mcp_search when it is not in the map.
      // `injectMcpTools` skips the search pair entirely when no source exists.
      expect(buildUnavailableCapabilitiesPrompt([], new Map())).toBe('')
      const result = buildUnavailableCapabilitiesPrompt(['Gmail'], new Map())
      expect(result).not.toContain('mcp_search')
      expect(result).toContain('The list and visible tools are the complete integration surface')
    })
  })

  describe('buildBrowserEscalationPrompt', () => {
    it('is EMPTY when the acting browser tools are not in the tool map (tool-awareness rule)', () => {
      expect(buildBrowserEscalationPrompt(new Map())).toBe('')
    })

    it('steers escalation + the no-profile posture when browserNavigate is present', () => {
      const tools = new Map([['browserNavigate', {}]])
      const result = buildBrowserEscalationPrompt(tools)
      expect(result).toContain('browserNavigate')
      expect(result).toContain('Never refuse to browse because the workspace has no browser profile')
      expect(result).toContain('open the authoritative site')
      // browserExplore is absent from this map, so it must not be named.
      expect(result).not.toContain('browserExplore')
    })

    it('names browserExplore only when it is actually injected', () => {
      const tools = new Map([
        ['browserNavigate', {}],
        ['browserExplore', {}],
      ])
      expect(buildBrowserEscalationPrompt(tools)).toContain('browserExplore')
    })
  })

  describe('requireAssistantMember', () => {
    it('returns true when member found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }] } as never)

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      // requireAssistantMember(userId, assistantId, res)
      const result = await requireAssistantMember('u_1', 'a_1', mockRes as never)

      expect(result).toBe(true)
      expect(mockRes.status).not.toHaveBeenCalled()
    })

    it('sends 403 when not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as never)

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      const result = await requireAssistantMember('u_1', 'a_1', mockRes as never)

      expect(result).toBe(false)
      expect(mockRes.status).toHaveBeenCalledWith(403)
    })

    it('queries both assistant_members and workspace_members (team-owned access)', async () => {
      // The single SQL must check personal ownership AND team-member
      // access (post migration 089). Both branches must reference the
      // assistantId param ($1) so the query works in either shape.
      mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] } as never)
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }

      const result = await requireAssistantMember('u_1', 'a_1', mockRes as never)

      expect(result).toBe(true)
      const sql = mockQuery.mock.calls[0][0]
      expect(sql).toMatch(/assistant_members/)
      expect(sql).toMatch(/workspace_members/)
    })
  })

  describe('requireAssistantOwner', () => {
    it('returns true when owner', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as never)

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      const result = await requireAssistantOwner('u_1', 'a_1', mockRes as never)

      expect(result).toBe(true)
      expect(mockRes.status).not.toHaveBeenCalled()
    })

    it('sends 403 when member but not owner', async () => {
      // The SQL filters by role = 'owner', so a non-owner returns empty rows
      mockQuery.mockResolvedValueOnce({ rows: [] } as never)

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
      }

      const result = await requireAssistantOwner('u_1', 'a_1', mockRes as never)

      expect(result).toBe(false)
      expect(mockRes.status).toHaveBeenCalledWith(403)
    })

    it('queries both assistant_members and workspace_members owner roles', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] } as never)
      const mockRes = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }

      await requireAssistantOwner('u_1', 'a_1', mockRes as never)

      const sql = mockQuery.mock.calls[0][0]
      expect(sql).toMatch(/assistant_members[\s\S]*role = 'owner'/)
      expect(sql).toMatch(/workspace_members[\s\S]*role = 'owner'/)
    })
  })

  describe('applyMcpInjection', () => {
    const mockInject = vi.mocked(injectMcpTools)
    const baseParams = {
      scope: 'public-api',
      connectorUserId: 'team-owner-id',
      assistant: { id: 'asst_1', workspaceId: 'team_1' as string | null },
      tools: new Map(),
    }

    it('returns identity-enricher no-op when MCP stores are absent', async () => {
      // Routes pass `stores: options` where options can omit connectorStore
      // entirely (legacy/test setups). Helper must NOT call injectMcpTools
      // and must NOT throw — it should degrade silently to base tools.
      const result = await applyMcpInjection({ ...baseParams, stores: {} })

      expect(mockInject).not.toHaveBeenCalled()
      expect(result.unavailable).toEqual([])
      // Identity enricher returns input unchanged
      const enriched = await result.enrichConfirmation('toolName', { foo: 'bar' })
      expect(enriched).toEqual({ foo: 'bar' })
    })

    it('passes through to injectMcpTools and returns its result', async () => {
      mockInject.mockResolvedValueOnce({
        enrichConfirmation: async (_t, input) => ({ ...input, enriched: true }),
        unavailable: ['Gmail'],
      })

      const stores = {
        connectorStore: {} as never,
        mcpSettingsStore: {} as never,
      }
      const result = await applyMcpInjection({ ...baseParams, userTimezone: 'Asia/Hong_Kong', stores })

      expect(mockInject).toHaveBeenCalledTimes(1)
      const call = mockInject.mock.calls[0][0]
      expect(call.userId).toBe('team-owner-id')
      expect(call.assistantId).toBe('asst_1')
      expect(call.assistantTeamId).toBe('team_1')
      expect(call.userTimezone).toBe('Asia/Hong_Kong')
      expect(result.unavailable).toEqual(['Gmail'])
    })

    it('coerces undefined workspaceId to null so injectMcpTools sees a stable shape', async () => {
      // Personal-only assistants pass workspaceId: undefined. The MCP injection
      // function expects null | string, so the helper must normalise — a
      // raw undefined would silently skip the team-overlay branches inside
      // injectMcpTools without warning.
      mockInject.mockResolvedValueOnce({
        enrichConfirmation: async (_t, input) => input,
        unavailable: [],
      })

      const stores = { connectorStore: {} as never, mcpSettingsStore: {} as never }
      await applyMcpInjection({
        ...baseParams,
        assistant: { id: 'asst_personal', workspaceId: undefined },
        stores,
      })

      expect(mockInject.mock.calls[0][0].assistantTeamId).toBeNull()
    })

    it('returns no-op when injectMcpTools throws (never crashes the route)', async () => {
      mockInject.mockRejectedValueOnce(new Error('discovery timeout'))
      const stores = { connectorStore: {} as never, mcpSettingsStore: {} as never }
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const result = await applyMcpInjection({ ...baseParams, stores })

      expect(result.unavailable).toEqual([])
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[public-api]'),
        expect.any(Error),
      )
      errSpy.mockRestore()
    })
  })
})
