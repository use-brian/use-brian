/**
 * Live recording page routes: destination creation plus sequential audio-window
 * transcription and rolling meeting-note updates. [COMP:recordings/live-page-route]
 */

import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import {
  applyOps,
  buildUndoEntry,
  calculateCost,
  collectStream,
  transcribeAudio,
  type DocGateway,
  type DocPageStore,
  type LLMProvider,
  type MediaBackend,
  type Op,
  type Page,
  type SavedViewStore,
  type TokenUsage,
  type UsageStore,
} from '@use-brian/core'

const LIVE_WINDOW_MAX_BYTES = 2 * 1024 * 1024
const LIVE_NOTES_MAX_CHARS = 6_000

export type LiveTranscriptionResult = {
  text: string
  model: string
  usage: TokenUsage | null
}

export type LiveNotesResult = {
  text: string
  model: string
  usage: TokenUsage | null
}

export type RecordingLiveRouteDeps = {
  getRole: (userId: string, workspaceId: string) => Promise<string | null>
  savedViewStore: Pick<SavedViewStore, 'createDraft' | 'getById' | 'getPage' | 'updatePage'>
  docGateway?: DocGateway
  docPageStore?: Pick<DocPageStore, 'getVersionedPage' | 'applyPatch'>
  provider: LLMProvider
  backgroundModel: string
  voiceTranscription: {
    enabled: boolean
    apiKey: string
    backend?: MediaBackend
    model?: string
  }
  usageStore?: UsageStore
  transcribeWindow?: (input: { buffer: Buffer; mime: string }) => Promise<LiveTranscriptionResult>
  reviseNotes?: (input: { previousNotes: string; transcript: string }) => Promise<LiveNotesResult>
}

type LivePageBlocks = {
  notesHeadingId: string
  notesBlockId: string
  transcriptHeadingId: string
  transcriptAnchorId: string
  page: Page
}

function userIdOf(req: unknown): string | undefined {
  return (req as { userId?: string }).userId
}

function livePageBlocks(): LivePageBlocks {
  const notesHeadingId = randomUUID()
  const notesBlockId = randomUUID()
  const transcriptHeadingId = randomUUID()
  const transcriptAnchorId = randomUUID()
  return {
    notesHeadingId,
    notesBlockId,
    transcriptHeadingId,
    transcriptAnchorId,
    page: {
      blocks: [
        { id: notesHeadingId, kind: 'heading', level: 2, text: 'Meeting notes' },
        { id: notesBlockId, kind: 'text', variant: 'muted', text: 'Listening for the first update...' },
        { id: transcriptHeadingId, kind: 'heading', level: 2, text: 'Live transcript' },
        {
          id: transcriptAnchorId,
          kind: 'text',
          variant: 'caption',
          text: 'Live transcript and notes are provisional until the recording finishes processing.',
        },
      ],
    },
  }
}

function transcriptStamp(offsetMs: number): string {
  const total = Math.max(0, Math.floor(offsetMs / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `[${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`
    : `[${minutes}:${String(seconds).padStart(2, '0')}]`
}

async function applyPageOps(
  deps: RecordingLiveRouteDeps,
  userId: string,
  pageId: string,
  ops: Op[],
): Promise<Page> {
  if (deps.docGateway) {
    const result = await deps.docGateway.applyOps({ userId, pageId, ops })
    if ('error' in result) throw new Error(result.error)
    if (result.skipped.length > 0) throw new Error(result.skipped.map((row) => row.reason).join('; '))
    // A successful gateway apply already mutated the authoritative Y.Doc.
    // Older doc-sync versions omit the post-apply page; never replay the ops
    // against saved_views or the live document receives every window twice.
    return result.page ?? { blocks: [] }
  }

  if (deps.docPageStore) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await deps.docPageStore.getVersionedPage(userId, pageId)
      if (!current) throw new Error('Page content is unavailable')
      const appliedOps = applyOps(current.page, ops)
      const applied = await deps.docPageStore.applyPatch({
        userId,
        pageId,
        expectedVersion: current.version,
        nextPage: appliedOps.page,
        undo: buildUndoEntry(current.page, ops, appliedOps.idMap, current.version + 1),
      })
      if (applied) return appliedOps.page
    }
    throw new Error('Page changed while the live update was being applied')
  }

  const current = await deps.savedViewStore.getPage(userId, pageId)
  if (!current) throw new Error('Page content is unavailable')
  const next = applyOps(current, ops).page
  if (!(await deps.savedViewStore.updatePage(userId, pageId, next))) {
    throw new Error('Page update was rejected')
  }
  return next
}

function responseText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

