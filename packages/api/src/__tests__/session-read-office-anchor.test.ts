/**
 * [COMP:api/pending-approvals-store] The Office-file anchor of the shared
 * session read gate (`anchorReadGate`, session-read-authority.ts). The Office
 * access predicate loads only when an Office thread is read, never when the
 * module is imported on the chat path (M4 step 5), and the gate still answers
 * exactly as the file's audience decides.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ officeLoads: 0, link: null as { artifactId: string } | null, allowed: false }))

vi.mock('../office/access.js', () => {
  state.officeLoads++
  return { resolveOfficeAccess: vi.fn(async () => state.allowed) }
})
vi.mock('../db/office-artifact-sessions.js', () => ({ findOfficeArtifactForSessionSystem: vi.fn(async () => state.link) }))
vi.mock('../content-planning/collaboration-service.js', () => ({ findFeedThreadDraft: vi.fn() }))
vi.mock('../db/feed-collaboration-store.js', () => ({ getFeedCollaboration: vi.fn() }))
vi.mock('../db/users.js', () => ({ getUserAssistant: vi.fn() }))
vi.mock('../db/client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn() }))
vi.mock('../db/workspace-store.js', () => ({ getWorkspaceMembershipWithReadScopeSystem: vi.fn() }))

import { anchorReadGate } from '../session-read-authority.js'

const officeThread = { id: 'session-1', channelType: 'web', assistantId: 'assistant-1', visibility: 'workspace', mode: null, anchorKind: 'office_file' }

describe('[COMP:api/pending-approvals-store] Office anchor of the session read gate', () => {
  beforeEach(() => { state.link = null; state.allowed = false })

  it('does not load the Office access predicate at import or for a thread without an Office link', async () => {
    expect(state.officeLoads).toBe(0)
    await expect(anchorReadGate('user-1', officeThread)).resolves.toEqual({ status: 404, error: 'Session not found' })
    expect(state.officeLoads).toBe(0)
  })

  it('refuses a reader outside the file audience and admits one inside it', async () => {
    state.link = { artifactId: 'artifact-1' }
    await expect(anchorReadGate('user-1', officeThread)).resolves.toEqual({ status: 404, error: 'Session not found' })
    expect(state.officeLoads).toBe(1)
    state.allowed = true
    await expect(anchorReadGate('user-1', officeThread)).resolves.toBeNull()
  })
})
