import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  applyDeckOps,
  deckOpSchema,
  deckSpecSchema,
  deckSpecShape,
  type DeckSpec,
  type DeckStyle,
} from '@use-brian/shared/decks'
import { buildTool, type Tool } from '../tools/types.js'
import type { FilesApi, FilesContext } from '../workspace-files/api.js'
import { ctxFor, errorMessage, workspaceGate } from '../workspace-files/tool-helpers.js'
import { resolveDeckImages } from './image-resolve.js'
import { writeDeckPptx } from './pptx-writer.js'
import { extractDeckStyle } from './style-extract.js'

/**
 * Deck tools — generatePowerpoint / updatePowerpoint / getPowerpoint.
 * Always-on core tools (registered in boot's allTools, so chat, the callee
 * executor and workflow steps all get them). Decks are persistent artifacts:
 * a workspace_decks row (spec) + a stable workspace file decks/<id>.pptx
 * (binary), rebuilt in place on every edit. Delivery stays with sendFile /
 * gmail attachments. Spec: docs/architecture/features/deck-generation.md.
 * [COMP:decks/tools]
 */

export const DECK_PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'

export interface DeckRecord {
  id: string
  workspaceId: string
  title: string
  spec: DeckSpec
  style: DeckStyle | null
  styleSource: string | null
  filePath: string
  version: number
}

/**
 * Persistence port — implemented over workspace_decks in packages/api
 * (db/deck-store.ts), which also emits the `deck` workspace event on
 * create/update. Same FilesContext scoping discipline as FilesApi: the
 * store derives workspace/user scoping from ctx, never from tool input.
 */
export interface DeckStorePort {
  create(
    ctx: FilesContext,
    row: {
      id: string
      title: string
      spec: DeckSpec
      style: DeckStyle | null
      styleSource: string | null
      filePath: string
    },
  ): Promise<DeckRecord>
  get(ctx: FilesContext, deckId: string): Promise<DeckRecord | null>
  update(
    ctx: FilesContext,
    deckId: string,
    patch: {
      title: string
      spec: DeckSpec
      style: DeckStyle | null
      styleSource: string | null
      expectedVersion: number
    },
  ): Promise<DeckRecord | 'version_conflict' | null>
}

export interface DeckToolOptions {
  filesApi: FilesApi
  deckStore: DeckStorePort
  /** app-web origin (e.g. https://app.usebrian.ai) for previewUrl links; omit to skip links. */
  appOrigin?: string
}

const STYLE_SCOPE_NOTE =
  'Style extraction copies the reference deck\'s COLORS and FONTS onto the standard layouts; it does not clone its slide designs or images.'

const LAYOUT_MANUAL =
  "Slide layouts: 'content' (title + bullets and/or a chart or image), 'statement' (one big centered claim), " +
  "'stats' (row of 1-4 big-number tiles), 'quote' (testimonial), 'section' (divider). A title slide is added automatically. " +
  "Charts (bar/line for trends, pie/doughnut for shares) go on 'content' slides via `chart`. " +
  "Every 'content' slide MUST have `bullets`, `chart` and/or `image` — body text goes in `bullets` (there is no 'content'/'body' field); " +
  "use 'statement' or 'section' for title-only slides. One idea per slide. " +
  'Images: prefer `image.path` (a workspace file); `image.url` must be a public http(s) png/jpeg/gif (max 10MB, 10 per deck).'

function preview(appOrigin: string | undefined, workspaceId: string, deckId: string): string | undefined {
  return appOrigin ? `${appOrigin.replace(/\/$/, '')}/w/${workspaceId}/decks/${deckId}` : undefined
}

async function resolveStyle(
  filesApi: FilesApi,
  ctx: FilesContext,
  styleFromFile: string,
): Promise<{ style: DeckStyle; styleSource: string } | { error: string }> {
  const read = await filesApi.readBytes(ctx, styleFromFile)
  if (!read.ok) return { error: errorMessage(read.error) }
  try {
    return { style: await extractDeckStyle(read.value.bytes), styleSource: read.value.file.path }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'could not extract a style from that file' }
  }
}

