import { describe, it, expect, vi } from 'vitest'
import { createGmailTools, type GmailApi } from '../base/google-gmail.js'
import type { FilesApi } from '../../workspace-files/api.js'
import type { WorkspaceFile } from '../../workspace-files/types.js'
import type { ToolContext } from '../types.js'

// ── Fixtures ─────────────────────────────────────────────────

function fakeFile(over: Partial<WorkspaceFile> = {}): WorkspaceFile {
  const now = new Date()
  return {
    id: '00000000-0000-0000-0000-000000000001',
    workspaceId: 'ws-1',
    path: '/uploads/receipt.pdf',
    parentPath: '/uploads',
    name: 'receipt.pdf',
    title: null,
    summary: null,
    mime: 'application/pdf',
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

function filesApiFor(files: WorkspaceFile[]): FilesApi {
  const reject = () => {
    throw new Error('unexpected call')
  }
  const find = (ref: string) => files.find((f) => f.id === ref || f.path === ref) ?? null
  return {
    write: reject,
    writeBytes: reject,
    append: reject,
    read: reject,
    search: reject,
    setMeta: reject,
    delete: reject,
    async stat(_ctx: unknown, idOrPath: string) {
      const file = find(idOrPath)
      if (!file) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      return { ok: true, value: file }
    },
    async readBytes(_ctx: unknown, idOrPath: string) {
      const file = find(idOrPath)
      if (!file) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      return { ok: true, value: { file, bytes: new Uint8Array([1, 2, 3]) } }
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
    ...over,
  } as ToolContext
}

function gmailApi(): { api: GmailApi; sent: Array<{ to: string; from?: string; subject: string; body: string }> } {
  const sent: Array<{ to: string; from?: string; subject: string; body: string }> = []
  const api: GmailApi = {
    listMessages: vi.fn(),
    getMessage: vi.fn(),
    async sendMessage(params) {
      sent.push(params)
      return { id: 'msg-1', threadId: 'thr-1' }
    },
  }
  return { api, sent }
}

function sendTool(api: GmailApi, filesApi?: FilesApi) {
  const tools = createGmailTools(api, filesApi ? { filesApi } : undefined)
  const tool = tools.find((t) => t.name === 'gmailSendMessage')
  if (!tool) throw new Error('gmailSendMessage not returned')
  return tool
}

const SEND = { to: 'a@b.co', subject: 'Hi', body: 'Hello' }

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/gmail-send-as] gmailSendMessage alias sending', () => {
  it('omits `from` from the api call when not provided (unchanged default behavior)', async () => {
    const { api, sent } = gmailApi()
    const result = await sendTool(api).execute(SEND, makeContext())

    expect(result.isError).toBeUndefined()
    expect(sent[0]).not.toHaveProperty('from')
  })

  it('passes `from` through to the api layer untouched', async () => {
    const { api, sent } = gmailApi()
    const result = await sendTool(api).execute(
      { ...SEND, from: 'hinson.wong@usebrian.ai' },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    expect(sent[0].from).toBe('hinson.wong@usebrian.ai')
  })

  it('relays an api-layer rejection honestly (e.g. Gmail refusing an unverified alias)', async () => {
    const api: GmailApi = {
      listMessages: vi.fn(),
      getMessage: vi.fn(),
      sendMessage: vi.fn().mockRejectedValue(
        new Error('Gmail API error (403): "From" address does not belong to you.'),
      ),
    }

    const result = await sendTool(api).execute({ ...SEND, from: 'not-mine@example.com' }, makeContext())

    expect(result.isError).toBe(true)
    expect(result.data).toContain('does not belong to you')
  })

  describe('describeConfirmation (Approve/Deny preview)', () => {
    it('adds a From line ahead of To/Subject/Body when attachments are present', async () => {
      const pdf = fakeFile()
      const tool = sendTool(gmailApi().api, filesApiFor([pdf]))

      const lines = await tool.describeConfirmation!(
        { ...SEND, from: 'hinson.wong@usebrian.ai', attachments: [pdf.id] },
        makeContext(),
      )

      expect(lines).toEqual([
        '• From: hinson.wong@usebrian.ai',
        '• To: a@b.co',
        '• Subject: Hi',
        '• Body: Hello',
        '• Attachment: receipt.pdf (1 KB)',
      ])
    })

    it('omits the From line when no alias was given', async () => {
      const pdf = fakeFile()
      const tool = sendTool(gmailApi().api, filesApiFor([pdf]))

      const lines = await tool.describeConfirmation!({ ...SEND, attachments: [pdf.id] }, makeContext())

      expect(lines!.some((l) => l.startsWith('• From:'))).toBe(false)
    })
  })
})
