import { describe, expect, it, vi } from 'vitest'
import { readNativeSessionQueryEvidence } from '../native-session-query-evidence.js'

const workspaceId = '00000000-0000-4000-8000-000000000101'
const selection = { sessionId: '00000000-0000-4000-8000-000000000102', throughSequence: 3, topicThroughSequence: 2 }
const source = { workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [],
  resourceKind: 'application_field', resourceId: '00000000-0000-4000-8000-000000000103', version: 'fictional-version' }
const packet = { history: [{ row: null, sources: [source] }], annotations: [{ row: null, sources: [source] }],
  proof: { admitted: true, immutable: [source], current: [source] } }

describe('[COMP:api/native-turn-frame] optional canonical query acquisition adapter', () => {
  it('uses the new admitted packet without invoking the legacy reader', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ available: true }] }).mockResolvedValueOnce({ rows: [{ value: packet }] })
    const result = await readNativeSessionQueryEvidence({ query }, workspaceId, selection)
    expect(result?.captures).toEqual({ history: packet.history, annotations: packet.annotations })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]).toEqual(['SELECT read_native_turn_session_query($1,$2,$3,$4) AS value', [workspaceId, selection.sessionId, 3, 2]])
  })
  it('retains the existing reader before the optional migration is installed', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ available: false }] }).mockResolvedValueOnce({ rows: [{ value: packet }] })
    expect(await readNativeSessionQueryEvidence({ query }, workspaceId, selection)).not.toBeNull()
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][0]).toContain('SELECT read_native_session_query_evidence(')
  })
  it('uses the unchanged legacy reader after a pre-write unavailable result', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ available: true }] })
      .mockResolvedValueOnce({ rows: [{ value: null }] }).mockResolvedValueOnce({ rows: [{ value: packet }] })
    expect(await readNativeSessionQueryEvidence({ query }, workspaceId, selection)).not.toBeNull()
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[2][0]).toContain('SELECT read_native_session_query_evidence(')
  })
  it('propagates post-write errors without invoking a fallback reader', async () => {
    const refusal = Object.assign(new Error('scope_source_changed'), { code: '42501' })
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ available: true }] }).mockRejectedValueOnce(refusal)
    await expect(readNativeSessionQueryEvidence({ query }, workspaceId, selection)).rejects.toBe(refusal)
    expect(query).toHaveBeenCalledTimes(2)
  })
  it('rejects a malformed packet without retrying acquisition', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ available: true }] })
      .mockResolvedValueOnce({ rows: [{ value: { ...packet, history: [] } }] })
    await expect(readNativeSessionQueryEvidence({ query }, workspaceId, selection)).rejects.toBeDefined()
    expect(query).toHaveBeenCalledTimes(2)
  })
})
