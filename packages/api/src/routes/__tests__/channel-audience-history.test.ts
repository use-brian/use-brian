import { describe, expect, it, vi } from 'vitest'
import { bindScopeSource, bindScopeSources, boundScopeSources, type AccessCeiling, type ScopeEvidence } from '@use-brian/core'
import { countsAsGroupAudienceEvidence, filterChannelHistoryForAudience } from '../channel-pipeline.js'

const ceiling: AccessCeiling = {
  workspaceId: 'workspace-1',
  userId: '',
  clearance: 'public',
  compartments: [],
  mutationCompartments: [],
  projectIds: [],
  visibilityAssistantIds: null,
}

function scoped(id: string, channelMessageId: string | null) {
  return bindScopeSource({ id, channelMessageId }, {
    workspaceId: 'workspace-1',
    userId: null,
    assistantId: 'assistant-1',
    sensitivity: 'internal',
    compartments: ['finance'],
    projectIds: [],
    resourceKind: 'session_message',
    resourceId: id,
    version: '1',
  })
}

describe('[COMP:api/delivery-authority] provider-visible channel history', () => {
  it('passes every contributor to both reader and audience admission', async () => {
    const row = scoped('compound-history',null), first = boundScopeSources(row)[0]
    bindScopeSources(row,[{ ...first,resourceKind: 'external_source',resourceId: 'independent-field-observation' }])
    const validate = vi.fn(async (evidence: ScopeEvidence) => evidence)
    await expect(filterChannelHistoryForAudience({ rows: [row],group: true,ceiling,readerCeiling: ceiling,validate })).resolves.toEqual([row])
    expect(validate).toHaveBeenCalledTimes(2)
    for (const [evidence] of validate.mock.calls) expect(evidence.sources?.map(source => source.resourceId))
      .toEqual(['compound-history','independent-field-observation'])
  })

  it('withholds the whole history row when one bound contributor is refused', async () => {
    const row = scoped('compound-history',null), first = boundScopeSources(row)[0]
    bindScopeSources(row,[{ ...first,resourceKind: 'external_source',resourceId: 'refused-field-observation' }])
    const validate = vi.fn(async (evidence: ScopeEvidence) => {
      if (evidence.sources?.some(source => source.resourceId === 'refused-field-observation')) throw new Error('Source unavailable')
      return evidence
    })
    await expect(filterChannelHistoryForAudience({ rows: [row],group: true,ceiling,validate })).resolves.toEqual([])
  })

  it('keeps audience-owned rows but validates every hidden result', async () => {
    const validate = vi.fn(async (evidence: ScopeEvidence) => {
      const ids = (evidence.sources ?? []).map((source) => source.resourceId)
      if (!ids.includes('hidden-public')) throw new Error('outside audience')
      return evidence
    })
    const rows = [
      scoped('legacy-greeting', 'provider-message-1'),
      scoped('hidden-internal', null),
      scoped('hidden-public', null),
      { id: 'legacy-hidden-unclassified', channelMessageId: null },
    ]

    const filtered = await filterChannelHistoryForAudience({
      rows,
      group: true,
      ceiling,
      validate,
    })

    expect(filtered.map((row) => row.id)).toEqual([
      'legacy-greeting',
      'hidden-public',
    ])
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('does not alter private-message history', async () => {
    const rows = [{ id: 'dm-row', channelMessageId: null }]
    await expect(filterChannelHistoryForAudience({
      rows,
      group: false,
      ceiling,
    })).resolves.toEqual(rows)
  })

  // A group row with a provider id was already shown to the group; its stamp
  // is the room's read floor, not something the turn read (2026-10-13).
  it('does not count a group row the group already saw as evidence', () => {
    expect(countsAsGroupAudienceEvidence({ channelMessageId: '4417' }, true)).toBe(false)
    expect(countsAsGroupAudienceEvidence({ channelMessageId: null }, true)).toBe(true)
    expect(countsAsGroupAudienceEvidence({ channelMessageId: '4417' }, false)).toBe(true)
  })
})


it('[COMP:api/delivery-authority] checks a bot reader even for history visible to the human group', async () => {
  const validate = vi.fn(async (evidence: ScopeEvidence, limit: AccessCeiling) => {
    const source = evidence.sources![0]!
    if (source.resourceId === 'old-confidential' && limit.clearance === 'internal') throw new Error('clearance')
    return evidence
  })
  const rows = [scoped('old-confidential', 'telegram-1'), scoped('current-internal', 'telegram-2'), { id: 'unknown', channelMessageId: 'telegram-3' }]
  const result = await filterChannelHistoryForAudience({ rows, group: true,
    ceiling: { ...ceiling, clearance: 'confidential' }, readerCeiling: { ...ceiling, clearance: 'internal' }, validate })
  expect(result.map(row => row.id)).toEqual(['current-internal'])
})


it('[COMP:api/delivery-authority] resolves stored reply context only from authorized room rows', async () => {
  const { resolveReplyText } = await import('../_reply-context.js')
  const visible = { sessionId: 'room', channelMessageId: 'visible', role: 'assistant', content: [{ type: 'text', text: 'Allowed answer' }], topicLabel: 'Allowed topic' }
  const otherRoom = { ...visible, sessionId: 'other-room', content: [{ type: 'text', text: 'Other room answer' }] }
  const params = { channelType: 'slack', session: { id: 'room' } as never, readableHistory: [otherRoom, visible] as never }
  await expect(resolveReplyText({ ...params, replyToMessageId: 'hidden' })).resolves.toBeNull()
  await expect(resolveReplyText({ ...params, replyToMessageId: 'visible' })).resolves.toMatchObject({ text: 'Allowed answer', messageId: 'visible', fromAssistant: true, topicLabel: 'Allowed topic' })
  await expect(resolveReplyText({ ...params, readableHistory: [otherRoom] as never, replyToMessageId: 'visible' })).resolves.toBeNull()
})
