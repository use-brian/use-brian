import { describe, it, expect, vi } from 'vitest'
import {
  createGoogleSlidesTools,
  type GoogleSlidesApi,
} from '../base/google-slides.js'
import type { AuthorizedFile } from '../base/google-drive.js'
import type { ToolContext } from '../types.js'

// ── Helpers ──────────────────────────────────────────────────

const ctx: ToolContext = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web',
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

function mockApi(overrides: Partial<GoogleSlidesApi> = {}): GoogleSlidesApi {
  return {
    getPresentationInfo: vi.fn().mockResolvedValue({
      presentationId: 'p1',
      title: 'Deck',
      slideWidthEmu: 9144000,
      slideHeightEmu: 5143500,
      slides: [{ objectId: 's1', pageNumber: 1, elementCount: 2 }],
    }),
    getSlideContent: vi.fn().mockResolvedValue({
      slideObjectId: 's1',
      pageNumber: 1,
      elements: [],
    }),
    getSlideThumbnail: vi.fn().mockResolvedValue({
      contentUrl: 'https://example.com/t.png',
      width: 480,
      height: 270,
    }),
    createSlide: vi.fn().mockResolvedValue({
      slideObjectId: 'new_s',
      placeholderIds: { TITLE: 'ph_title' },
    }),
    updateSlideContent: vi.fn().mockResolvedValue({ updated: 1 }),
    insertImage: vi.fn().mockResolvedValue({ imageObjectId: 'img1' }),
    deleteSlide: vi.fn().mockResolvedValue(undefined),
    reorderSlides: vi.fn().mockResolvedValue(undefined),
    duplicateSlide: vi.fn().mockResolvedValue({ newSlideObjectId: 'dup_s' }),
    batchUpdate: vi.fn().mockResolvedValue({ replies: [] }),
    createPresentation: vi.fn().mockResolvedValue({
      presentationId: 'new_p',
      title: 'New Deck',
      url: 'https://docs.google.com/presentation/d/new_p/edit',
    }),
    ...overrides,
  }
}

