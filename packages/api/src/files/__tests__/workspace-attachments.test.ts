import { describe, expect, it, vi } from 'vitest'
import { bindScopeSource, ContextScopeAccumulator, type FilesApi, type ToolContext } from '@use-brian/core'
import { attachWorkspaceFiles } from '../workspace-attachments.js'
const frame = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../db/session-context-revisions.js', () => ({
  writeRetainedContextFrame: async (_authority: unknown, _sources: unknown, publish: (client: unknown) => Promise<unknown>) => publish(frame),
}))
vi.mock('../../application-platform/model-source-authority.js', () => ({ assertSourceModelInputAuthority: vi.fn() }))
const source = { resourceKind: 'workspace_file', resourceId: 'file-1', version: '2', workspaceId: 'workspace-1',
  userId: null, assistantId: null, sensitivity: 'internal' as const, compartments: [], projectIds: [] }
function fixture(bound = true) {
  const raw = { id: source.resourceId, workspaceId: source.workspaceId, scopeVersion: '2', sizeBytes: 12,
    name: 'report.txt', mime: 'text/plain', userId: null, assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [] }
  const file = bound ? bindScopeSource(raw, source) : { ...raw, sources: [source] }
  const files = { stat: vi.fn(async () => ({ ok: true, value: file })),
    readBytes: vi.fn(async () => ({ ok: true, value: { file, bytes: Buffer.from('Report text.') } })) }
  const context = { workspaceId: source.workspaceId, sessionId: 'session-1', sessionPersisted: true,
    scopeAccumulator: new ContextScopeAccumulator(), executionContext: { security: {
      access: { workspaceId: source.workspaceId, userId: 'user-1', assistantId: 'assistant-1', assistantKind: 'primary' },
      authority: { assertCurrent: vi.fn() },
    } } } as unknown as ToolContext
  frame.query.mockReset()
  return { files, context, attach: () => attachWorkspaceFiles(files as unknown as FilesApi, context, ['file-1']) }
}
describe('[COMP:api/workspace-mcp] workspace attachment admission', () => {
  it('bounds bytes before download and parsing', async () => {
    const f = fixture(); f.files.stat.mockResolvedValueOnce({ ok: true, value: { ...(await f.files.stat()).value, sizeBytes: 20 * 1024 * 1024 + 1 } })
    await expect(f.attach()).rejects.toThrow('attachment_unavailable_or_too_large')
    expect(f.files.readBytes).not.toHaveBeenCalled(); expect(frame.query).not.toHaveBeenCalled()
  })
  it('does not accept JSON source claims in place of canonical reader evidence', async () => {
    const f = fixture(false)
    await expect(f.attach()).rejects.toThrow('attachment_source_unavailable')
    expect(frame.query).not.toHaveBeenCalled()
  })
  it('does not cache a file changed before the publication lock', async () => {
    const f = fixture(); frame.query.mockResolvedValue({ rows: [] })
    await expect(f.attach()).rejects.toThrow('attachment_source_changed')
    expect(frame.query).toHaveBeenCalledTimes(1)
  })
  it('parses bytes through native intake and keeps the exact source in the turn', async () => {
    const f = fixture(); frame.query.mockResolvedValueOnce({ rows: [{ id: 'file-1' }] }).mockResolvedValueOnce({ rows: [{ id: 'cache-1' }] })
    expect(await f.attach()).toEqual(['cache-1'])
    expect(f.context.scopeAccumulator!.evidence.sources).toEqual([source])
    const args = frame.query.mock.calls[1][1]
    expect(args[3]).toBe('Report text.')
    expect(args.slice(-2)).toEqual(['file-1', '2'])
  })
})