async function buildAndStore(
  filesApi: FilesApi,
  ctx: FilesContext,
  spec: DeckSpec,
  style: DeckStyle | null,
  filePath: string,
  overwrite: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let buffer: Buffer
  try {
    const images = await resolveDeckImages(spec, {
      readBytes: async (path) => {
        const read = await filesApi.readBytes(ctx, path)
        if (!read.ok) throw new Error(errorMessage(read.error))
        return read.value.bytes
      },
    })
    buffer = await writeDeckPptx(spec, style, images)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to build the presentation' }
  }
  // Stable-path contract: rebuilds replace the same file. FilesApi has no
  // overwrite, so delete-then-write — the buffer is already built, keeping
  // the file-absent window to the two calls below.
  if (overwrite) await filesApi.delete(ctx, filePath).catch(() => undefined)
  const written = await filesApi.writeBytes(ctx, {
    path: filePath,
    bytes: buffer,
    mime: DECK_PPTX_MIME,
    title: spec.title,
    tags: ['deck'],
  })
  if (!written.ok) return { ok: false, error: errorMessage(written.error) }
  return { ok: true }
}

export function createDeckTools(opts: DeckToolOptions): Tool[] {
  const { filesApi, deckStore, appOrigin } = opts

  const generatePowerpoint = buildTool({
    name: 'generatePowerpoint',
    requiresCapability: 'files',
    isConcurrencySafe: false,
    isReadOnly: false,
    description:
      'Create a PowerPoint deck as a persistent workspace artifact. Returns { deckId, path, previewUrl }. ' +
      LAYOUT_MANUAL +
      ' To match an existing deck\'s look, pass `styleFromFile` = the workspace path of a reference .pptx (e.g. one the user uploaded). ' +
      STYLE_SCOPE_NOTE +
      ' The built .pptx is saved to the workspace at `path` — deliver it with sendFile, or attach it to an email via the path. ' +
      'Share `previewUrl` so the user can watch the deck live while you iterate with updatePowerpoint. ' +
      'This tool does NOT send anything by itself.',
    inputSchema: z.object({
      ...deckSpecShape,
      styleFromFile: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe('Workspace path or id of a reference .pptx whose colors + fonts the deck should copy'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const { styleFromFile, ...specInput } = input
      const parsed = deckSpecSchema.safeParse(specInput)
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('; ')
        return { data: `Invalid deck spec — ${issues}`, isError: true }
      }
      const ctx = ctxFor(context)

      let style: DeckStyle | null = null
      let styleSource: string | null = null
      if (styleFromFile) {
        const resolved = await resolveStyle(filesApi, ctx, styleFromFile)
        if ('error' in resolved) return { data: resolved.error, isError: true }
        style = resolved.style
        styleSource = resolved.styleSource
      }

      const id = randomUUID()
      const filePath = `decks/${id}.pptx`
      const built = await buildAndStore(filesApi, ctx, parsed.data, style, filePath, false)
      if (!built.ok) return { data: built.error, isError: true }

      const row = await deckStore.create(ctx, {
        id,
        title: parsed.data.title,
        spec: parsed.data,
        style,
        styleSource,
        filePath,
      })
      return {
        data: {
          deckId: row.id,
          path: row.filePath,
          version: row.version,
          slideCount: parsed.data.slides.length + 1,
          styleSource: row.styleSource ?? undefined,
          previewUrl: preview(appOrigin, ctx.workspaceId, row.id),
        },
      }
    },
  })

  const updatePowerpoint = buildTool({
    name: 'updatePowerpoint',
    requiresCapability: 'files',
    isConcurrencySafe: false,
    isReadOnly: false,
    description:
      'Edit an existing deck by slide-level operations and rebuild its .pptx in place (same path, live preview refreshes automatically). ' +
      "Ops: replaceSlide{index,slide}, insertSlide{index,slide}, deleteSlide{index}, moveSlide{from,to}, setMeta{title?,subtitle?,theme?}. Slide indexes are 0-based and EXCLUDE the auto title slide. " +
      'Call getPowerpoint first when unsure of the current slides. Pass `styleFromFile` to re-style from a reference .pptx, or `clearStyle: true` to revert to the preset theme. ' +
      STYLE_SCOPE_NOTE,
    inputSchema: z.object({
      deckId: z.string().uuid().describe('The deck to edit (from generatePowerpoint / getPowerpoint)'),
      expectedVersion: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optimistic-concurrency guard: fail if the deck version moved past this'),
      ops: z.array(deckOpSchema).min(1).max(30).optional().describe('Slide operations, applied in order'),
      styleFromFile: z.string().min(1).max(1024).optional(),
      clearStyle: z.boolean().optional().describe('Revert to the preset theme (drops the reference style)'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (!input.ops?.length && !input.styleFromFile && !input.clearStyle) {
        return { data: 'Nothing to do — pass `ops`, `styleFromFile`, or `clearStyle`.', isError: true }
      }
      const ctx = ctxFor(context)
      const row = await deckStore.get(ctx, input.deckId)
      if (!row) {
        return { data: `Deck ${input.deckId} not found in this workspace — check the id via getPowerpoint results or generate a new deck.`, isError: true }
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
        return {
          data: `Deck is at version ${row.version}, not ${input.expectedVersion} — call getPowerpoint to see the current slides, then retry.`,
          isError: true,
        }
      }

      let spec: DeckSpec
      try {
        spec = input.ops?.length ? applyDeckOps(row.spec, input.ops) : row.spec
      } catch (err) {
        return { data: err instanceof Error ? err.message : 'invalid deck operation', isError: true }
      }

      let style = input.clearStyle ? null : row.style
      let styleSource = input.clearStyle ? null : row.styleSource
      if (input.styleFromFile) {
        const resolved = await resolveStyle(filesApi, ctx, input.styleFromFile)
        if ('error' in resolved) return { data: resolved.error, isError: true }
        style = resolved.style
        styleSource = resolved.styleSource
      }

      const built = await buildAndStore(filesApi, ctx, spec, style, row.filePath, true)
      if (!built.ok) return { data: built.error, isError: true }

      const updated = await deckStore.update(ctx, row.id, {
        title: spec.title,
        spec,
        style,
        styleSource,
        expectedVersion: row.version,
      })
      if (updated === 'version_conflict') {
        return { data: 'The deck changed while this edit was running — call getPowerpoint and retry.', isError: true }
      }
      if (!updated) {
        return { data: `Deck ${input.deckId} disappeared mid-edit (deleted?).`, isError: true }
      }
      return {
        data: {
          deckId: updated.id,
          path: updated.filePath,
          version: updated.version,
          slideCount: spec.slides.length + 1,
          previewUrl: preview(appOrigin, ctx.workspaceId, updated.id),
        },
      }
    },
  })

  const getPowerpoint = buildTool({
    name: 'getPowerpoint',
    requiresCapability: 'files',
    isConcurrencySafe: true,
    isReadOnly: true,
    description:
      'Read a deck\'s current slides + version before editing it with updatePowerpoint. ' +
      'Returns { spec, version, path, previewUrl }. Slide indexes in the returned spec are what updatePowerpoint ops target (0-based, title slide excluded).',
    inputSchema: z.object({
      deckId: z.string().uuid(),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const ctx = ctxFor(context)
      const row = await deckStore.get(ctx, input.deckId)
      if (!row) {
        return { data: `Deck ${input.deckId} not found in this workspace.`, isError: true }
      }
      return {
        data: {
          deckId: row.id,
          title: row.title,
          version: row.version,
          path: row.filePath,
          styleSource: row.styleSource ?? undefined,
          previewUrl: preview(appOrigin, ctx.workspaceId, row.id),
          spec: row.spec,
        },
      }
    },
  })

  return [generatePowerpoint, updatePowerpoint, getPowerpoint]
}
