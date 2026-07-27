import { afterEach, describe, expect, it, vi } from 'vitest'
import { SupportDiagnosticsCaptureManager } from '../capture.js'
import type {
  PendingSupportDiagnosticEvent,
  SupportDiagnosticCapture,
  SupportDiagnosticsStore,
} from '../types.js'

const capture: SupportDiagnosticCapture = {
  id: 'capture-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  includeContent: false,
  pseudonymSalt: Buffer.alloc(32, 4),
  startedAt: new Date(),
  expiresAt: new Date(Date.now() + 60_000),
  eventCount: 0,
}

describe('[COMP:api/support-diagnostics-capture] console capture manager', () => {
  let manager: SupportDiagnosticsCaptureManager | null = null

  afterEach(async () => {
    await manager?.stop()
    manager = null
  })

  it('mirrors sanitized events asynchronously without replacing the console sink', async () => {
    const appended: PendingSupportDiagnosticEvent[] = []
    const store: SupportDiagnosticsStore = {
      start: vi.fn(),
      getAnyActive: vi.fn(async () => capture),
      getOwnedActive: vi.fn(),
      appendEvents: vi.fn(async (_captureId, events) => { appended.push(...events) }),
      listEvents: vi.fn(),
      deleteCapture: vi.fn(),
      deleteOwnedCapture: vi.fn(),
      deleteExpired: vi.fn(async () => []),
    }
    const originalWarn = console.warn
    manager = new SupportDiagnosticsCaptureManager(store)
    await manager.start()

    console.warn('request failed', {
      prompt: 'private prompt',
      email: 'alice@example.com',
    })
    await manager.flush()

    expect(appended).toHaveLength(1)
    expect(appended[0]?.level).toBe('warn')
    expect(appended[0]?.message).not.toContain('private prompt')
    expect(appended[0]?.message).not.toContain('alice@example.com')

    await manager.stop()
    manager = null
    expect(console.warn).toBe(originalWarn)
  })
})
