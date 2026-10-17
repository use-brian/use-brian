import { describe, expect, it, vi } from 'vitest'
import { bindScopeSource, boundScopeSource, type AccessCeiling, type ScopeEvidence } from '@use-brian/core'
import { countsAsGroupAudienceEvidence, filterChannelHistoryForAudience, overlayCurrentRoomMessage } from '../channel-pipeline.js'

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
  it('overlays an addressed attachment on the admitted passive row without changing canonical identity or scope', () => {
    const base = scoped('canonical-input', '3606')
    const caption = [{ type: 'text', text: 'remember these courses' }]
    const passive = bindScopeSource({ ...base, content: caption }, boundScopeSource(base)!)
    const freshContent = [{ type: 'text', text: '<attached_file id="file-1">courses.pdf</attached_file>' },
      { type: 'image', data: 'fresh-image-content', mimeType: 'image/png' }, ...caption]
    const result = overlayCurrentRoomMessage([passive], { id: passive.id, content: freshContent })
    expect(result).toHaveLength(1)
    expect(result![0]).toMatchObject({ id: 'canonical-input', channelMessageId: '3606', content: freshContent })
    expect(boundScopeSource(result![0])).toEqual(boundScopeSource(passive))
    expect(passive.content).toEqual(caption)
  })

  it('does not restore a current input withheld by the bot reader ceiling', async () => {
    const base = scoped('old-restricted-input', '3607')
    const stored = bindScopeSource({ ...base, content: [{ type: 'text', text: 'old restricted input' }] }, boundScopeSource(base)!)
    const rows = await filterChannelHistoryForAudience({ rows: [stored], group: true, ceiling,
      readerCeiling: ceiling, validate: async () => { throw new Error('clearance') } })
    expect(rows).toEqual([])
    expect(overlayCurrentRoomMessage(rows, { id: stored.id, content: [{ type: 'text', text: 'replayed input' }] })).toBeNull()
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
  const params = { channelType: 'slack', session: { id: 'room' } as never, readableHistory: [
    { channelMessageId: 'visible', role: 'assistant', content: [{ type: 'text', text: 'Allowed answer' }], topicLabel: 'Allowed topic' } as never,
  ] }
  await expect(resolveReplyText({ ...params, replyToMessageId: 'hidden' })).resolves.toBeNull()
  await expect(resolveReplyText({ ...params, replyToMessageId: 'visible' })).resolves.toMatchObject({ text: 'Allowed answer' })
})
