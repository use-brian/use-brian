import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../../db/client.js'
import { createRecentApprovalChannelResolver, resolveRecentApprovalChannel } from '../recent-approval-channel.js'
const db = vi.mocked(query)
const scope = { workspaceId: 'workspace', assistantId: 'assistant', approverUserId: 'approver' }
beforeEach(() => db.mockReset())

function rows(value: unknown[]) { return { rows: value } as Awaited<ReturnType<typeof query>> }
describe('[COMP:workflow/recent-approval-channel] recent approval channel', () => {
  it('uses the existing transaction connection for both target and integration queries', async () => {
    const transactionQuery = vi.fn<typeof query>()
      .mockResolvedValueOnce(rows([{ channelType: 'telegram', channelId: '123' }]))
      .mockResolvedValueOnce(rows([{ id: 'pinned', observed: true }]))
    // Vitest erases generic result-row inference; the two synthetic shapes are supplied above.
    const resolve = createRecentApprovalChannelResolver(transactionQuery as typeof query)
    expect(await resolve(scope)).toMatchObject({ channelId: '123', channelIntegrationId: 'pinned' })
    expect(transactionQuery).toHaveBeenCalledTimes(2)
    expect(db).not.toHaveBeenCalled()
  })

  it('returns no target when there is no eligible inbound history', async () => {
    db.mockResolvedValueOnce(rows([]))
    expect(await resolveRecentApprovalChannel(scope)).toBeNull()
    expect(db).toHaveBeenCalledTimes(1)
  })

  it('selects by inbound message time, never outbound session activity, and excludes other users/assistants/workspaces', async () => {
    db.mockResolvedValueOnce(rows([]))
    await resolveRecentApprovalChannel(scope)
    const [sql, values] = db.mock.calls[0]
    expect(values).toEqual(['workspace', 'assistant', 'approver'])
    expect(sql).toContain('a.workspace_id = $1 AND s.assistant_id = $2 AND s.user_id = $3')
    expect(sql).toContain("m.role = 'user'")
    expect(sql).toContain('m.sender_user_id IS NULL OR m.sender_user_id = $3')
    expect(sql).toContain('ORDER BY m.created_at DESC, m.id DESC LIMIT 1')
    expect(sql).not.toContain('last_active_at')
    expect(sql).not.toContain("'web'")
  })

  it.each([
    ['telegram', '-100:topic:42', '-100:topic:42', undefined],
    ['slack', 'C123:thread:123.456', 'C123', '123.456'],
    ['feishu', 'oc_chat', 'oc_chat', 'om_message'],
    ['feishu', 'oc_chat:thread:om_root', 'oc_chat', 'om_message'],
  ])('preserves %s conversation routing and pins the integration', async (channelType, stored, channelId, threadRef) => {
    db.mockResolvedValueOnce(rows([{ channelType, channelId: stored, messageId: 'om_message' }]))
      .mockResolvedValueOnce(rows([{ id: 'byo', observed: true }]))
    expect(await resolveRecentApprovalChannel(scope)).toEqual({ channelType, channelId, threadRef, channelIntegrationId: 'byo' })
    expect(db.mock.calls[1][1]).toEqual(expect.arrayContaining(['workspace', 'assistant', channelType, channelId]))
  })

  it('falls back to web after BYO deletion rather than guessing official provenance', async () => {
    db.mockResolvedValueOnce(rows([{ channelType: 'telegram', channelId: '123' }]))
      .mockResolvedValueOnce(rows([]))
    expect(await resolveRecentApprovalChannel(scope)).toBeNull()
  })

  it('stops at the latest WhatsApp conversation without looking up a connector or older channel', async () => {
    db.mockResolvedValueOnce(rows([{ channelType: 'whatsapp', channelId: '123' }]))
    expect(await resolveRecentApprovalChannel(scope)).toBeNull()
    expect(db).toHaveBeenCalledTimes(1)
    expect(db.mock.calls[0][0]).toContain("'whatsapp'")
  })

  it.each([
    ['telegram', '-100:topic:42', '-100:topic:42', '-100'],
    ['telegram', '-100', '-100', '-100'],
    ['slack', 'C123:thread:123.456', 'C123', 'C123'],
  ])('filters %s candidates by the winning exact, parent, then default binding', async (channelType, stored, surface, parent) => {
    db.mockResolvedValueOnce(rows([{ channelType, channelId: stored }]))
      .mockResolvedValueOnce(rows([{ id: 'applicable', observed: false }]))
    expect(await resolveRecentApprovalChannel(scope)).toMatchObject({ channelIntegrationId: 'applicable' })
    const [sql, values] = db.mock.calls[1]
    expect(values).toEqual(['workspace', 'assistant', channelType, surface, parent])
    expect(sql).toContain('AND ca.id = (')
    const winning = sql.slice(sql.indexOf('SELECT winning.id'), sql.indexOf('ORDER BY observed'))
    expect(winning).toContain('winning.channel_id = ci.channel_id')
    expect(winning).toContain('winning.external_surface_id IS NULL')
    expect(winning).toContain('OR winning.external_surface_id = $4')
    expect(winning).toContain('OR winning.external_surface_id = $5')
    expect(winning).toMatch(/WHEN winning.external_surface_id = \$4 THEN 0\s+WHEN winning.external_surface_id = \$5 THEN 1\s+ELSE 2/)
    expect(winning).toContain('LIMIT 1')
    // A more-specific binding to ANOTHER assistant must shadow our default.
    expect(winning).not.toContain('assistant_id')
    expect(sql).toContain('ca.assistant_id = $2')
  })

  it('rejects ambiguity even when multiple applicable integrations observed the chat', async () => {
    db.mockResolvedValueOnce(rows([{ channelType: 'telegram', channelId: '123' }]))
      .mockResolvedValueOnce(rows([{ id: 'one', observed: true }, { id: 'two', observed: true }]))
    expect(await resolveRecentApprovalChannel(scope)).toBeNull()
  })

  it('fails closed for ambiguous integrations', async () => {
    db.mockResolvedValueOnce(rows([{ channelType: 'telegram', channelId: '123' }]))
      .mockResolvedValueOnce(rows([{ id: 'one' }, { id: 'two' }]))
    expect(await resolveRecentApprovalChannel(scope)).toBeNull()
  })

  it('prefers the integration that observed the conversation', async () => {
    db.mockResolvedValueOnce(rows([{ channelType: 'telegram', channelId: '123' }]))
      .mockResolvedValueOnce(rows([{ id: 'one', observed: false }, { id: 'two', observed: true }]))
    expect(await resolveRecentApprovalChannel(scope)).toMatchObject({ channelIntegrationId: 'two' })
  })
})
