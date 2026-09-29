import { describe, expect, it, vi } from 'vitest'
import { createPersonalGroupVerifier } from '../personal-group-membership.js'

const CHAT = '-100777'
const RECIPIENT = '22222222-2222-4222-8222-222222222222'
const BOTS = ['9001', '9002', '9003']
const LINKED = ['5550001', '5550002']

function verifier(options: {
  count?: number
  statuses?: Record<string, string>
  bots?: string[]
  linked?: string[]
  fail?: boolean
  now?: () => number
} = {}) {
  const statuses: Record<string, string> = {
    ...Object.fromEntries(BOTS.map((id) => [id, 'administrator'])),
    [LINKED[0]!]: 'creator',
    [LINKED[1]!]: 'left',
    ...options.statuses,
  }
  const getChatMember = vi.fn(async (_chat: string, userId: string) => {
    if (options.fail) throw new Error('Bad Request: member list is inaccessible')
    return { status: statuses[userId] ?? 'left' }
  })
  const getChatMemberCount = vi.fn(async () => options.count ?? 4)
  const verify = createPersonalGroupVerifier({
    api: () => ({ getChatMemberCount, getChatMember }),
    listBots: vi.fn(async () => options.bots ?? BOTS),
    listLinked: vi.fn(async () => options.linked ?? LINKED),
    now: options.now,
  })
  return { verify, getChatMemberCount }
}

const input = { channelType: 'telegram', chatId: CHAT, recipientUserId: RECIPIENT, botToken: '9001:FICTIONAL' }

describe('[COMP:api/personal-group-membership] live personal-group proof', () => {
  it('verifies a group whose only human is one of the recipient linked accounts', async () => {
    // 3 bots + 1 linked human = 4 members.
    await expect(verifier().verify(input)).resolves.toBe(true)
  })

  it('refuses when anyone else is in the group', async () => {
    await expect(verifier({ count: 5 }).verify(input)).resolves.toBe(false)
  })

  it('does not subtract a known bot that has left, so it cannot hide a person', async () => {
    await expect(verifier({ statuses: { '9003': 'left' } }).verify(input)).resolves.toBe(false)
  })

  it('refuses an unknown bot rather than guessing it is not a person', async () => {
    await expect(verifier({ count: 5, bots: BOTS }).verify(input)).resolves.toBe(false)
  })

  it('refuses when the recipient has no linked Telegram account', async () => {
    await expect(verifier({ linked: [] }).verify(input)).resolves.toBe(false)
  })

  it('refuses when the recipient linked account is not in the group', async () => {
    await expect(verifier({ statuses: { [LINKED[0]!]: 'left' } }).verify(input)).resolves.toBe(false)
  })

  it('treats a Telegram API failure as unverified', async () => {
    await expect(verifier({ fail: true }).verify(input)).resolves.toBe(false)
  })

  it('refuses non-Telegram channels and a missing bot token', async () => {
    const { verify } = verifier()
    await expect(verify({ ...input, channelType: 'slack' })).resolves.toBe(false)
    await expect(verify({ ...input, botToken: null })).resolves.toBe(false)
  })

  it('caches a success only briefly', async () => {
    let clock = 0
    const { verify, getChatMemberCount } = verifier({ now: () => clock })
    await verify(input)
    await verify(input)
    expect(getChatMemberCount).toHaveBeenCalledTimes(1)
    clock = 10_001
    await verify(input)
    expect(getChatMemberCount).toHaveBeenCalledTimes(2)
  })
})
