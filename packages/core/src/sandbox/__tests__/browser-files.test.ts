import { describe, it, expect, vi } from 'vitest'
import { createLocalBrowserProvider } from '../local-browser-provider.js'
import { createComputerTools } from '../tools.js'
import { createInMemoryBrowserProfileStore } from '../profiles.js'
import { browserFileName, MAX_BROWSER_DOWNLOAD, MAX_BROWSER_UPLOAD, BROWSER_DOWNLOAD_CHUNK } from '../browser-files.js'
import { minimalPdf } from '../../files/__tests__/pdf-fixture.js'
import type { BrowserProvider, BrowserCallContext } from '../types.js'
import type { ToolContext, Tool } from '../../tools/types.js'

const context: ToolContext = { userId: 'u', workspaceId: 'w', assistantId: 'a', sessionId: 's', appId: 'app', channelType: 'web', channelId: 'c', abortSignal: new AbortController().signal }
const ctx: BrowserCallContext = { ...context, workspaceId: 'w', profileId: 'p' }
const fileId = '11111111-1111-4111-8111-111111111111'
const download = { id: 'opaque/../id', name: 'test.txt', mime: 'text/plain', size: 3, state: 'completed' as const }
const run = (tool: Tool, input = {}, authority = context) => tool.execute(tool.inputSchema.parse(input), authority)

function fixture(bytes: Buffer = Buffer.from('abc'), mime = 'text/plain') {
  const provider: BrowserProvider = {
    kind: 'local', navigate: vi.fn(async (_c, url) => ({ url })),
    snapshot: vi.fn(async () => ({ url: 'https://site.test', title: 'Upload', documentId: 'doc', nodes: [{ ref: 'raw-ref', nodeId: 'node', role: 'button', name: 'Choose file' }] })),
    currentUrl: vi.fn(async () => ({ url: 'https://site.test', title: 'Upload' })),
    click: vi.fn(async () => {}), type: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    listDownloads: vi.fn(async () => ({ downloads: [{ ...download, mime, size: bytes.length }] })),
    readDownload: vi.fn(async (_ctx, _id, offset) => ({ data: bytes.subarray(offset, offset + BROWSER_DOWNLOAD_CHUNK).toString('base64'), offset, total: bytes.length })),
    uploadFile: vi.fn(async () => {}),
  }
  const files = {
    readBytes: vi.fn(async () => ({ name: 'test.txt', bytes })),
    writeBytes: vi.fn(async (_context: ToolContext, f: { path: string }) => ({ fileId, path: f.path })),
  }
  return { provider, files, tools: createComputerTools({ local: provider, cloud: provider, files }) }
}

