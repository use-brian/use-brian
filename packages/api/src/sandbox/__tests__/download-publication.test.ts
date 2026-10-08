import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('../../db/client.js', () => ({ queryWithRLS: vi.fn() }))
vi.mock('../../db/users.js', () => ({ findAssistantById: vi.fn() }))
vi.mock('../task-execution-authority.js', () => ({ resolveBrowserTaskExecutionAuthority: vi.fn() }))
import { prepareBrowserDownload, type DownloadTask } from '../download-publication.js'
import { queryWithRLS } from '../../db/client.js'
import { findAssistantById } from '../../db/users.js'
import { resolveBrowserTaskExecutionAuthority } from '../task-execution-authority.js'
import { assertCurrentAuthority, executeWithCurrentAuthority } from '../../context-scope/authority-lease.js'
import type { FilesApi, FilesContext, CurrentAuthorityBoundary } from '@use-brian/core'

const u = '11111111-1111-4111-8111-111111111111', w = '22222222-2222-4222-8222-222222222222'
const a = '33333333-3333-4333-8333-333333333333', s = '44444444-4444-4444-8444-444444444444'
const d = '55555555-5555-4555-8555-555555555555', p = '66666666-6666-4666-8666-666666666666'
const file = { path: '/source/file', name: 'example.txt', mime: 'text/plain', bytes: Buffer.from('fictional') }
function fixture() {
  let allowed = true
  const boundary: CurrentAuthorityBoundary = { async assertCurrent() { if (!allowed) throw new Error('Revoked') },
    async execute<T>(f: () => Promise<T>) { await this.assertCurrent(); const r = await f(); await this.assertCurrent(); return r } }
  const task: DownloadTask = { taskId: 'task', userId: u, workspaceId: w, sessionId: s, profileId: p,
    profileAuthority: { id: p, workspaceId: w, ownerUserId: u, departmentId: d, scope: 'owner', clearance: 'internal' },
    executionAuthority: { version: 1, assistantId: a, ceiling: { workspaceId: w, userId: u, clearance: 'internal', compartments: [`team:${d}`], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [a] } },
    sourceAuthority: { version: 1, kind: 'session', invocationId: s, id: s, userId: u, assistantId: a, workspaceId: w,
      executingAssistantId: a, authorityUserId: u, contextGroupId: d, contextProjectId: null, contextLockedAt: '2026-10-01T00:00:00.000Z',
      visibility: 'owner', mode: null, effectiveClearance: 'internal', contextCompartments: [`team:${d}`], memberMode: 'enforce', ignoreSessionBinding: false, systemRead: false },
    inputScope: { sensitivity: 'internal', compartments: [`team:${d}`], projectIds: [], sources: [] } }
  let active: DownloadTask | null = task
  const source = (kind: string, id: string) => ({ workspaceId: w, resourceKind: kind, resourceId: id, version: '1',
    userId: u, assistantId: null, sensitivity: 'internal', compartments: [`team:${d}`], projectIds: [], held: false })
  vi.mocked(queryWithRLS).mockImplementation(async (_actor, sql, args) => ({ rows: sql.includes('owner_user_id')
    ? [{ owner_user_id: u }] : [{ source: source(args![1] as string, args![2] as string) }] }) as never)
  vi.mocked(findAssistantById).mockResolvedValue({ id: a, workspaceId: w, kind: 'standard' } as never)
  vi.mocked(resolveBrowserTaskExecutionAuthority).mockResolvedValue(boundary as never)
  const stored = (ctx: FilesContext, params: { path: string }) => ({ id: 'saved', path: params.path, createdByUserId: u, createdByAssistantId: a,
    userId: u, assistantId: null, sensitivity: ctx.writeSensitivity, compartments: ctx.writeCompartments, projectIds: ctx.writeProjectIds })
  const writeBytes = vi.fn(async (ctx: FilesContext, params: { path: string }) => ({ ok: true as const, value: stored(ctx, params) }))
  const readBytes = vi.fn()
  const api = { writeBytes, readBytes } as unknown as FilesApi
  return { task, writeBytes, readBytes, api, revoke: () => { allowed = false }, replace: () => { active = { ...task, taskId: 'replacement' } },
    prepare: () => prepareBrowserDownload(api, task, async () => active, boundary, async (_expected, operation) => operation()) }
}

