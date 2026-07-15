import { describe, it, expect } from 'vitest'
import { createAgentmailClient } from '../client.js'
import { createAgentmailEmailProvider } from '../provider.js'

/**
 * Live-AgentMail integration checks (skipped without AGENTMAIL_API_KEY, the
 * repo's integration-test convention). Exercises the inbox lifecycle against
 * the real API: create (idempotent via client_id) → get → draft → delete.
 * Free-tier friendly: everything it creates it deletes; no mail is sent.
 */
const apiKey = process.env.AGENTMAIL_API_KEY
const describeIf = apiKey ? describe : describe.skip

describeIf('[COMP:api/agentmail-client] AgentMail live integration', () => {
  const provider = createAgentmailEmailProvider(createAgentmailClient({ apiKey: apiKey as string }))

  it('inbox lifecycle: create is idempotent on clientId, get resolves, delete removes', async () => {
    const clientId = `sidanclaw-it-${Date.now()}`
    const created = await provider.createInbox({ clientId, displayName: 'sidanclaw integration test' })
    try {
      expect(created.inboxId).toContain('@')

      const again = await provider.createInbox({ clientId, displayName: 'sidanclaw integration test' })
      expect(again.inboxId).toBe(created.inboxId)

      const fetched = await provider.getInbox(created.inboxId)
      expect(fetched?.email).toBe(created.email)

      const draft = await provider.createDraft(created.inboxId, {
        to: ['nobody@example.com'],
        subject: 'draft (never sent)',
        text: 'integration-test draft — deleted immediately',
      })
      expect(draft.draftId).toBeTruthy()
      await provider.deleteDraft(created.inboxId, draft.draftId)
    } finally {
      await provider.deleteInbox(created.inboxId)
    }
    expect(await provider.getInbox(created.inboxId)).toBeNull()
  }, 60_000)
})
