import { describe, it, expect } from 'vitest'
import { createSendFileTool } from '../send-file.js'
import {
  AttachmentCollector,
  MAX_ATTACHMENTS_PER_TURN,
  MAX_EXTERNAL_DOCUMENT_BYTES,
} from '../attachments.js'
import type { FilesApi } from '../api.js'
import type { WorkspaceFile } from '../types.js'
import type { ToolContext } from '../../tools/types.js'

// ── Fixtures ─────────────────────────────────────────────────

function fakeFile(over: Partial<WorkspaceFile> = {}): WorkspaceFile {
  const now = new Date()
  return {
    id: '00000000-0000-0000-0000-000000000001',
    workspaceId: 'ws-1',
    path: '/reports/q1.md',
    parentPath: '/reports',
    name: 'q1.md',
    title: null,
    summary: null,
    mime: 'text/markdown',
    sizeBytes: 1024,
    tags: [],
    relatedIds: [],
    storageUri: 'gs://test/ws-1/f1',
    sensitivity: 'internal',
    metadata: {},
    userId: null,
    assistantId: null,
    source: 'user',
    sourceEpisodeId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: now,
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    createdByUserId: 'u-1',
    createdByAssistantId: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

/** Stat-only fake — sendFile must never touch any other FilesApi method. */
function statOnlyApi(file: WorkspaceFile | null): FilesApi {
  const reject = () => {
    throw new Error('sendFile must only call stat')
  }
  return {
    write: reject,
    writeBytes: reject,
    append: reject,
    read: reject,
    readBytes: reject,
    search: reject,
    setMeta: reject,
    delete: reject,
    async stat(_ctx: unknown, idOrPath: string) {
      if (!file) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      return { ok: true, value: file }
    },
  } as unknown as FilesApi
}

function makeContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u-1',
    assistantId: 'a-1',
    sessionId: 's-1',
    appId: 'Use Brian',
    channelType: 'telegram',
    channelId: 'c-1',
    workspaceId: 'ws-1',
    abortSignal: new AbortController().signal,
    outboundAttachments: new AttachmentCollector(),
    ...over,
  }
}

