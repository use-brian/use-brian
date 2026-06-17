/**
 * Unit tests for the sensitivity-reclassification DB adapters.
 * Component tag: [COMP:corrections/sensitivity-reclassification-store].
 *
 * Mocks the pg pool/client. Verifies the
 * `SensitivityReclassificationRepository` +
 * `ChannelSensitivityRuleRepository` ports: row reads (incl. the episode
 * NULL projection), the transactional reclassify + audit envelope, the
 * episode-only derivation hop, channel-rule reads, and the
 * insert-new-then-supersede-prior rule envelope.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const poolQueries: { text: string; values?: unknown[] }[] = []
const clientQueries: { text: string; values?: unknown[] }[] = []
let poolRows: Record<string, unknown>[] = []

const fakeClient = {
  query: vi.fn(),
  release: vi.fn(),
}
const fakePool = {
  query: vi.fn(),
  connect: vi.fn(async () => fakeClient),
}

vi.mock('../client.js', () => ({
  getPool: () => fakePool,
  query: (text: string, values?: unknown[]) => fakePool.query(text, values),
}))

import {
  createSensitivityReclassificationStore,
  createChannelSensitivityRuleStore,
} from '../sensitivity-reclassification-store.js'

const rowStore = createSensitivityReclassificationStore()
const ruleStore = createChannelSensitivityRuleStore()
const NOW = new Date('2026-05-18T12:00:00Z')

beforeEach(() => {
  poolQueries.length = 0
  clientQueries.length = 0
  poolRows = []
  fakeClient.query.mockReset()
  fakeClient.query.mockImplementation(async (text: string, values?: unknown[]) => {
    clientQueries.push({ text, values })
    return { rows: [], rowCount: 1 }
  })
  fakeClient.release.mockClear()
  fakePool.query.mockReset()
  fakePool.query.mockImplementation(async (text: string, values?: unknown[]) => {
    poolQueries.push({ text, values })
    return { rows: poolRows, rowCount: poolRows.length }
  })
  fakePool.connect.mockClear()
})

describe('[COMP:corrections/sensitivity-reclassification-store] createSensitivityReclassificationStore', () => {
  it('readRowForReclassification maps a row to a snapshot', async () => {
    poolRows = [
      { rowId: 'm-1', workspaceId: 'ws-1', sensitivity: 'internal', sourceEpisodeId: 'ep-1', validTo: null },
    ]
    const snap = await rowStore.readRowForReclassification('memory', 'ws-1', 'm-1')
    expect(snap).toEqual({
      primitive: 'memory',
      rowId: 'm-1',
      workspaceId: 'ws-1',
      sensitivity: 'internal',
      sourceEpisodeId: 'ep-1',
      validTo: null,
    })
    expect(poolQueries[0].text).toContain('FROM memories')
  })

  it('readRowForReclassification projects episode source_episode_id / valid_to as NULL', async () => {
    poolRows = [
      { rowId: 'ep-1', workspaceId: 'ws-1', sensitivity: 'internal', sourceEpisodeId: null, validTo: null },
    ]
    await rowStore.readRowForReclassification('episode', 'ws-1', 'ep-1')
    expect(poolQueries[0].text).toContain('NULL::uuid AS "sourceEpisodeId"')
    expect(poolQueries[0].text).toContain('FROM episodes')
  })

  it('readRowForReclassification returns null when absent', async () => {
    poolRows = []
    expect(await rowStore.readRowForReclassification('memory', 'ws-1', 'ghost')).toBeNull()
  })

  it('applyRowReclassification updates sensitivity and writes the audit row', async () => {
    await rowStore.applyRowReclassification({
      primitive: 'memory',
      workspaceId: 'ws-1',
      rowId: 'm-1',
      priorSensitivity: 'internal',
      newSensitivity: 'confidential',
      direction: 'upgrade',
      triggeredBy: 'per_row_operator',
      ruleId: null,
      actorUserId: 'op-1',
      reason: 'contains comp data',
      now: NOW,
    })
    const texts = clientQueries.map((q) => q.text)
    expect(texts[0]).toBe('BEGIN')
    expect(texts.find((t) => t.startsWith('UPDATE'))).toContain('UPDATE memories SET sensitivity')
    expect(texts.some((t) => t.includes('INSERT INTO sensitivity_reclassifications'))).toBe(true)
    expect(texts[texts.length - 1]).toBe('COMMIT')
  })

  it('findDerivedRows resolves the episode → derived-row hop', async () => {
    fakePool.query.mockImplementation(async (text: string, values?: unknown[]) => {
      poolQueries.push({ text, values })
      if (text.includes('FROM memories')) {
        return { rows: [{ rowId: 'm-1', sensitivity: 'internal' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    const derived = await rowStore.findDerivedRows({
      workspaceId: 'ws-1',
      sourceRowId: 'ep-1',
      sourcePrimitive: 'episode',
    })
    expect(derived).toEqual([{ primitive: 'memory', rowId: 'm-1', sensitivity: 'internal' }])
  })

  it('findDerivedRows returns [] for a non-episode source (no schema link)', async () => {
    const derived = await rowStore.findDerivedRows({
      workspaceId: 'ws-1',
      sourceRowId: 'm-1',
      sourcePrimitive: 'memory',
    })
    expect(derived).toEqual([])
    expect(poolQueries).toHaveLength(0)
  })
})

describe('[COMP:corrections/sensitivity-reclassification-store] createChannelSensitivityRuleStore', () => {
  it('readRule maps a rule row', async () => {
    poolRows = [
      {
        id: 'r-1',
        workspaceId: 'ws-1',
        sourceKind: 'slack',
        sourceRefMatch: { channel: 'C1' },
        defaultSensitivity: 'confidential',
        appliedFrom: NOW,
        supersededAt: null,
        supersededBy: null,
      },
    ]
    const rule = await ruleStore.readRule('ws-1', 'r-1')
    expect(rule!.sourceKind).toBe('slack')
    expect(rule!.defaultSensitivity).toBe('confidential')
    expect(rule!.sourceRefMatch).toEqual({ channel: 'C1' })
  })

  it('readRule returns null when absent', async () => {
    poolRows = []
    expect(await ruleStore.readRule('ws-1', 'ghost')).toBeNull()
  })

  it('insertSupersedingRule inserts the new rule then supersedes the prior one', async () => {
    fakeClient.query.mockImplementation(async (text: string, values?: unknown[]) => {
      clientQueries.push({ text, values })
      if (text.includes('INSERT INTO channel_sensitivity_rules')) {
        return { rows: [{ id: 'r-2' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    const { newRuleId } = await ruleStore.insertSupersedingRule({
      workspaceId: 'ws-1',
      priorRuleId: 'r-1',
      newRule: { sourceKind: 'slack', sourceRefMatch: {}, defaultSensitivity: 'confidential' },
      actorUserId: 'op-1',
      reason: 'tighten channel',
      now: NOW,
    })
    expect(newRuleId).toBe('r-2')
    const supersede = clientQueries.find((q) => q.text.includes('superseded_at'))
    expect(supersede!.values).toEqual(['r-1', NOW, 'r-2', 'ws-1'])
    expect(clientQueries.map((q) => q.text).pop()).toBe('COMMIT')
  })

  it('findRowsUnderRuleScope returns rows the rule has reclassified', async () => {
    poolRows = [{ primitive: 'memory', rowId: 'm-1', sensitivity: 'internal' }]
    const rows = await ruleStore.findRowsUnderRuleScope({ workspaceId: 'ws-1', ruleId: 'r-1' })
    expect(rows).toEqual([
      {
        primitive: 'memory',
        rowId: 'm-1',
        workspaceId: 'ws-1',
        sensitivity: 'internal',
        sourceEpisodeId: null,
        validTo: null,
      },
    ])
    expect(poolQueries[0].text).toContain('FROM sensitivity_reclassifications')
    expect(poolQueries[0].text).toContain('rule_id = $2')
  })
})
