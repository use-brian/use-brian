/**
 * Tests for the connector capability grant gate.
 * Component tag: [COMP:safety/assert-action-allowed].
 *
 * Covers the four boundary conditions the runtime depends on:
 *   1. No grant row → denied (the secure default for fresh assistants).
 *   2. Grant row exists but actionKind not in allowedActions → denied.
 *   3. Grant row exists with actionKind allowed → ok.
 *   4. The actor identity does NOT influence the decision — the gate
 *      uses `getForAssistantSystem` because the acting user is whoever
 *      sent the message, not the assistant owner.
 */

import { describe, it, expect, vi } from 'vitest'
import { assertActionAllowed } from '../assert-action-allowed.js'
import type { AssistantConnectorGrantsStore } from '../../db/assistant-connector-grants-store.js'

function buildStore(
  getResult: Awaited<ReturnType<AssistantConnectorGrantsStore['getForAssistantSystem']>>,
): AssistantConnectorGrantsStore {
  return {
    getForAssistantSystem: vi.fn().mockResolvedValue(getResult),
    listForAssistant: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
  }
}

describe('[COMP:safety/assert-action-allowed] grant gate', () => {
  it('denies when no grant row exists (secure default)', async () => {
    const store = buildStore(null)
    const res = await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('action_not_granted')
  })

  it('denies when the action is not in allowedActions', async () => {
    const store = buildStore({
      id: 'g-1',
      assistantId: 'a-1',
      connectorId: 'gmail',
      readAllowed: true,
      allowedActions: ['gmailMarkRead'],
      grantedByUserId: 'u-1',
      grantedAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('action_not_granted')
  })

  it('allows when the action is granted', async () => {
    const store = buildStore({
      id: 'g-1',
      assistantId: 'a-1',
      connectorId: 'gmail',
      readAllowed: true,
      allowedActions: ['gmailSendMessage'],
      grantedByUserId: 'u-1',
      grantedAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(res.ok).toBe(true)
  })

  it('uses the system-level getter so the acting user does not influence the decision', async () => {
    const store = buildStore(null)
    await assertActionAllowed(store, 'a-1', 'gmail', 'gmailSendMessage')
    expect(store.getForAssistantSystem).toHaveBeenCalledWith('a-1', 'gmail')
  })
})
