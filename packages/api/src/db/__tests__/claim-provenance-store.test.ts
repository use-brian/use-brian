/**
 * Unit tests for the claim_provenance store (grounding-gate claim ledger,
 * migration 333). Mocks the `query` helper — covers the batch INSERT shape
 * and the latest-assistant-message lookup + row mapping.
 *
 * Component tag: [COMP:engine/grounding-gate]. Spec:
 * docs/architecture/engine/grounding-gate.md → "Claim ledger".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import {
  insertClaimProvenance,
  getClaimsForLatestAssistantMessage,
} from '../claim-provenance-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:engine/grounding-gate] insertClaimProvenance', () => {
  it('supersedes the session prior rows, then batch-INSERTs one row per claim', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    await insertClaimProvenance('msg-1', [
      {
        claim: '40,000 里',
        canonical: 'n:40000',
        kind: 'amount',
        status: 'backed',
        backedByToolUseId: 'tool_1',
        backedByToolName: 'webSearch',
      },
      { claim: '7月23號', canonical: 'd:7-23', kind: 'date', status: 'unverified' },
    ])
    expect(mockQuery).toHaveBeenCalledTimes(2)
    // Supersede-on-write: prior ledger rows of the SAME SESSION (any other
    // message) die first — the table's steady state is the latest reply's
    // claims per session.
    const [delSql, delValues] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(delSql).toContain('DELETE FROM claim_provenance')
    expect(delSql).toContain('id <> $1')
    expect(delValues).toEqual(['msg-1'])
    const [sql, values] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO claim_provenance')
    expect((sql.match(/\(\$1,/g) ?? []).length).toBe(2) // both rows share $1
    expect(values![0]).toBe('msg-1')
    expect(values).toContain('n:40000')
    expect(values).toContain('webSearch')
    // Unverified row carries NULL backing columns.
    expect(values!.filter((v) => v === null)).toHaveLength(2)
  })

  it('is a no-op for an empty ledger (no DELETE either)', async () => {
    await insertClaimProvenance('msg-1', [])
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('[COMP:engine/grounding-gate] getClaimsForLatestAssistantMessage', () => {
  it('scopes to the most recent assistant message of the session and maps rows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          claim: '40,000 里',
          canonical: 'n:40000',
          kind: 'amount',
          status: 'unverified',
          backed_by_tool_use_id: null,
          backed_by_tool_name: null,
        },
        {
          claim: 'HK$5,000',
          canonical: 'n:5000',
          kind: 'amount',
          status: 'backed',
          backed_by_tool_use_id: 't9',
          backed_by_tool_name: 'webSearch',
        },
      ],
      rowCount: 2,
    } as never)
    const claims = await getClaimsForLatestAssistantMessage('sess-1')
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("role = 'assistant'")
    expect(sql).toContain('ORDER BY sequence_num DESC')
    expect(values).toEqual(['sess-1'])
    expect(claims).toEqual([
      { claim: '40,000 里', canonical: 'n:40000', kind: 'amount', status: 'unverified' },
      {
        claim: 'HK$5,000',
        canonical: 'n:5000',
        kind: 'amount',
        status: 'backed',
        backedByToolUseId: 't9',
        backedByToolName: 'webSearch',
      },
    ])
  })
})