async function defaultReviseNotes(
  deps: RecordingLiveRouteDeps,
  input: { previousNotes: string; transcript: string },
): Promise<LiveNotesResult> {
  const response = await collectStream(deps.provider.stream({
    model: deps.backgroundModel,
    systemPrompt:
      'Maintain concise rolling meeting notes. Preserve important decisions, action items, owners, risks, and unresolved questions. Return only the complete revised notes in plain text. Do not add a heading or commentary.',
    messages: [{
      role: 'user',
      content:
        `Current notes:\n${input.previousNotes || '(none yet)'}\n\n` +
        `Newest transcript window:\n${input.transcript}`,
    }],
    maxTokens: 1_500,
    temperature: 0.2,
  }))
  const text = responseText(response.content).slice(0, LIVE_NOTES_MAX_CHARS)
  return {
    text: text || input.previousNotes || input.transcript,
    model: response.model || deps.backgroundModel,
    usage: response.usage,
  }
}

async function recordUsage(
  deps: RecordingLiveRouteDeps,
  input: {
    userId: string
    workspaceId: string
    assistantId: string
    model: string
    usage: TokenUsage | null
    source: string
    triggerKey: string
    audioSeconds?: number
  },
): Promise<void> {
  if (!deps.usageStore || !input.usage) return
  try {
    await deps.usageStore.recordUsage({
      userId: input.userId,
      assistantId: input.assistantId,
      sessionId: null,
      workspaceId: input.workspaceId,
      model: input.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cacheReadTokens: input.usage.cacheReadTokens,
      cacheWriteTokens: input.usage.cacheWriteTokens,
      actualCostUsd: calculateCost(input.model, input.usage),
      source: input.source,
      triggerKey: input.triggerKey,
      ...(input.audioSeconds !== undefined ? { audioSeconds: input.audioSeconds } : {}),
    })
  } catch (error) {
    console.error('[recording-live] usage tracking failed:', error)
  }
}