beforeEach(() => vi.clearAllMocks())
describe('[COMP:sandbox/download-publication] retained browser file admission', () => {
  it('carries private source evidence, labels and the original assistant into the derived writer', async () => {
    const f = fixture(), publication = await f.prepare(), saved = await publication.writeBytes(file)
    expect(saved.userId).toBe(u)
    const ctx = f.writeBytes.mock.calls[0][0]
    expect(ctx).toMatchObject({ assistantId: a, mutationCompartments: [], writeCompartments: [`team:${d}`], writeSensitivity: 'internal' })
    expect(ctx.derivation?.sources.map(x => x.resourceKind)).toEqual(['browser_profile', 'browser_session'])
    expect(ctx.derivation?.sources.every(x => x.userId === u && !('held' in x))).toBe(true)
  })
  it('refuses replacement tasks before transfer and persistence', async () => {
    const f = fixture(), publication = await f.prepare(); f.replace()
    await expect(publication.assertCurrent()).rejects.toThrow()
    await expect(publication.writeBytes(file)).rejects.toThrow()
    expect(f.writeBytes).not.toHaveBeenCalled()
  })
  it('installs the retained lease at the blob-to-row seam', async () => {
    const f = fixture(), publication = await f.prepare(), row = vi.fn()
    f.writeBytes.mockImplementationOnce(async () => {
      await executeWithCurrentAuthority(async () => { f.revoke() })
      row()
      return {} as never
    })
    await expect(publication.writeBytes(file)).rejects.toThrow()
    expect(row).not.toHaveBeenCalled()
  })
  it('refuses a changed input envelope while persistence is in flight', async () => {
    const f = fixture(), publication = await f.prepare()
    f.writeBytes.mockImplementationOnce(async () => {
      f.task.inputScope!.compartments.push('team:other')
      await assertCurrentAuthority()
      return {} as never
    })
    await expect(publication.writeBytes(file)).rejects.toThrow()
  })
  it('does not qualify missing history or invocation-only origins from current permissions', async () => {
    const f = fixture(); f.task.inputScope = null
    await expect(f.prepare()).rejects.toThrow()
    f.task.inputScope = { sensitivity: 'public', compartments: [], projectIds: [], sources: [] }
    f.task.sourceAuthority = { version: 1, kind: 'invocation', invocationId: s }
    await expect(f.prepare()).rejects.toThrow()
    expect(f.writeBytes).not.toHaveBeenCalled()
  })
  it('returns failure rather than ignoring the FilesApi result', async () => {
    const f = fixture(), publication = await f.prepare()
    f.writeBytes.mockResolvedValueOnce({ ok: false, error: { kind: 'quota_exceeded' } } as never)
    await expect(publication.writeBytes(file)).rejects.toThrow(/persist/)
  })
  it('accepts a byte-identical authorized collision and rejects an ownership collision', async () => {
    const f = fixture(), publication = await f.prepare(), saved = await publication.writeBytes(file)
    f.writeBytes.mockResolvedValue({ ok: false, error: { kind: 'conflict' } } as never)
    f.readBytes.mockResolvedValue({ ok: true, value: { file: saved, bytes: file.bytes } })
    expect((await publication.writeBytes(file)).id).toBe('saved')
    f.readBytes.mockResolvedValue({ ok: true, value: { file: { ...saved, userId: null }, bytes: file.bytes } })
    await expect(publication.writeBytes(file)).rejects.toThrow(/persist/)
  })
})
