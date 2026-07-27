import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionMessages: vi.fn(),
  gateSessionRead: vi.fn(),
}))

vi.mock('../../db/client.js', () => ({ query: mocks.query }))
vi.mock('../../db/sessions.js', () => ({
  getSessionMessages: mocks.getSessionMessages,
}))
vi.mock('../../routes/sessions.js', () => ({
  gateSessionRead: mocks.gateSessionRead,
}))

import { SupportCapsuleBuilder, SupportDiagnosticNotFoundError } from '../bundle.js'
import type {
  SupportDiagnosticCapture,
  SupportDiagnosticsStore,
} from '../types.js'

const capture: SupportDiagnosticCapture = {
  id: '00000000-0000-4000-8000-000000000010',
  userId: '00000000-0000-4000-8000-000000000011',
  workspaceId: '00000000-0000-4000-8000-000000000012',
  includeContent: false,
  pseudonymSalt: Buffer.alloc(32, 3),
  startedAt: new Date('2026-07-27T00:00:00.000Z'),
  expiresAt: new Date('2026-07-28T00:00:00.000Z'),
  eventCount: 1,
}

describe('[COMP:api/support-diagnostics] support capsule builder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not query or export anything without an owned active capture', async () => {
    const store: SupportDiagnosticsStore = {
      start: vi.fn(),
      getAnyActive: vi.fn(),
      getOwnedActive: vi.fn(async () => null),
      appendEvents: vi.fn(),
      listEvents: vi.fn(),
      deleteCapture: vi.fn(),
      deleteOwnedCapture: vi.fn(),
      deleteExpired: vi.fn(),
    }
    const builder = new SupportCapsuleBuilder(store)

    await expect(builder.build({
      userId: 'user-1',
      workspaceId: 'workspace-1',
    })).rejects.toBeInstanceOf(SupportDiagnosticNotFoundError)
  })

  it('builds from allowlisted rows and omits session content by default', async () => {
    const store: SupportDiagnosticsStore = {
      start: vi.fn(),
      getAnyActive: vi.fn(),
      getOwnedActive: vi.fn(async () => capture),
      appendEvents: vi.fn(),
      listEvents: vi.fn(async () => [{
        id: 1,
        supportSessionId: capture.id,
        level: 'error' as const,
        message: 'safe failure',
        fingerprint: 'fingerprint',
        createdAt: capture.startedAt,
      }]),
      deleteCapture: vi.fn(),
      deleteOwnedCapture: vi.fn(),
      deleteExpired: vi.fn(),
    }
    mocks.gateSessionRead.mockResolvedValue(null)
    mocks.getSessionMessages.mockResolvedValue([{
      id: '00000000-0000-4000-8000-000000000020',
      sessionId: '00000000-0000-4000-8000-000000000021',
      role: 'user',
      content: [{ type: 'text', text: 'customer secret' }],
      sequenceNum: 1,
      createdAt: capture.startedAt,
      replyToText: null,
      topicLabel: null,
      topicConfidence: null,
      channelMessageId: null,
      senderUserId: capture.userId,
      attachments: [],
    }])
    mocks.query
      .mockResolvedValueOnce({ rows: [{
        id: '00000000-0000-4000-8000-000000000021',
        assistantId: '00000000-0000-4000-8000-000000000022',
        userId: capture.userId,
        workspaceId: capture.workspaceId,
        channelType: 'web',
        appOrigin: 'chat',
        status: 'idle',
        mode: null,
        visibility: 'owner',
        effectiveClearance: null,
        compactionCount: 0,
        createdAt: capture.startedAt,
        lastActiveAt: capture.startedAt,
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: '00000000-0000-4000-8000-000000000030',
        eventName: 'turn_error',
        metadata: { error: 'alice@example.com', token: 'never-export' },
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ name: '375_support_diagnostics.sql' }] })
      .mockResolvedValueOnce({ rows: [{
        sessions: '1',
        messages: '1',
        analytics: '1',
        failedWorkflows: '0',
      }] })

    const { capsule } = await new SupportCapsuleBuilder(store).build({
      userId: capture.userId,
      workspaceId: capture.workspaceId,
    })
    const serialized = JSON.stringify(capsule)

    expect(capsule.sessionMessages[0]).toMatchObject({
      role: 'user',
      contentShape: { kind: 'blocks', blockCount: 1 },
    })
    expect(serialized).not.toContain('customer secret')
    expect(serialized).not.toContain('alice@example.com')
    expect(serialized).not.toContain('never-export')
    expect(serialized).not.toContain(capture.userId)
    expect(capsule.database.migrations).toContain('375_support_diagnostics.sql')
  })
})
