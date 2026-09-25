import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { officeCollaborationRoutes, type OfficeCollaborationRouteDeps } from '../office-collaboration.js'

// Invoke captured Express handlers directly: no listening socket or network.
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (req: Request, res: Response) => Promise<void>>() }))
vi.mock('express', () => ({ Router: () => {
  const router: Record<string, unknown> = {}
  for (const method of ['get', 'post', 'patch', 'put', 'delete']) router[method] = (path: string, handler: (req: Request, res: Response) => Promise<void>) => { handlers.set(`${method} ${path}`, handler); return router }
  return router
} }))
const uid = (n: number) => `49000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture(sourceBacked = true) {
  const child = { commandId: uid(4), artifactId: uid(2), baseVersion: 3, actor: { type: 'assistant', id: uid(5) }, origin: 'ai', kind: 'deleteObject', targetId: uid(6) }
  const command = sourceBacked ? { ...child, kind: 'batch', commands: [child], expectedSnapshotHash: 'a'.repeat(64) } : child
  // Batch schemas are strict; targetId belongs only to the child command.
  if (sourceBacked) delete (command as { targetId?: string }).targetId
  const suggestion = { id: uid(3), artifactId: uid(2), status: 'open' as const, commandBatch: command }
  const deps = {
    getArtifact: vi.fn(), resolveAccess: vi.fn(async () => ({ canEdit: true }) as never), getSnapshot: vi.fn(), appendCommand: vi.fn(),
    listThreads: vi.fn(), getThreadContext: vi.fn(), getMessageContext: vi.fn(), createThread: vi.fn(), reply: vi.fn(), resolve: vi.fn(), updateThread: vi.fn(), react: vi.fn(), detachMissingTargets: vi.fn(),
    listSuggestions: vi.fn(), getSuggestion: vi.fn(async () => suggestion), createSuggestion: vi.fn(),
    decideSuggestion: vi.fn(async () => true), applySuggestion: vi.fn(async () => 'applied' as const),
    verifyEvidenceSuggestion: vi.fn(async () => true), suggestionAlreadyApplied: vi.fn(async () => false), service: {} as OfficeCollaborationRouteDeps['service'],
  } satisfies OfficeCollaborationRouteDeps
  async function accept(withVerifier = true) {
    const { verifyEvidenceSuggestion, ...rest } = deps
    officeCollaborationRoutes(withVerifier ? deps : rest)
    const res = { status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res); res.json.mockReturnValue(res)
    await handlers.get('post /suggestions/:suggestionId/decision')!({ userId: uid(1), params: { suggestionId: uid(3) }, body: { decision: 'accepted' } } as unknown as Request, res as unknown as Response)
    return { status: res.status.mock.lastCall?.[0] ?? 200, body: res.json.mock.lastCall?.[0] }
  }
  return { deps, command, accept }
}
describe('[COMP:api/structured-documents] Office evidence acceptance', () => {
  it.each(['false', 'throws', 'absent'] as const)('fails closed with verifier %s, without applying or marking accepted', async mode => {
    const f = fixture()
    if (mode === 'false') f.deps.verifyEvidenceSuggestion.mockResolvedValue(false)
    if (mode === 'throws') f.deps.verifyEvidenceSuggestion.mockRejectedValue(new Error('private provider secret'))
    expect(await f.accept(mode !== 'absent')).toEqual({ status: 409, body: { error: 'suggestion_evidence_unavailable' } })
    expect(f.deps.applySuggestion).not.toHaveBeenCalled()
    expect(f.deps.decideSuggestion).not.toHaveBeenCalled()
  })
  it('verifies before applying and marking accepted', async () => {
    const f = fixture()
    expect(await f.accept()).toEqual({ status: 200, body: { ok: true } })
    expect(f.deps.verifyEvidenceSuggestion).toHaveBeenCalledWith(uid(1), uid(3), f.command)
    expect(f.deps.applySuggestion).toHaveBeenCalledWith({ artifactId: uid(2), suggestionId: uid(3), command: f.command })
    expect(f.deps.decideSuggestion).toHaveBeenCalledWith({ userId: uid(1), suggestionId: uid(3), decision: 'accepted', expectedStatus: 'open' })
    expect(f.deps.verifyEvidenceSuggestion.mock.invocationCallOrder[0]).toBeLessThan(f.deps.applySuggestion.mock.invocationCallOrder[0]!)
    expect(f.deps.applySuggestion.mock.invocationCallOrder[0]).toBeLessThan(f.deps.decideSuggestion.mock.invocationCallOrder[0]!)
  })
  it('repairs a lost decision acknowledgement using the authoritative receipt without applying twice', async () => {
    const f = fixture()
    f.deps.decideSuggestion.mockResolvedValueOnce(false)
    expect((await f.accept()).status).toBe(409)
    f.deps.verifyEvidenceSuggestion.mockResolvedValue(false) // Live snapshot advanced after the successful application.
    f.deps.suggestionAlreadyApplied.mockResolvedValue(true)
    expect(await f.accept()).toEqual({ status: 200, body: { ok: true } })
    expect(f.deps.suggestionAlreadyApplied).toHaveBeenCalledWith(uid(2), uid(3))
    expect(f.deps.applySuggestion).toHaveBeenCalledTimes(1)
    expect(f.deps.decideSuggestion).toHaveBeenCalledTimes(2)
  })
  it('does not treat a failed receipt lookup as permission to apply', async () => {
    const f = fixture()
    f.deps.verifyEvidenceSuggestion.mockResolvedValue(false)
    f.deps.suggestionAlreadyApplied.mockRejectedValue(new Error('unavailable'))
    expect((await f.accept()).status).toBe(409)
    expect(f.deps.applySuggestion).not.toHaveBeenCalled()
    expect(f.deps.decideSuggestion).not.toHaveBeenCalled()
  })
  it('leaves legacy document proposals independent of the evidence verifier', async () => {
    const f = fixture(false)
    f.deps.verifyEvidenceSuggestion.mockRejectedValue(new Error('should not run'))
    expect((await f.accept()).status).toBe(200)
    expect(f.deps.verifyEvidenceSuggestion).not.toHaveBeenCalled()
    expect(f.deps.applySuggestion).toHaveBeenCalledOnce()
    expect((await fixture(false).accept(false)).status).toBe(200)
  })
  it('denies users without edit before verification, application or decision', async () => {
    const f = fixture(); f.deps.resolveAccess.mockResolvedValue({ canEdit: false } as never)
    expect((await f.accept()).status).toBe(404)
    expect(f.deps.verifyEvidenceSuggestion).not.toHaveBeenCalled()
    expect(f.deps.applySuggestion).not.toHaveBeenCalled()
    expect(f.deps.decideSuggestion).not.toHaveBeenCalled()
  })
})
