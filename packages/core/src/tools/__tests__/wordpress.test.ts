import { describe, expect, it, vi } from 'vitest'
import {
  createWordPressTools,
  WORDPRESS_MAX_IMAGE_BYTES,
  type WordPressApi,
} from '../base/wordpress.js'

function mockApi(overrides: Partial<WordPressApi> = {}): WordPressApi {
  return {
    getManagedPage: vi.fn().mockResolvedValue({ page: 'home', revision: 'revision-1234567890' }),
    updatePageText: vi.fn().mockResolvedValue({ page: 'home', slot: 'headline', revision: 'revision-new' }),
    replacePageImage: vi.fn().mockResolvedValue({ page: 'home', slot: 'hero_image', attachment_id: 42 }),
    ...overrides,
  }
}

describe('[COMP:tools/wordpress] WordPress managed-content tools', () => {
  it('exposes one safe read and two confirmation-gated writes', () => {
    const tools = createWordPressTools(mockApi())
    expect(tools.map((tool) => tool.name)).toEqual([
      'wordpressGetManagedPage',
      'wordpressUpdatePageText',
      'wordpressReplacePageImage',
    ])
    expect(tools[0]).toMatchObject({ isReadOnly: true, isConcurrencySafe: true, requiresConfirmation: false })
    expect(tools[1]).toMatchObject({ isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true })
    expect(tools[2]).toMatchObject({ isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true })
  })

  it('passes only a named page, slot, value, and revision to a text update', async () => {
    const updatePageText = vi.fn().mockResolvedValue({ revision: 'next' })
    const tool = createWordPressTools(mockApi({ updatePageText }))[1]!
    const result = await tool.execute({
      page: 'home',
      slot: 'headline',
      value: 'A clearer introduction',
      expectedRevision: '0123456789abcdef',
    }, {} as never)

    expect(result.isError).not.toBe(true)
    expect(updatePageText).toHaveBeenCalledWith({
      page: 'home',
      slot: 'headline',
      value: 'A clearer introduction',
      expectedRevision: '0123456789abcdef',
    })
  })

  it('reads an approved image file and passes optimistic concurrency fields', async () => {
    const replacePageImage = vi.fn().mockResolvedValue({ attachment_id: 42 })
    const readFileBytes = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'new-portrait.webp',
      mimeType: 'image/webp',
    })
    const tool = createWordPressTools(mockApi({ replacePageImage }), { readFileBytes })[2]!
    const result = await tool.execute({
      page: 'home',
      slot: 'profile_image',
      file: 'file-123',
      altText: 'A fictional founder portrait',
      expectedRevision: '0123456789abcdef',
      expectedAttachmentId: 17,
    }, {} as never)

    expect(result.isError).not.toBe(true)
    expect(replacePageImage).toHaveBeenCalledWith({
      page: 'home',
      slot: 'profile_image',
      bytes: new Uint8Array([1, 2, 3]),
      fileName: 'new-portrait.webp',
      mimeType: 'image/webp',
      altText: 'A fictional founder portrait',
      expectedRevision: '0123456789abcdef',
      expectedAttachmentId: 17,
    })
  })

  it('rejects unsupported files and oversized images before calling WordPress', async () => {
    const replacePageImage = vi.fn()
    const unsupported = createWordPressTools(mockApi({ replacePageImage }), {
      readFileBytes: vi.fn().mockResolvedValue({
        bytes: new Uint8Array([1]), fileName: 'logo.svg', mimeType: 'image/svg+xml',
      }),
    })[2]!
    const common = {
      page: 'home', slot: 'hero_image', file: 'file-1', altText: 'Hero',
      expectedRevision: '0123456789abcdef', expectedAttachmentId: null,
    }
    expect((await unsupported.execute(common, {} as never)).isError).toBe(true)

    const oversized = createWordPressTools(mockApi({ replacePageImage }), {
      readFileBytes: vi.fn().mockResolvedValue({
        bytes: new Uint8Array(WORDPRESS_MAX_IMAGE_BYTES + 1), fileName: 'hero.jpg', mimeType: 'image/jpeg',
      }),
    })[2]!
    expect((await oversized.execute(common, {} as never)).isError).toBe(true)
    expect(replacePageImage).not.toHaveBeenCalled()
  })

  it('reports missing workspace file access instead of implying an upload', async () => {
    const result = await createWordPressTools(mockApi())[2]!.execute({
      page: 'home', slot: 'hero_image', file: 'file-1', altText: 'Hero',
      expectedRevision: '0123456789abcdef', expectedAttachmentId: null,
    }, {} as never)
    expect(result).toMatchObject({ isError: true })
    expect(String(result.data)).toContain('the workspace file reader (`readFileBytes`) is not wired here')
    expect(String(result.data)).toContain('retrying will not help')
  })

  it('renders invalid_credentials with (401) + "invalid or expired" so the health classifier flips, and other codes with their next step', async () => {
    const wpErr = (code: string, message: string, status?: number) =>
      Object.assign(new Error(message), { name: 'WordPressConnectorError', code, status })
    const auth = await createWordPressTools(mockApi({
      getManagedPage: vi.fn().mockRejectedValue(wpErr('invalid_credentials', 'The WordPress username or Application Password is invalid', 401)),
    }))[0]!.execute({ page: 'home' }, {} as never)
    expect(auth.isError).toBe(true)
    expect(String(auth.data)).toContain('(401)')
    expect(String(auth.data)).toContain('invalid or expired')
    expect(String(auth.data)).toContain('Reconnect WordPress (Studio → Connectors)')
    expect(String(auth.data)).toContain('invalid_credentials')

    const slot = await createWordPressTools(mockApi({
      updatePageText: vi.fn().mockRejectedValue(wpErr('managed_slot_not_found', "That location is not in the page's managed-content catalog", 404)),
    }))[1]!.execute({ page: 'home', slot: 'nope', text: 'x', expectedRevision: '0123456789abcdef' }, {} as never)
    expect(String(slot.data)).toContain('slot `nope` of page `home`')
    expect(String(slot.data)).toContain('Call `wordpressGetManagedPage`')
    expect(String(slot.data)).toContain('retrying this exact slot will keep failing')

    const conflict = await createWordPressTools(mockApi({
      updatePageText: vi.fn().mockRejectedValue(wpErr('revision_conflict', 'The page changed after it was read. Read it again before updating', 409)),
    }))[1]!.execute({ page: 'home', slot: 'hero', text: 'x', expectedRevision: '0123456789abcdef' }, {} as never)
    expect(String(conflict.data)).toContain('Nothing was changed')
    expect(String(conflict.data)).toContain('retry once with those')
  })
})
