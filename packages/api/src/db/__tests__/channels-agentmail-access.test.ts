/**
 * [COMP:channels/store] AgentMail tool access follows the email Channel's
 * default handling assistant.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { query } from '../client.js'
import {
  countRecentEmailInboxGuestRepliesSystem,
  findWorkspaceMemberUserIdByEmailSystem,
  listAgentmailConnectorInstanceIdsForAssistantSystem,
  pickRoutingForEmail,
  resolveEmailRoutingForWebhook,
  type ChannelAssistant,
} from '../channels-store.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:channels/store] AgentMail handler access', () => {
  it('returns only connector instances joined through the assistant default route', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { connectorInstanceId: 'instance-inbox-1' },
        { connectorInstanceId: 'instance-inbox-2' },
      ],
      rowCount: 2,
    } as never)

    const ids = await listAgentmailConnectorInstanceIdsForAssistantSystem(
      'workspace-1',
      'assistant-1',
    )

    expect(ids).toEqual(['instance-inbox-1', 'instance-inbox-2'])
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("ci.channel_type = 'email'")
    expect(sql).toContain('ca.external_surface_id IS NULL')
    expect(sql).toContain('ca.assistant_id = $2')
    expect(sql).toContain('ci.connector_instance_id IS NOT NULL')
    expect(params).toEqual(['workspace-1', 'assistant-1'])
  })
})

function routing(
  id: string,
  assistantId: string,
  externalSurfaceId: string | null,
  modelAlias: 'standard' | 'pro' | 'max' = 'standard',
): ChannelAssistant {
  return {
    id,
    channelId: 'channel-1',
    assistantId,
    externalSurfaceId,
    modelAlias,
    createdAt: new Date('2026-08-14T00:00:00Z'),
  }
}

describe('[COMP:channels/store] AgentMail sender and thread routing', () => {
  it('prefers thread pin, then exact sender, then the inbox default', () => {
    const rows = [
      routing('default', 'assistant-default', null),
      routing('sender', 'assistant-sales', 'sender:client@example.com'),
      routing('thread', 'assistant-thread', 'thread:thread-1'),
    ]

    expect(pickRoutingForEmail(rows, 'client@example.com', 'thread-1')?.assistantId)
      .toBe('assistant-thread')
    expect(pickRoutingForEmail(rows, 'client@example.com', 'thread-2')?.assistantId)
      .toBe('assistant-sales')
    expect(pickRoutingForEmail(rows, 'other@example.com', 'thread-2')?.assistantId)
      .toBe('assistant-default')
  })

  it('pins a new thread to the chosen sender route and copies its model tier', async () => {
    const selected = routing('sender', 'assistant-sales', 'sender:client@example.com', 'max')
    const pinned = routing('pinned', 'assistant-sales', 'thread:thread-9', 'max')
    mockQuery
      .mockResolvedValueOnce({
        rows: [routing('default', 'assistant-default', null), selected],
        rowCount: 2,
      } as never)
      .mockResolvedValueOnce({ rows: [pinned], rowCount: 1 } as never)

    await expect(resolveEmailRoutingForWebhook(
      'channel-1',
      'CLIENT@example.com',
      'thread-9',
      true,
    )).resolves.toEqual(pinned)

    const [insertSql, insertParams] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(insertSql).toContain('ON CONFLICT (channel_id, external_surface_id)')
    expect(insertSql).toContain('DO NOTHING')
    expect(insertParams).toEqual(['channel-1', 'assistant-sales', 'thread:thread-9', 'max'])
  })

  it('does not create a thread pin for a gated sender', async () => {
    const fallback = routing('default', 'assistant-default', null)
    mockQuery.mockResolvedValueOnce({ rows: [fallback], rowCount: 1 } as never)

    await expect(resolveEmailRoutingForWebhook(
      'channel-1',
      'stranger@example.com',
      'thread-10',
      false,
    )).resolves.toEqual(fallback)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('elevates trust only for an exact workspace-member email', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-1' }], rowCount: 1 } as never)

    await expect(findWorkspaceMemberUserIdByEmailSystem(
      'workspace-1',
      ' Member@Example.com ',
    )).resolves.toBe('user-1')

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('lower(u.email) = $2')
    expect(sql).toContain('wm.workspace_id = $1')
    expect(params).toEqual(['workspace-1', 'member@example.com'])
  })

  it('counts inbox-wide guest replies through email thread pins', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '30' }], rowCount: 1 } as never)

    await expect(countRecentEmailInboxGuestRepliesSystem(
      'channel-1',
      'workspace-1',
    )).resolves.toBe(30)

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("ca.external_surface_id = 'thread:' || s.channel_id")
    expect(sql).toContain('wm.user_id IS NULL')
    expect(sql).toContain("sm.created_at > now() - interval '1 hour'")
    expect(params).toEqual(['channel-1', 'workspace-1'])
  })
})
