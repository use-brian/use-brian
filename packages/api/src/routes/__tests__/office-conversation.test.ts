/**
 * Artifact-scoped routes to an Office file's shared conversation.
 * [COMP:api/office-chat-session]
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 */
import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { officeConversationRoutes, type OfficeConversationDeps } from '../office-conversation.js'
import type { ResolvedOfficeAccess } from '../../office/access.js'

const ARTIFACT = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'

function access(role: 'view' | 'comment' | 'edit', mode: ResolvedOfficeAccess['mode'] = 'artifact'): ResolvedOfficeAccess {
  return { artifactId: ARTIFACT, workspaceId: 'w', mode, role, workspaceRole: 'member', lifecycleState: 'active', canView: true,
    canComment: role !== 'view', canEdit: role === 'edit', canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false }
}

function app(role: 'view' | 'comment' | 'edit' | null, existing: string | null = null, mode?: ResolvedOfficeAccess['mode']) {
  const deps: OfficeConversationDeps = {
    resolveAccess: vi.fn(async () => role ? access(role, mode) : null),
    findSession: vi.fn(async () => existing ? { artifactId: ARTIFACT, workspaceId: 'w', sessionId: existing } : null),
    ensureSession: vi.fn(async () => ({ artifactId: ARTIFACT, workspaceId: 'w', sessionId: SESSION })),
    workspaceAssistant: vi.fn(async () => ({ id: 'assistant', name: 'Brian' })),
  }
  const server = express()
  server.use((req, _res, next) => { (req as { userId?: string }).userId = 'user'; next() })
  server.use('/api/office', officeConversationRoutes(deps))
  return { server, deps }
}

describe('[COMP:api/office-chat-session] conversation routes', () => {
  it('404s a caller who cannot read the file, with no existence signal', async () => {
    const { server, deps } = app(null, SESSION)
    expect((await request(server).get(`/api/office/artifacts/${ARTIFACT}/conversation`)).status).toBe(404)
    expect((await request(server).post(`/api/office/artifacts/${ARTIFACT}/conversation`)).status).toBe(404)
    expect(deps.findSession).not.toHaveBeenCalled()
    expect(deps.ensureSession).not.toHaveBeenCalled()
  })

  it('never serves a PDF editing session as a shared conversation', async () => {
    expect((await request(app('edit', null, 'session').server).get(`/api/office/artifacts/${ARTIFACT}/conversation`)).status).toBe(404)
  })

  it('lets a View-only reader read the thread but not send', async () => {
    const { server, deps } = app('view', SESSION)
    const read = await request(server).get(`/api/office/artifacts/${ARTIFACT}/conversation`)
    expect(read.body).toMatchObject({ sessionId: SESSION, canSend: false, role: 'view' })
    const send = await request(server).post(`/api/office/artifacts/${ARTIFACT}/conversation`)
    expect(send.status).toBe(403)
    expect(deps.ensureSession).not.toHaveBeenCalled()
  })

  it('creates the thread lazily for a Comment or Edit sender', async () => {
    for (const role of ['comment', 'edit'] as const) {
      const { server, deps } = app(role)
      expect((await request(server).get(`/api/office/artifacts/${ARTIFACT}/conversation`)).body).toMatchObject({ sessionId: null, canSend: true })
      const created = await request(server).post(`/api/office/artifacts/${ARTIFACT}/conversation`)
      expect(created.status).toBe(201)
      expect(created.body).toEqual({ sessionId: SESSION, assistant: { id: 'assistant', name: 'Brian' } })
      expect(deps.ensureSession).toHaveBeenCalledWith({ artifactId: ARTIFACT, assistantId: 'assistant', userId: 'user' })
    }
  })
})
