/**
 * Google Slides tools — structured read + placeholder-targeted, atomic write.
 *
 * Full design rationale: docs/architecture/integrations/google-slides.md.
 *
 * Read tools are concurrency-safe; write tools require confirmation unless
 * the target presentation is in the user's authorized-files list.
 * The `api` callbacks are injected by the API layer so core stays free of
 * network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import type { AuthorizedFile } from './google-drive.js'

// Keep these string unions in sync with the Slides REST API enums
// (see Google Slides API reference → `PlaceholderType` and
// `PredefinedLayout`). Exported so the API layer can share them.
export type SlidePlaceholderType =
  | 'TITLE'
  | 'SUBTITLE'
  | 'BODY'
  | 'CENTERED_TITLE'
  | 'HEADER'
  | 'FOOTER'
  | 'PAGE_NUMBER'
  | 'DATE_AND_TIME'
  | 'OBJECT'
  | 'PICTURE'
  | 'UNSPECIFIED'

export type SlideLayoutType =
  | 'BLANK'
  | 'TITLE'
  | 'TITLE_AND_BODY'
  | 'TITLE_AND_TWO_COLUMNS'
  | 'TITLE_ONLY'
  | 'SECTION_HEADER'
  | 'SECTION_TITLE_AND_DESCRIPTION'
  | 'ONE_COLUMN_TEXT'
  | 'MAIN_POINT'
  | 'BIG_NUMBER'

const PLACEHOLDER_TYPES = [
  'TITLE', 'SUBTITLE', 'BODY', 'CENTERED_TITLE',
  'HEADER', 'FOOTER', 'PAGE_NUMBER', 'DATE_AND_TIME',
  'OBJECT', 'PICTURE', 'UNSPECIFIED',
] as const

const LAYOUT_TYPES = [
  'BLANK', 'TITLE', 'TITLE_AND_BODY', 'TITLE_AND_TWO_COLUMNS',
  'TITLE_ONLY', 'SECTION_HEADER', 'SECTION_TITLE_AND_DESCRIPTION',
  'ONE_COLUMN_TEXT', 'MAIN_POINT', 'BIG_NUMBER',
] as const

export type GoogleSlidesApi = {
  getPresentationInfo(presentationId: string): Promise<unknown>
  getSlideContent(presentationId: string, slideIndex: number): Promise<unknown>
  getSlideThumbnail(
    presentationId: string,
    slideObjectId: string,
    options?: { size?: 'LARGE' | 'MEDIUM' | 'SMALL' },
  ): Promise<unknown>
  createSlide(
    presentationId: string,
    args: {
      insertionIndex?: number
      layout?: SlideLayoutType
      placeholders?: Partial<Record<SlidePlaceholderType, string>>
      images?: Array<{
        source: { driveFileId: string } | { url: string }
        target?:
          | { placeholderType: 'PICTURE' | 'OBJECT' }
          | { boxEmu: { x: number; y: number; w: number; h: number } }
      }>
    },
  ): Promise<unknown>
  updateSlideContent(
    presentationId: string,
    args: {
      slideObjectId: string
      updates: Array<
        | { placeholderType: SlidePlaceholderType; text: string }
        | { shapeObjectId: string; text: string }
      >
    },
  ): Promise<unknown>
  insertImage(
    presentationId: string,
    args: {
      slideObjectId: string
      source: { driveFileId: string } | { url: string }
      target?:
        | { placeholderType: 'PICTURE' | 'OBJECT' }
        | { boxEmu: { x: number; y: number; w: number; h: number } }
    },
  ): Promise<unknown>
  deleteSlide(presentationId: string, slideObjectId: string): Promise<unknown>
  reorderSlides(
    presentationId: string,
    slideObjectIds: string[],
    insertionIndex: number,
  ): Promise<unknown>
  duplicateSlide(
    presentationId: string,
    slideObjectId: string,
    insertionIndex?: number,
  ): Promise<unknown>
  batchUpdate(presentationId: string, requests: unknown[]): Promise<unknown>
  createPresentation(title: string): Promise<{ presentationId: string; title: string; url: string }>
}

function isAuthorized(id: string | undefined, authorized: AuthorizedFile[]): boolean {
  if (!id || !authorized.length) return false
  return authorized.some((f) => f.id === id)
}

function slidesError(err: unknown): { data: string; isError: true } {
  return {
    data: `Slides error: ${err instanceof Error ? err.message : String(err)}`,
    isError: true,
  }
}

export function createGoogleSlidesTools(
  api: GoogleSlidesApi,
  authorizedFiles: AuthorizedFile[] = [],
): Tool[] {
  const getPresentation = buildTool({
    name: 'googleSlidesGetPresentation',
    description:
      'Get metadata for a Google Slides presentation — title, page dimensions (EMU), ' +
      'and a list of slides with object IDs, page numbers, and element counts. ' +
      'Use this first to discover slides before reading or editing them.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getPresentationInfo(input.presentationId)
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const getSlideContent = buildTool({
    name: 'googleSlidesGetSlideContent',
    description:
      'Read a slide as structured elements — one entry per shape with its object ID, shape type, ' +
      'placeholder role (TITLE/SUBTITLE/BODY/…), text content, and normalized bounding box. ' +
      'Use this to plan edits: target placeholders by role (not by position), and pass shape object IDs ' +
      'to write tools when precise targeting is needed.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideIndex: z.number().int().nonnegative().describe('Zero-based slide index (0 = first slide).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getSlideContent(input.presentationId, input.slideIndex)
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const getThumbnail = buildTool({
    name: 'googleSlidesGetThumbnail',
    description:
      'Render a slide to a PNG thumbnail. Returns a signed URL plus width/height. ' +
      'Use this to visually verify the result of an edit — the chat route can fetch the PNG ' +
      'and feed it back to you as multimodal input.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideObjectId: z.string().describe('The slide object ID (from googleSlidesGetPresentation).'),
      size: z.enum(['LARGE', 'MEDIUM', 'SMALL']).optional().describe('Thumbnail size (default MEDIUM).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.getSlideThumbnail(input.presentationId, input.slideObjectId, {
          size: input.size,
        })
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const createSlideTool = buildTool({
    name: 'googleSlidesCreateSlide',
    description:
      'Create a new slide, apply a layout, and fill its placeholders — atomically in one API call. ' +
      'Prefer this over manually building a slide piece-by-piece. Placeholder keys are the placeholder role ' +
      '(TITLE, SUBTITLE, BODY, etc); values are the text to insert. ' +
      'Use the `images` array to fill PICTURE/OBJECT placeholders from a Drive file ID or public URL.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      insertionIndex: z.number().int().nonnegative().optional().describe('Zero-based insertion index. Omit to append.'),
      layout: z.enum(LAYOUT_TYPES).optional().describe('Predefined layout (default BLANK if no placeholders provided).'),
      placeholders: z.record(z.enum(PLACEHOLDER_TYPES), z.string()).optional().describe(
        'Map of placeholder type → text. Example: { TITLE: "Q3 Review", BODY: "• Point one\\n• Point two" }.',
      ),
      images: z.array(z.object({
        source: z.union([
          z.object({ driveFileId: z.string() }),
          z.object({ url: z.string().url() }),
        ]),
        target: z.union([
          z.object({ placeholderType: z.enum(['PICTURE', 'OBJECT']) }),
          z.object({ boxEmu: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
        ]).optional(),
      })).optional().describe('Images to insert on the new slide.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.createSlide(input.presentationId, {
          insertionIndex: input.insertionIndex,
          layout: input.layout as SlideLayoutType | undefined,
          placeholders: input.placeholders as Partial<Record<SlidePlaceholderType, string>> | undefined,
          images: input.images,
        })
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const updateSlideContent = buildTool({
    name: 'googleSlidesUpdateSlideContent',
    description:
      'Replace the text of one or more shapes on an existing slide. Each update targets either a placeholder ' +
      'role (TITLE, SUBTITLE, BODY, etc) or an explicit shape object ID from googleSlidesGetSlideContent. ' +
      'Text is *replaced*, not appended — previous content in the target is cleared first.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideObjectId: z.string().describe('The slide object ID.'),
      updates: z.array(z.union([
        z.object({
          placeholderType: z.enum(PLACEHOLDER_TYPES),
          text: z.string(),
        }),
        z.object({
          shapeObjectId: z.string(),
          text: z.string(),
        }),
      ])).min(1).describe('One or more text replacements to apply.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.updateSlideContent(input.presentationId, {
          slideObjectId: input.slideObjectId,
          updates: input.updates.map((u) =>
            'placeholderType' in u
              ? { placeholderType: u.placeholderType as SlidePlaceholderType, text: u.text }
              : { shapeObjectId: u.shapeObjectId, text: u.text },
          ),
        })
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const insertImageTool = buildTool({
    name: 'googleSlidesInsertImage',
    description:
      'Insert an image on a slide — either into an existing PICTURE/OBJECT placeholder, at an explicit ' +
      'bounding box (EMU units), or at a default position if no target is given. ' +
      'Image source is a Drive file ID (the user must have picked that file) or a publicly accessible URL.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideObjectId: z.string().describe('The slide object ID.'),
      source: z.union([
        z.object({ driveFileId: z.string() }),
        z.object({ url: z.string().url() }),
      ]),
      target: z.union([
        z.object({ placeholderType: z.enum(['PICTURE', 'OBJECT']) }),
        z.object({ boxEmu: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) }),
      ]).optional(),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.insertImage(input.presentationId, {
          slideObjectId: input.slideObjectId,
          source: input.source,
          target: input.target,
        })
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const deleteSlideTool = buildTool({
    name: 'googleSlidesDeleteSlide',
    description:
      'Delete a slide by its object ID. Use this to self-correct a mistaken create, or to remove ' +
      'slides the user no longer wants.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideObjectId: z.string().describe('The slide object ID.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        await api.deleteSlide(input.presentationId, input.slideObjectId)
        return { data: { deleted: input.slideObjectId } }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const reorderSlidesTool = buildTool({
    name: 'googleSlidesReorderSlides',
    description:
      'Move one or more slides to a new position in the presentation. ' +
      'Slide object IDs are moved as a group; their relative order is preserved. ' +
      'Pass zero-based indices.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideObjectIds: z.array(z.string()).min(1).describe('IDs of slides to move, in the order they should appear.'),
      insertionIndex: z.number().int().nonnegative().describe('Target zero-based index.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        await api.reorderSlides(input.presentationId, input.slideObjectIds, input.insertionIndex)
        return { data: { moved: input.slideObjectIds.length, insertionIndex: input.insertionIndex } }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const duplicateSlideTool = buildTool({
    name: 'googleSlidesDuplicateSlide',
    description:
      'Duplicate a slide (including all its content). Optionally specify where to place the copy; ' +
      'defaults to right after the original.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      slideObjectId: z.string().describe('The slide to duplicate.'),
      insertionIndex: z.number().int().nonnegative().optional().describe('Target zero-based index for the copy.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.duplicateSlide(input.presentationId, input.slideObjectId, input.insertionIndex)
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const batchUpdateTool = buildTool({
    name: 'googleSlidesBatchUpdate',
    description:
      'Escape hatch: submit raw Google Slides API batchUpdate requests. Only use this when no structured tool ' +
      'covers what you need. Each request object must match the Slides API shape — see the Google Slides API reference.',
    inputSchema: z.object({
      presentationId: z.string().describe('The Google Slides presentation ID.'),
      requests: z.array(z.record(z.string(), z.unknown())).min(1).describe('Array of Slides API request objects.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async resolveConfirmation(_context, input) {
      const id = (input as { presentationId?: string })?.presentationId
      return !isAuthorized(id, authorizedFiles)
    },

    async execute(input) {
      try {
        const data = await api.batchUpdate(input.presentationId, input.requests)
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  const createPresentationTool = buildTool({
    name: 'googleSlidesCreatePresentation',
    description:
      'Create a new, empty Google Slides presentation with the given title. ' +
      'Returns the presentation ID and URL. After creation, the file is auto-added ' +
      'to the user\'s authorized files so subsequent edits (googleSlidesCreateSlide, ' +
      'googleSlidesUpdateSlideContent, etc.) do not re-prompt. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt for this initial create.',
    inputSchema: z.object({
      title: z.string().min(1).describe('Presentation title (e.g. "Q3 Review").'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,

    async resolveConfirmation() {
      return true
    },

    async execute(input) {
      try {
        const data = await api.createPresentation(input.title)
        return { data }
      } catch (err) {
        return slidesError(err)
      }
    },
  })

  return [
    getPresentation,
    getSlideContent,
    getThumbnail,
    createSlideTool,
    updateSlideContent,
    insertImageTool,
    deleteSlideTool,
    reorderSlidesTool,
    duplicateSlideTool,
    batchUpdateTool,
    createPresentationTool,
  ]
}