describe('local browser file wire contract', () => {
  it('sends exact operations and validates data without exposing bytes to tools', async () => {
    const send = vi.fn(async ({ op }: { op: string }) => ({ ok: true as const, data: op === 'listDownloads' ? { downloads: [download] } : op === 'readDownload' ? { data: 'YWJj', offset: 0, total: 3 } : {} }))
    const p = createLocalBrowserProvider({ transport: { send } })
    expect(await p.listDownloads!(ctx)).toEqual({ downloads: [download] })
    await p.readDownload!(ctx, download.id, 0)
    await p.uploadFile!(ctx, 'ref', 'a.txt', 'YWJj')
    expect(send.mock.calls.map(([arg]) => arg)).toEqual([
      { userId: 'u', browserProfileId: 'p', op: 'listDownloads', args: {} },
      { userId: 'u', browserProfileId: 'p', op: 'readDownload', args: { id: download.id, offset: 0 } },
      { userId: 'u', browserProfileId: 'p', op: 'uploadFile', args: { ref: 'ref', name: 'a.txt', data: 'YWJj' } },
    ])
  })
  it.each([
    { data: '!!!', offset: 0, total: 3 }, { data: 'YR==', offset: 0, total: 1 },
    { data: 'YWJj', offset: 1, total: 3 }, { data: '', offset: 0, total: 3 },
    { data: 'YWJj', offset: 0, total: 2 }, { data: '', offset: 0, total: MAX_BROWSER_DOWNLOAD + 1 },
    { data: Buffer.alloc(BROWSER_DOWNLOAD_CHUNK + 1).toString('base64'), offset: 0, total: MAX_BROWSER_DOWNLOAD },
  ])('rejects malformed or oversized chunks %#', async data => {
    const p = createLocalBrowserProvider({ transport: { send: async () => ({ ok: true, data }) } })
    await expect(p.readDownload!(ctx, 'id', 0)).rejects.toThrow()
  })
  it('rejects oversized uploads before transport, and rejects bad inventories', async () => {
    const send = vi.fn(async () => ({ ok: true as const, data: { downloads: [{ ...download, size: MAX_BROWSER_DOWNLOAD + 1 }] } }))
    const p = createLocalBrowserProvider({ transport: { send } })
    await expect(p.uploadFile!(ctx, 'r', 'a', Buffer.alloc(MAX_BROWSER_UPLOAD + 1).toString('base64'))).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    await expect(p.listDownloads!(ctx)).rejects.toThrow()
  })
  it('accepts the full 4 MiB upload boundary without regex stack exhaustion', async () => {
    const send = vi.fn(async () => ({ ok: true as const, data: {} }))
    const provider = createLocalBrowserProvider({ transport: { send } })
    await expect(provider.uploadFile!(ctx, 'ref', 'max.bin', Buffer.alloc(MAX_BROWSER_UPLOAD).toString('base64'))).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('preserves explicit unsupported-operation errors from old extensions', async () => {
    const p = createLocalBrowserProvider({ transport: { send: async () => ({ ok: false, error: 'Unsupported operation: listDownloads' }) } })
    await expect(p.listDownloads!(ctx)).rejects.toThrow('Unsupported operation')
  })
})

describe('browser file tools', () => {
  it('always asks explicit approval to share downloads under workspace permissions, even with allow policy', async () => {
    const f = fixture()
    const tools = createComputerTools({ local: f.provider, cloud: f.provider, files: f.files,
      resolvePolicy: async () => 'allow', unattendedEnabled: () => true, getWorkspacePlan: async () => 'pro' })
    expect(tools.browserReadDownload.requiresConfirmation).toBe(true)
    expect(await tools.browserReadDownload.resolveConfirmation!(context)).toBe(true)
    const warning = (await tools.browserReadDownload.describeConfirmation!({ id: download.id }, context))!.join(' ')
    expect(warning).toMatch(/workspace permissions/i)
    expect(warning).toMatch(/more people.*private browser profile/i)
    expect(warning).toMatch(/agree to share/i)
    const result = await run(tools.browserReadDownload, { id: download.id }, { ...context, channelType: 'heartbeat' })
    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/interactive approval/)
    expect(f.provider.listDownloads).not.toHaveBeenCalled()
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
  it('does not persist when cancelled during the deferred final chunk read', async () => {
    const f = fixture()
    const controller = new AbortController()
    let complete!: (value: { data: string; offset: number; total: number }) => void
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    vi.mocked(f.provider.readDownload!).mockImplementationOnce(async () => {
      started()
      return new Promise(resolve => { complete = resolve })
    })
    const pending = run(f.tools.browserReadDownload, { id: download.id }, { ...context, abortSignal: controller.signal })
    await reading
    controller.abort()
    complete({ data: 'YWJj', offset: 0, total: 3 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/cancelled/)
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
  it('does not return file contents if cancelled while persistence is in flight', async () => {
    const f = fixture(minimalPdf(), 'application/pdf')
    const controller = new AbortController()
    f.files.writeBytes.mockImplementationOnce(async (_context, file) => {
      controller.abort()
      return { fileId, path: file.path }
    })
    const result = await run(f.tools.browserReadDownload, { id: download.id }, { ...context, abortSignal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/cancelled after persistence/)
    expect(result.data).not.toContain('Hello PDF World')
  })
  it('persists binary-safe chunks with full authority and paginates text; scopes deterministic paths', async () => {
    const f = fixture(Buffer.from('x'.repeat(BROWSER_DOWNLOAD_CHUNK + 9)))
    const first = await run(f.tools.browserReadDownload, { id: download.id })
    const result = JSON.parse(first.data as string)
    expect(result).toMatchObject({ fileId, nextOffset: 12000, totalCharacters: BROWSER_DOWNLOAD_CHUNK + 9 })
    expect(result.text).toHaveLength(12000)
    expect(f.provider.readDownload).toHaveBeenCalledTimes(2)
    expect(f.files.writeBytes.mock.calls[0][0]).toBe(context)
    expect(result.path).not.toContain('..')
    const second = JSON.parse((await run(f.tools.browserReadDownload, { id: download.id, offset: 12000 })).data as string)
    expect(second.path).toBe(result.path)
    const other = JSON.parse((await run(f.tools.browserReadDownload, { id: download.id }, { ...context, assistantId: 'other' })).data as string)
    expect(other.path).not.toBe(result.path)
  })
  it('extracts real PDF text; reports empty/scanned PDFs honestly', async () => {
    const f = fixture(minimalPdf(), 'application/pdf')
    expect(JSON.parse((await run(f.tools.browserReadDownload, { id: download.id })).data as string).text).toBe('Hello PDF World')
    const blank = fixture(minimalPdf(1, ''), 'application/pdf')
    expect(JSON.parse((await run(blank.tools.browserReadDownload, { id: download.id })).data as string)).toMatchObject({ fileId, text: '', note: expect.stringMatching(/no extractable text/) })
  })
  it('saves non-text binaries without returning raw base64', async () => {
    const f = fixture(Buffer.from([0, 255, 1]), 'application/octet-stream')
    const result = await run(f.tools.browserReadDownload, { id: download.id })
    expect(result.isError).toBeUndefined()
    expect(result.data).not.toContain('AP8B')
    expect(JSON.parse(result.data as string).text).toBe('')
  })
  it('requires approval even with allow policy; resolves observed refs and forwards full authority', async () => {
    const f = fixture()
    expect(f.tools.browserUploadFile.requiresConfirmation).toBe(true)
    expect(await f.tools.browserUploadFile.resolveConfirmation!(context)).toBe(true)
    await run(f.tools.browserSnapshot)
    const result = await run(f.tools.browserUploadFile, { ref: '@e1', fileId })
    expect(result.isError).toBeUndefined()
    expect(f.files.readBytes).toHaveBeenCalledWith(context, fileId)
    expect(f.provider.uploadFile).toHaveBeenCalledWith(expect.anything(), 'raw-ref', 'test.txt', 'YWJj')
    expect(result.data).not.toContain('YWJj')
    expect((await run(f.tools.browserUploadFile, { ref: '@e1', fileId })).isError).toBe(true)
    expect(() => f.tools.browserUploadFile.inputSchema.parse({ ref: '@e1', fileId: '/tmp/secret' })).toThrow()
  })
  it('never uploads unauthorized or oversized files', async () => {
    const f = fixture()
    await run(f.tools.browserSnapshot)
    f.files.readBytes.mockRejectedValueOnce(new Error('unauthorized'))
    expect((await run(f.tools.browserUploadFile, { ref: '@e1', fileId })).isError).toBe(true)
    f.files.readBytes.mockResolvedValueOnce({ name: 'large', bytes: Buffer.alloc(MAX_BROWSER_UPLOAD + 1) })
    expect((await run(f.tools.browserUploadFile, { ref: '@e1', fileId })).isError).toBe(true)
    expect(f.provider.uploadFile).not.toHaveBeenCalled()
  })
  it('blocks protected-fill and policy-denied transfers before touching files', async () => {
    const f = fixture()
    for (const extra of [{ protectedFill: { blocked: () => true, scope: async () => null } }, { resolvePolicy: async () => 'block' as const }]) {
      const tools = createComputerTools({ local: f.provider, cloud: f.provider, files: f.files, ...extra })
      for (const [tool, input] of [[tools.browserDownloads, {}], [tools.browserReadDownload, { id: download.id }], [tools.browserUploadFile, { ref: '@e1', fileId }]] as const) {
        expect((await run(tool, input)).isError).toBe(true)
      }
    }
    expect(f.provider.listDownloads).not.toHaveBeenCalled()
    expect(f.files.readBytes).not.toHaveBeenCalled()
  })
  it('rejects providers without optional methods cleanly', async () => {
    const f = fixture()
    delete f.provider.listDownloads; delete f.provider.readDownload; delete f.provider.uploadFile
    expect((await run(f.tools.browserDownloads)).data).toMatch(/unsupported/)
    expect((await run(f.tools.browserReadDownload, { id: download.id })).data).toMatch(/unsupported/)
    expect((await run(f.tools.browserUploadFile, { ref: '@e1', fileId })).data).toMatch(/unsupported/)
  })
  it('rechecks profile ownership/assistant authorization rather than trusting prior session selection', async () => {
    const f = fixture()
    const store = createInMemoryBrowserProfileStore()
    const profile = await store.create({ workspaceId: 'w', ownerUserId: 'u', name: 'Private', scope: 'owner', enabledAssistantIds: ['a'], defaultBackend: 'local' })
    const tools = createComputerTools({ local: f.provider, cloud: f.provider, files: f.files,
      profiles: { store, assistantClearance: async () => 'confidential' } })
    await run(tools.browserNavigate, { url: 'https://site.test', profile: profile.name })
    expect((await run(tools.browserDownloads)).isError).toBeUndefined()
    for (const change of [{ userId: 'stranger' }, { assistantId: 'other' }, { workspaceId: 'other' }]) {
      expect((await run(tools.browserDownloads, {}, { ...context, ...change })).isError).toBe(true)
    }
    expect(f.provider.listDownloads).toHaveBeenCalledTimes(1)
  })
  it('uses safe artifact names even for dot segments', async () => {
    const f = fixture()
    vi.mocked(f.provider.listDownloads!).mockResolvedValueOnce({ downloads: [{ ...download, name: '..' }] })
    const result = JSON.parse((await run(f.tools.browserReadDownload, { id: download.id })).data as string)
    expect(result.name).toBe('file')
    expect(result.path).not.toContain('..')
  })
  it('refuses incomplete downloads, changed totals and malformed chunks before persistence', async () => {
    const f = fixture()
    vi.mocked(f.provider.listDownloads!).mockResolvedValueOnce({ downloads: [{ ...download, state: 'progressing' }] })
    expect((await run(f.tools.browserReadDownload, { id: download.id })).isError).toBe(true)
    vi.mocked(f.provider.readDownload!).mockResolvedValueOnce({ data: 'YWJj', offset: 0, total: 4 })
    expect((await run(f.tools.browserReadDownload, { id: download.id })).isError).toBe(true)
    expect(f.files.writeBytes).not.toHaveBeenCalled()
  })
})

describe('cross-platform browser filenames', () => {
  it.each([
    ['a:b<c>d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['report.txt.  ', 'report.txt'], ['..', 'file'], ['   ', 'file'],
    ['CON', '_CON'], ['con.txt', '_con.txt'], ['PRN.pdf', '_PRN.pdf'],
    ['AUX', '_AUX'], ['NUL.txt', '_NUL.txt'], ['COM1.csv', '_COM1.csv'],
    ['com9', '_com9'], ['LPT1', '_LPT1'], ['lpt9.pdf', '_lpt9.pdf'],
    ['COM10.txt', 'COM10.txt'], ['LPT0', 'LPT0'], ['CON .txt', '_CON .txt'],
    ['normal name.pdf', 'normal name.pdf'], ['path/to\\file', 'path_to_file'],
  ])('sanitizes %s to %s', (input, expected) => {
    expect(browserFileName(input)).toBe(expected)
  })
  it('keeps the 200-character bound after reserving a device basename', () => {
    const name = browserFileName(`CON.${'x'.repeat(300)}`)
    expect(name).toHaveLength(200)
    expect(name).toMatch(/^_CON\./)
    expect(browserFileName(`${'x'.repeat(199)}.suffix`)).toHaveLength(199)
  })
})