describe('[COMP:files/send-file] sendFile', () => {
  it('registers an attachment on the collector with the file metadata', async () => {
    const tool = createSendFileTool(statOnlyApi(fakeFile()))
    const collector = new AttachmentCollector()
    const ctx = makeContext({ outboundAttachments: collector })

    const result = await tool.execute({ file: '/reports/q1.md', caption: 'Q1 recap' }, ctx)

    expect(result.isError).toBeUndefined()
    expect(result.data).toContain('Attached /reports/q1.md')
    expect(collector.list()).toEqual([
      {
        fileId: '00000000-0000-0000-0000-000000000001',
        workspaceId: 'ws-1',
        path: '/reports/q1.md',
        name: 'q1.md',
        mime: 'text/markdown',
        sizeBytes: 1024,
        caption: 'Q1 recap',
      },
    ])
  })

  it('errors honestly when no collector is on the context (no delivery surface)', async () => {
    const tool = createSendFileTool(statOnlyApi(fakeFile()))
    const ctx = makeContext({ outboundAttachments: undefined })

    const result = await tool.execute({ file: '/reports/q1.md' }, ctx)

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('cannot be delivered from this context')
  })

  it('refuses on WhatsApp (deprecated channel, never extended)', async () => {
    const tool = createSendFileTool(statOnlyApi(fakeFile()))
    const ctx = makeContext({ channelType: 'whatsapp' })

    const result = await tool.execute({ file: '/reports/q1.md' }, ctx)

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not supported on WhatsApp')
  })

  it('blocks confidential files on external channels but allows them on web', async () => {
    const confidential = fakeFile({ sensitivity: 'confidential' })

    const blocked = await createSendFileTool(statOnlyApi(confidential)).execute(
      { file: '/reports/q1.md' },
      makeContext({ channelType: 'slack' }),
    )
    expect(blocked.isError).toBe(true)
    expect(String(blocked.data)).toContain('confidential')

    const webCollector = new AttachmentCollector()
    const allowed = await createSendFileTool(statOnlyApi(confidential)).execute(
      { file: '/reports/q1.md' },
      makeContext({ channelType: 'web', outboundAttachments: webCollector }),
    )
    expect(allowed.isError).toBeUndefined()
    expect(webCollector.count).toBe(1)
  })

  it('blocks oversized files on external channels but allows them on web', async () => {
    const big = fakeFile({ sizeBytes: MAX_EXTERNAL_DOCUMENT_BYTES + 1 })

    const blocked = await createSendFileTool(statOnlyApi(big)).execute(
      { file: '/reports/q1.md' },
      makeContext({ channelType: 'telegram' }),
    )
    expect(blocked.isError).toBe(true)
    expect(String(blocked.data)).toContain('over the')

    const webCollector = new AttachmentCollector()
    const allowed = await createSendFileTool(statOnlyApi(big)).execute(
      { file: '/reports/q1.md' },
      makeContext({ channelType: 'web', outboundAttachments: webCollector }),
    )
    expect(allowed.isError).toBeUndefined()
  })

  it('returns not_found through the FilesResult envelope', async () => {
    const tool = createSendFileTool(statOnlyApi(null))
    const result = await tool.execute({ file: '/nope.md' }, makeContext())
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not found')
  })

  it('dedups by fileId and enforces the per-turn cap', async () => {
    const collector = new AttachmentCollector()
    const ctx = makeContext({ outboundAttachments: collector })

    // Same file twice → friendly no-op, not an error.
    const tool = createSendFileTool(statOnlyApi(fakeFile()))
    await tool.execute({ file: '/reports/q1.md' }, ctx)
    const dup = await tool.execute({ file: '/reports/q1.md' }, ctx)
    expect(dup.isError).toBeUndefined()
    expect(String(dup.data)).toContain('already attached')
    expect(collector.count).toBe(1)

    // Fill to the cap with distinct files, then expect a cap error.
    for (let i = 2; i <= MAX_ATTACHMENTS_PER_TURN; i++) {
      const f = fakeFile({ id: `00000000-0000-0000-0000-00000000000${i}`, path: `/f${i}.md` })
      const r = await createSendFileTool(statOnlyApi(f)).execute({ file: f.path }, ctx)
      expect(r.isError).toBeUndefined()
    }
    expect(collector.count).toBe(MAX_ATTACHMENTS_PER_TURN)

    const over = fakeFile({ id: '00000000-0000-0000-0000-0000000000ff', path: '/over.md' })
    const capped = await createSendFileTool(statOnlyApi(over)).execute({ file: '/over.md' }, ctx)
    expect(capped.isError).toBe(true)
    expect(String(capped.data)).toContain('Attachment limit reached')
  })

  it('requires a workspace', async () => {
    const tool = createSendFileTool(statOnlyApi(fakeFile()))
    const result = await tool.execute({ file: '/reports/q1.md' }, makeContext({ workspaceId: null }))
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('require a workspace')
  })

  it('is read-only, concurrency-safe, and capability-gated on files', () => {
    const tool = createSendFileTool(statOnlyApi(fakeFile()))
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
    expect(tool.requiresCapability).toBe('files')
  })
})

describe('[COMP:files/send-file] AttachmentCollector', () => {
  it('drain() consumes; list() snapshots', () => {
    const c = new AttachmentCollector()
    c.note({ fileId: 'f1', workspaceId: 'w', path: '/a', name: 'a', mime: 'text/plain', sizeBytes: 1 })
    expect(c.list()).toHaveLength(1)
    expect(c.list()).toHaveLength(1) // list does not consume
    expect(c.drain()).toHaveLength(1)
    expect(c.list()).toHaveLength(0)
    expect(c.drain()).toHaveLength(0) // double-drain is safe (recovery resend)
  })
})