const authorized: AuthorizedFile[] = [
  {
    id: 'authed-pres',
    name: 'Authed Deck',
    mimeType: 'application/vnd.google-apps.presentation',
    addedAt: new Date().toISOString(),
  },
]

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/google-slides] Google Slides tools', () => {
  it('ships the full 11-tool surface (no legacy addSlide/addTextToSlide)', () => {
    const tools = createGoogleSlidesTools(mockApi())
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'googleSlidesBatchUpdate',
      'googleSlidesCreatePresentation',
      'googleSlidesCreateSlide',
      'googleSlidesDeleteSlide',
      'googleSlidesDuplicateSlide',
      'googleSlidesGetPresentation',
      'googleSlidesGetSlideContent',
      'googleSlidesGetThumbnail',
      'googleSlidesInsertImage',
      'googleSlidesReorderSlides',
      'googleSlidesUpdateSlideContent',
    ])
    expect(names).not.toContain('googleSlidesAddSlide')
    expect(names).not.toContain('googleSlidesAddTextToSlide')
  })

  describe('read tools', () => {
    it('getPresentation is concurrency-safe and read-only', () => {
      const tool = createGoogleSlidesTools(mockApi()).find(
        (t) => t.name === 'googleSlidesGetPresentation',
      )!
      expect(tool.isConcurrencySafe).toBe(true)
      expect(tool.isReadOnly).toBe(true)
      expect(tool.requiresConfirmation).toBe(false)
    })

    it('getSlideContent forwards slideIndex to the API', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesGetSlideContent',
      )!
      const result = await tool.execute({ presentationId: 'p1', slideIndex: 2 }, ctx)
      expect(api.getSlideContent).toHaveBeenCalledWith('p1', 2)
      expect(result.isError).toBeFalsy()
    })

    it('getSlideContent rejects negative slideIndex', () => {
      const tool = createGoogleSlidesTools(mockApi()).find(
        (t) => t.name === 'googleSlidesGetSlideContent',
      )!
      const parsed = tool.inputSchema.safeParse({ presentationId: 'p1', slideIndex: -1 })
      expect(parsed.success).toBe(false)
    })

    it('getThumbnail passes size option through', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesGetThumbnail',
      )!
      await tool.execute(
        { presentationId: 'p1', slideObjectId: 's1', size: 'LARGE' },
        ctx,
      )
      expect(api.getSlideThumbnail).toHaveBeenCalledWith('p1', 's1', { size: 'LARGE' })
    })
  })

  describe('write tools — confirmation gating', () => {
    it('createSlide prompts when presentation is NOT in authorized files', async () => {
      const tool = createGoogleSlidesTools(mockApi(), []).find(
        (t) => t.name === 'googleSlidesCreateSlide',
      )!
      expect(tool.requiresConfirmation).toBe(true)
      const prompt = await tool.resolveConfirmation!(ctx, { presentationId: 'stranger' })
      expect(prompt).toBe(true)
    })

    it('createSlide skips prompt when presentation IS in authorized files', async () => {
      const tool = createGoogleSlidesTools(mockApi(), authorized).find(
        (t) => t.name === 'googleSlidesCreateSlide',
      )!
      const prompt = await tool.resolveConfirmation!(ctx, { presentationId: 'authed-pres' })
      expect(prompt).toBe(false)
    })

    it('every write tool requires confirmation by default', () => {
      const writeTools = createGoogleSlidesTools(mockApi()).filter(
        (t) => !t.isReadOnly,
      )
      expect(writeTools.length).toBe(8)
      for (const tool of writeTools) {
        expect(tool.requiresConfirmation).toBe(true)
      }
    })
  })

  describe('createSlide — atomic fill', () => {
    it('passes placeholders and layout through in a single API call', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesCreateSlide',
      )!
      await tool.execute(
        {
          presentationId: 'p1',
          layout: 'TITLE_AND_BODY',
          placeholders: { TITLE: 'Q3 Review', BODY: '• Point one\n• Point two' },
        },
        ctx,
      )
      expect(api.createSlide).toHaveBeenCalledTimes(1)
      expect(api.createSlide).toHaveBeenCalledWith('p1', expect.objectContaining({
        layout: 'TITLE_AND_BODY',
        placeholders: { TITLE: 'Q3 Review', BODY: '• Point one\n• Point two' },
      }))
    })

    it('rejects unknown layout strings', () => {
      const tool = createGoogleSlidesTools(mockApi()).find(
        (t) => t.name === 'googleSlidesCreateSlide',
      )!
      const parsed = tool.inputSchema.safeParse({
        presentationId: 'p1',
        layout: 'SIX_COLUMN_NONSENSE',
      })
      expect(parsed.success).toBe(false)
    })

    it('accepts an image with a Drive file source + placeholder target', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesCreateSlide',
      )!
      await tool.execute(
        {
          presentationId: 'p1',
          layout: 'TITLE',
          placeholders: { TITLE: 'Hello' },
          images: [{
            source: { driveFileId: 'drive-file-1' },
            target: { placeholderType: 'PICTURE' },
          }],
        },
        ctx,
      )
      const call = (api.createSlide as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
        images?: Array<{ source: { driveFileId: string }; target: { placeholderType: string } }>
      }
      expect(call.images).toHaveLength(1)
      expect(call.images![0].source).toEqual({ driveFileId: 'drive-file-1' })
    })
  })

  describe('updateSlideContent — semantic replacement', () => {
    it('accepts placeholder-typed and shape-ID updates in the same call', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesUpdateSlideContent',
      )!
      await tool.execute(
        {
          presentationId: 'p1',
          slideObjectId: 's1',
          updates: [
            { placeholderType: 'TITLE', text: 'New title' },
            { shapeObjectId: 'shape_42', text: 'Explicit target' },
          ],
        },
        ctx,
      )
      expect(api.updateSlideContent).toHaveBeenCalledWith('p1', {
        slideObjectId: 's1',
        updates: [
          { placeholderType: 'TITLE', text: 'New title' },
          { shapeObjectId: 'shape_42', text: 'Explicit target' },
        ],
      })
    })

    it('requires at least one update', () => {
      const tool = createGoogleSlidesTools(mockApi()).find(
        (t) => t.name === 'googleSlidesUpdateSlideContent',
      )!
      const parsed = tool.inputSchema.safeParse({
        presentationId: 'p1',
        slideObjectId: 's1',
        updates: [],
      })
      expect(parsed.success).toBe(false)
    })
  })

  describe('deleteSlide / reorder / duplicate', () => {
    it('deleteSlide returns structured data (no silent-success string)', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesDeleteSlide',
      )!
      const result = await tool.execute(
        { presentationId: 'p1', slideObjectId: 's1' },
        ctx,
      )
      expect(result.isError).toBeFalsy()
      expect(result.data).toEqual({ deleted: 's1' })
    })

    it('reorderSlides requires at least one slide', () => {
      const tool = createGoogleSlidesTools(mockApi()).find(
        (t) => t.name === 'googleSlidesReorderSlides',
      )!
      const parsed = tool.inputSchema.safeParse({
        presentationId: 'p1',
        slideObjectIds: [],
        insertionIndex: 0,
      })
      expect(parsed.success).toBe(false)
    })

    it('duplicateSlide forwards optional insertionIndex', async () => {
      const api = mockApi()
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesDuplicateSlide',
      )!
      await tool.execute(
        { presentationId: 'p1', slideObjectId: 's1', insertionIndex: 4 },
        ctx,
      )
      expect(api.duplicateSlide).toHaveBeenCalledWith('p1', 's1', 4)
    })
  })

  describe('error paths', () => {
    it('returns isError with the provider message on failure', async () => {
      const api = mockApi({
        createSlide: vi.fn().mockRejectedValue(new Error('slides 403: disabled')),
      })
      const tool = createGoogleSlidesTools(api).find(
        (t) => t.name === 'googleSlidesCreateSlide',
      )!
      const result = await tool.execute(
        { presentationId: 'p1', layout: 'TITLE' },
        ctx,
      )
      expect(result.isError).toBe(true)
      expect(String(result.data)).toContain('slides 403: disabled')
    })
  })
})