export function recordingLiveRoutes(deps: RecordingLiveRouteDeps): Router {
  const router = Router()
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LIVE_WINDOW_MAX_BYTES, files: 1 },
  })

  router.post('/live/start', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    if (!deps.voiceTranscription.enabled) {
      return void res.status(503).json({ error: 'Live transcription is not available' })
    }
    const { workspaceId, destination, pageId, parentPageId, title } = (req.body ?? {}) as {
      workspaceId?: string
      destination?: 'existing' | 'new'
      pageId?: string
      parentPageId?: string | null
      title?: string
    }
    if (!workspaceId || (destination !== 'existing' && destination !== 'new')) {
      return void res.status(400).json({ error: 'workspaceId and a valid destination are required' })
    }
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }

    try {
      const seeded = livePageBlocks()
      let resolvedPageId: string
      let resolvedTitle: string
      if (destination === 'existing') {
        if (!pageId) return void res.status(400).json({ error: 'pageId is required' })
        const page = await deps.savedViewStore.getById(userId, pageId)
        if (!page || page.workspaceId !== workspaceId) {
          return void res.status(404).json({ error: 'Destination page not found' })
        }
        await applyPageOps(
          deps,
          userId,
          pageId,
          seeded.page.blocks.map((block) => ({ op: 'add', after: 'end', block })),
        )
        resolvedPageId = pageId
        resolvedTitle = page.name
      } else {
        if (parentPageId) {
          const parent = await deps.savedViewStore.getById(userId, parentPageId)
          if (!parent || parent.workspaceId !== workspaceId) {
            return void res.status(404).json({ error: 'Parent page not found' })
          }
        }
        resolvedTitle = title?.trim().slice(0, 120) || `Meeting notes ${new Date().toLocaleDateString('en-CA')}`
        const created = await deps.savedViewStore.createDraft({
          userId,
          workspaceId,
          name: resolvedTitle,
          nameOrigin: 'user',
          entity: 'tasks',
          viewType: 'table',
          binding: { entity: 'tasks', viewType: 'table' },
          page: seeded.page,
          nestParentId: parentPageId ?? null,
          state: 'saved',
          writtenBy: 'user',
        })
        resolvedPageId = created.id
      }

      res.status(201).json({
        pageId: resolvedPageId,
        title: resolvedTitle,
        notesBlockId: seeded.notesBlockId,
        transcriptAfterId: seeded.transcriptAnchorId,
      })
    } catch (error) {
      console.error('[recording-live] start failed:', error)
      res.status(503).json({ error: 'Could not prepare the live meeting page' })
    }
  })

  router.post('/live/chunk', upload.single('audio'), async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    if (!deps.voiceTranscription.enabled) {
      return void res.status(503).json({ error: 'Live transcription is not available' })
    }
    if (!req.file) return void res.status(400).json({ error: 'audio is required' })
    if (!req.file.mimetype.startsWith('audio/') && !req.file.mimetype.startsWith('video/')) {
      return void res.status(400).json({ error: 'Only audio/video live windows are supported' })
    }
    const { workspaceId, pageId, assistantId, notesBlockId, transcriptAfterId, chunkId } = req.body as Record<string, string | undefined>
    const offsetMs = Number(req.body.offsetMs)
    const durationMs = Number(req.body.durationMs)
    const missedWindows = Number(req.body.missedWindows ?? 0)
    if (!workspaceId || !pageId || !assistantId || !notesBlockId || !transcriptAfterId || !chunkId) {
      return void res.status(400).json({ error: 'Live window metadata is incomplete' })
    }
    if (!Number.isFinite(offsetMs) || offsetMs < 0 || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) {
      return void res.status(400).json({ error: 'Live window timing is invalid' })
    }
    if (!Number.isInteger(missedWindows) || missedWindows < 0 || missedWindows > 120) {
      return void res.status(400).json({ error: 'missedWindows is invalid' })
    }
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }
    const view = await deps.savedViewStore.getById(userId, pageId)
    if (!view || view.workspaceId !== workspaceId) {
      return void res.status(404).json({ error: 'Destination page not found' })
    }
    const current = await deps.savedViewStore.getPage(userId, pageId)
    if (!current) return void res.status(409).json({ error: 'Destination page is unavailable' })
    if (current.blocks.some((block) => block.id === chunkId)) {
      return void res.json({ duplicate: true, transcriptAfterId: chunkId })
    }
    const notesBlock = current.blocks.find((block) => block.id === notesBlockId)
    if (!notesBlock || notesBlock.kind !== 'text' || !current.blocks.some((block) => block.id === transcriptAfterId)) {
      return void res.status(409).json({ error: 'Live page anchors are no longer available' })
    }

    try {
      const transcription = deps.transcribeWindow
        ? await deps.transcribeWindow({ buffer: req.file.buffer, mime: req.file.mimetype })
        : await transcribeAudio(
            { buffer: req.file.buffer, mime: req.file.mimetype },
            {
              apiKey: deps.voiceTranscription.apiKey,
              backend: deps.voiceTranscription.backend,
              model: deps.voiceTranscription.model,
              prompt: 'Transcribe this meeting-audio window verbatim. Return only speech text, with no timestamps or commentary.',
            },
          )
      const transcript = transcription.text.trim()
      const notes = await (deps.reviseNotes ?? ((input) => defaultReviseNotes(deps, input)))({
        previousNotes: notesBlock.text === 'Listening for the first update...' ? '' : notesBlock.text,
        transcript,
      })
      const gapBlockId = `${chunkId}-gap`
      await applyPageOps(deps, userId, pageId, [
        { op: 'edit', blockId: notesBlockId, patch: { text: notes.text, variant: 'body' } },
        ...(missedWindows > 0
          ? [{
              op: 'add' as const,
              after: transcriptAfterId,
              block: {
                id: gapBlockId,
                kind: 'text' as const,
                variant: 'caption' as const,
                text: `[${missedWindows} live transcript window${missedWindows === 1 ? '' : 's'} unavailable]`,
              },
            }]
          : []),
        {
          op: 'add',
          after: missedWindows > 0 ? gapBlockId : transcriptAfterId,
          block: { id: chunkId, kind: 'text', text: `${transcriptStamp(offsetMs)} ${transcript}` },
        },
      ])
      await Promise.all([
        recordUsage(deps, {
          userId,
          workspaceId,
          assistantId,
          model: transcription.model,
          usage: transcription.usage,
          source: 'overhead:transcription',
          triggerKey: 'live_recording_transcription',
          audioSeconds: durationMs / 1000,
        }),
        recordUsage(deps, {
          userId,
          workspaceId,
          assistantId,
          model: notes.model,
          usage: notes.usage,
          source: 'overhead:synthesis',
          triggerKey: 'live_meeting_notes',
        }),
      ])
      res.json({ transcript, notes: notes.text, transcriptAfterId: chunkId })
    } catch (error) {
      console.error('[recording-live] window failed:', error)
      res.status(503).json({ error: 'This live transcript window could not be processed' })
    }
  })

  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (error instanceof multer.MulterError) {
      return void res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: error.code === 'LIMIT_FILE_SIZE' ? 'Live audio window is too large' : 'Invalid live audio upload',
      })
    }
    next(error)
  })

  return router
}
