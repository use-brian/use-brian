import { describe, expect, it, vi } from 'vitest'
import type { CrmStore, ToolContext } from '@use-brian/core'
import { createMailboxContactImportTools } from '../contact-import-tools.js'
import type { MailboxContactCandidate } from '../../db/mailbox-contact-store.js'

const CTX = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  assistantKind: 'standard',
  clearance: 'internal',
} as unknown as ToolContext

function tools(candidates: MailboxContactCandidate[] = [
  { name: 'Alex Example', email: 'alex@example.com', messageCount: 3, lastSentAt: '2026-08-01T00:00:00Z' },
]) {
  const createContact = vi.fn(async (input) => ({ id: input.email }))
  const listCandidates = vi.fn(async () => ({ candidates, scanCapped: false }))
  const built = createMailboxContactImportTools({
    ownerUserId: 'user-1',
    instanceId: 'instance-1',
    accountEmail: 'me@example.com',
    deps: { crm: { createContact } as unknown as CrmStore, listCandidates },
  })
  return { preview: built[0], importTool: built[1], createContact, listCandidates }
}

describe('[COMP:tools/mailbox-contact-import] preview and import', () => {
  it('previews without writing and discloses the bounded confirmed batch', async () => {
    const { preview, createContact } = tools()
    const result = await preview.execute({}, CTX)
    expect(result.data).toMatchObject({ missingContacts: 1, nextBatch: 1 })
    expect(createContact).not.toHaveBeenCalled()
    expect(preview.isReadOnly).toBe(true)
  })

  it('requires confirmation and upserts through the access-scoped CRM store', async () => {
    const { importTool, createContact } = tools()
    expect(importTool.requiresConfirmation).toBe(true)
    const lines = await importTool.describeConfirmation?.({}, CTX)
    expect(lines?.join('\n')).toMatch(/Alex Example <alex@example.com>/)

    const result = await importTool.execute({}, CTX)
    expect(result.data).toMatchObject({ imported: 1, remainingAtPreview: 0 })
    expect(createContact).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      workspaceId: 'workspace-1',
      email: 'alex@example.com',
      tags: ['email-import'],
      access: expect.objectContaining({ workspaceId: 'workspace-1', userId: 'user-1' }),
    }))
  })

  it('imports at most 100 candidates per confirmation', async () => {
    const candidates = Array.from({ length: 130 }, (_, index) => ({
      name: `Person ${index}`,
      email: `person${index}@example.com`,
      messageCount: 1,
      lastSentAt: null,
    }))
    const { importTool, createContact } = tools(candidates)
    const result = await importTool.execute({}, CTX)
    expect(createContact).toHaveBeenCalledTimes(100)
    expect(result.data).toMatchObject({ imported: 100, remainingAtPreview: 30 })
  })
})
