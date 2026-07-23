import { describe, it, expect, vi } from 'vitest'
import {
  createGmailTools,
  MAX_EMAIL_ATTACHMENT_TOTAL_BYTES,
  type GmailApi,
  type GmailOutgoingAttachment,
} from '../base/google-gmail.js'
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

/** stat + readBytes fake keyed by id AND path; every other method throws. */
function filesApiFor(files: WorkspaceFile[], bytes: Record<string, Uint8Array> = {}): FilesApi {
  const reject = () => {
    throw new Error('gmail attachments must only call stat/readBytes')
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
      return { ok: true, value: { file, bytes: bytes[file.id] ?? new Uint8Array([1, 2, 3]) } }
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

function gmailApi(): { api: GmailApi; sent: Array<{ to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; attachments?: GmailOutgoingAttachment[] }> } {
  const sent: Array<{ to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string; attachments?: GmailOutgoingAttachment[] }> = []
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

const SEND = { to: ['a@b.co'], subject: 'Hi', body: 'Hello' }

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/gmail-attachments] gmailSendMessage attachments', () => {
  it('sends without attachments exactly as before (no attachments key)', async () => {
    const { api, sent } = gmailApi()
    const result = await sendTool(api).execute(SEND, makeContext())

    expect(result.isError).toBeUndefined()
    expect(result.data).toEqual({ id: 'msg-1', threadId: 'thr-1' })
    expect(sent[0]).not.toHaveProperty('attachments')
  })

  it('resolves brain files to bytes and passes them to the api layer', async () => {
    const pdf = fakeFile()
    const csv = fakeFile({
      id: '00000000-0000-0000-0000-000000000002',
      path: '/exports/deals.csv',
      name: 'deals.csv',
      mime: 'text/csv',
      sizeBytes: 64,
    })
    const bytes = {
      [pdf.id]: new Uint8Array(Buffer.from('%PDF-fake')),
      [csv.id]: new Uint8Array(Buffer.from('a,b\n1,2')),
    }
    const { api, sent } = gmailApi()
    const tool = sendTool(api, filesApiFor([pdf, csv], bytes))

    const result = await tool.execute(
      { ...SEND, attachments: ['/uploads/receipt.pdf', csv.id] },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    expect(result.data).toMatchObject({ id: 'msg-1', attached: ['receipt.pdf', 'deals.csv'] })
    expect(sent[0].attachments).toEqual([
      { filename: 'receipt.pdf', mime: 'application/pdf', data: bytes[pdf.id] },
      { filename: 'deals.csv', mime: 'text/csv', data: bytes[csv.id] },
    ])
  })

  it('dedupes references that resolve to the same file', async () => {
    const pdf = fakeFile()
    const { api, sent } = gmailApi()
    const tool = sendTool(api, filesApiFor([pdf]))

    const result = await tool.execute(
      { ...SEND, attachments: [pdf.id, '/uploads/receipt.pdf'] },
      makeContext(),
    )

    expect(result.isError).toBeUndefined()
    expect(sent[0].attachments).toHaveLength(1)
  })

  it('errors honestly when no filesApi is wired', async () => {
    const { api, sent } = gmailApi()
    const result = await sendTool(api).execute(
      { ...SEND, attachments: ['/uploads/receipt.pdf'] },
      makeContext(),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('not available in this context')
    expect(sent).toHaveLength(0)
  })

  it('errors when the turn is not workspace-bound', async () => {
    const { api, sent } = gmailApi()
    const tool = sendTool(api, filesApiFor([fakeFile()]))

    const result = await tool.execute(
      { ...SEND, attachments: ['/uploads/receipt.pdf'] },
      makeContext({ workspaceId: null }),
    )

    expect(result.isError).toBe(true)
    expect(sent).toHaveLength(0)
  })

  it('refuses confidential files by name', async () => {
    const secret = fakeFile({ sensitivity: 'confidential', path: '/hr/salaries.xlsx', name: 'salaries.xlsx' })
    const { api, sent } = gmailApi()
    const tool = sendTool(api, filesApiFor([secret]))

    const result = await tool.execute(
      { ...SEND, attachments: ['/hr/salaries.xlsx'] },
      makeContext(),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('/hr/salaries.xlsx is confidential')
    expect(sent).toHaveLength(0)
  })

  // WS3 finding #6: the confidential refusal now covers the email BODY too,
  // not only attachments. The body is free text the model composes, so a
  // secret read this turn could be pasted in; the turn sensitivity floor
  // (context.sensitivity.max) gates the send the same way a confidential
  // attachment does.
  it('refuses the send when the turn sensitivity floor is confidential (body egress)', async () => {
    const { api, sent } = gmailApi()
    const result = await sendTool(api).execute(
      SEND,
      makeContext({ sensitivity: { max: 'confidential' } as never }),
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/confidential/i)
    expect(sent).toHaveLength(0)
  })

  it('sends normally when the turn floor is internal', async () => {
    const { api, sent } = gmailApi()
    const result = await sendTool(api).execute(
      SEND,
      makeContext({ sensitivity: { max: 'internal' } as never }),
    )
    expect(result.isError).toBeUndefined()
    expect(sent).toHaveLength(1)
  })

  it('refuses when the total size exceeds the email cap, before reading bytes', async () => {
    const big = fakeFile({ sizeBytes: MAX_EMAIL_ATTACHMENT_TOTAL_BYTES - 100 })
    const two = fakeFile({
      id: '00000000-0000-0000-0000-000000000002',
      path: '/uploads/video.mp4',
      name: 'video.mp4',
      sizeBytes: 200,
    })
    const filesApi = filesApiFor([big, two])
    const readSpy = vi.spyOn(filesApi, 'readBytes')
    const { api, sent } = gmailApi()
    const tool = sendTool(api, filesApi)

    const result = await tool.execute(
      { ...SEND, attachments: [big.id, two.id] },
      makeContext(),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('over the')
    expect(readSpy).not.toHaveBeenCalled()
    expect(sent).toHaveLength(0)
  })

  it('surfaces not_found with the reference named', async () => {
    const { api, sent } = gmailApi()
    const tool = sendTool(api, filesApiFor([]))

    const result = await tool.execute(
      { ...SEND, attachments: ['/uploads/missing.pdf'] },
      makeContext(),
    )

    expect(result.isError).toBe(true)
    expect(result.data).toContain('/uploads/missing.pdf not found')
    expect(sent).toHaveLength(0)
  })

  describe('describeConfirmation (Approve/Deny preview)', () => {
    it('resolves attachment ids to file names with size, alongside to/subject/body', async () => {
      const pdf = fakeFile({ sizeBytes: 1024 * 1024 + 200 * 1024 })
      const tool = sendTool(gmailApi().api, filesApiFor([pdf]))

      const lines = await tool.describeConfirmation!(
        { ...SEND, attachments: [pdf.id] },
        makeContext(),
      )

      expect(lines).toEqual([
        '• To: a@b.co',
        '• Subject: Hi',
        '• Body: Hello',
        '• Attachment: receipt.pdf (1.2 MB)',
      ])
      expect(lines!.join('\n')).not.toContain(pdf.id)
    })

    it('formats sub-MB sizes in KB', async () => {
      const small = fakeFile({ sizeBytes: 2048 })
      const tool = sendTool(gmailApi().api, filesApiFor([small]))

      const lines = await tool.describeConfirmation!(
        { ...SEND, attachments: [small.id] },
        makeContext(),
      )

      expect(lines).toContain('• Attachment: receipt.pdf (2 KB)')
    })

    it('falls back to the generic renderer (null) without attachments', async () => {
      const tool = sendTool(gmailApi().api, filesApiFor([fakeFile()]))

      expect(await tool.describeConfirmation!(SEND, makeContext())).toBeNull()
    })

    it('falls back to the generic renderer without a filesApi or workspace', async () => {
      const noFiles = sendTool(gmailApi().api)
      expect(
        await noFiles.describeConfirmation!({ ...SEND, attachments: ['x'] }, makeContext()),
      ).toBeNull()

      const noWs = sendTool(gmailApi().api, filesApiFor([fakeFile()]))
      expect(
        await noWs.describeConfirmation!(
          { ...SEND, attachments: ['x'] },
          makeContext({ workspaceId: null }),
        ),
      ).toBeNull()
    })

    it('shows the raw ref for unresolvable attachments instead of dropping them', async () => {
      const tool = sendTool(gmailApi().api, filesApiFor([]))

      const lines = await tool.describeConfirmation!(
        { ...SEND, attachments: ['/uploads/missing.pdf'] },
        makeContext(),
      )

      expect(lines).toContain('• Attachment: /uploads/missing.pdf (not found)')
    })

    it('flags confidential files as refusable and dedupes refs to the same file', async () => {
      const secret = fakeFile({ sensitivity: 'confidential', name: 'salaries.xlsx', path: '/hr/salaries.xlsx' })
      const tool = sendTool(gmailApi().api, filesApiFor([secret]))

      const lines = await tool.describeConfirmation!(
        { ...SEND, attachments: [secret.id, '/hr/salaries.xlsx'] },
        makeContext(),
      )

      const attachmentLines = lines!.filter((l) => l.startsWith('• Attachment:'))
      expect(attachmentLines).toEqual([
        '• Attachment: salaries.xlsx (confidential: send will be refused)',
      ])
    })
  })
})
