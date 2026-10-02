import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mergeShadowUser } = vi.hoisted(() => ({
  mergeShadowUser: vi.fn(),
}))
vi.mock('../../db/linked-accounts.js', () => ({ mergeShadowUser }))

import { completeLinkClaim, linkClaimReplyText } from '../link-claim.js'

const base = {
  provider: 'feishu' as const,
  realUserId: 'user-real',
  providerId: 'ou_sender',
  evidence: { codeId: 'code-1' },
  receivingAssistant: { id: 'assistant-team', name: 'Ops Brian' },
}

beforeEach(() => {
  mergeShadowUser.mockReset()
})

describe('[COMP:api/link-claim] link-code claim completion', () => {
  it('merges before replying and only then says history moved', async () => {
    let merged = false
    mergeShadowUser.mockImplementation(async () => {
      merged = true
      return { merged: true, shadowUserId: 'shadow' }
    })
    const result = await completeLinkClaim(base)
    expect(merged).toBe(true)
    expect(result.outcome).toBe('merged')
    expect(result.text).toBe(
      'Connected. You now talk to "Ops Brian" as your Use Brian account, and your earlier conversations here moved with you.',
    )
  })

  it('names the assistant that received the code, never the minting one', async () => {
    mergeShadowUser.mockResolvedValue({ merged: false })
    const result = await completeLinkClaim(base)
    expect(result.outcome).toBe('nothing_to_merge')
    expect(result.text).toBe('Connected. You now talk to "Ops Brian" as your Use Brian account.')
  })

  it('reports a failed merge honestly and records identity_merge_failed', async () => {
    mergeShadowUser.mockRejectedValue(Object.assign(new Error('restrict'), { code: '23001' }))
    const logEvent = vi.fn()
    const result = await completeLinkClaim({ ...base, analytics: { logEvent } as never })
    expect(result.outcome).toBe('merge_failed')
    expect(result.text).toContain('could not be moved over')
    expect(result.text).not.toContain('moved with you')
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-real',
      assistantId: 'assistant-team',
      eventName: 'identity_merge_failed',
      channelType: 'feishu',
    }))
  })

  it('falls back to "Brian" when the receiving assistant has no name, with no em dash in any copy', () => {
    for (const outcome of ['merged', 'nothing_to_merge', 'merge_failed'] as const) {
      const text = linkClaimReplyText(outcome, null)
      expect(text).toContain('talk to Brian')
      expect(text).not.toContain('—')
    }
  })
})
