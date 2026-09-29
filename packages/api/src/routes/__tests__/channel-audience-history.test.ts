import { describe, expect, it, vi } from 'vitest'
import { bindScopeSource, type AccessCeiling, type ScopeEvidence } from '@use-brian/core'
import { filterChannelHistoryForAudience } from '../channel-pipeline.js'

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
})
