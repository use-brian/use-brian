/**
 * Live recording page routes: destination creation, sequential audio-window
 * transcription with rolling STRUCTURED meeting notes, the live-transcript
 * read for the dedicated page pane, recording↔page linking, and the
 * assembled-windows finalize fallback for a failed full upload.
 * [COMP:recordings/live-page-route]
 *
 * The transcript deliberately does NOT live in doc blocks: windows land in
 * `live_transcript_windows` (migration 444) and render in the live transcript
 * pane, a purpose-built chrome surface. The page carries only the rolling
 * Meeting notes region (structured blocks between the notes heading and the
 * live marker) plus the marker itself — the well-known `live:` block-id
 * prefix is how the doc shell knows a page has a live capture surface.
 */

import { createMeetingTagsService } from '../recordings/meeting-tags-service.js'
import { ensureMeetingNotesFolder } from '../recordings/meeting-notes-folder.js'
import { meetingTagRoutes } from './meeting-tags.js'
import { randomUUID } from 'node:crypto'
import { Router, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import {
  applyOps,
  blocksToMarkdown,
  buildUndoEntry,
  calculateCost,
  collectStream,
  markdownToBlocks,
  transcribeAudio,
  type FilesApi,
  type Block,
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
import { LIVE_MARKER_ID_PREFIX } from '@use-brian/shared'
import {
  clearLiveWindowAudio,
  hasLiveWindow,
  insertLiveWindow,
  listLiveWindowsByPage,
  listLiveWindowsBySession,
  type LiveTranscriptLine,
} from '../db/live-transcript-store.js'
import type { LiveInteractionService } from '../recordings/live-interaction-service.js'
import { getRecording } from '../db/recordings-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey } from '../files/gcs-client.js'
import { adoptRecordingUpload, type UploadAdoptionDeps } from '../recordings/upload-adoption.js'
import { concatAudioWindows } from '../recordings/ffmpeg.js'

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

export type RecordingLiveRouteDeps = UploadAdoptionDeps & {
  filesApi?: Pick<FilesApi, 'writeBytes'> | null
  getRole: (userId: string, workspaceId: string) => Promise<string | null>
  savedViewStore: Pick<SavedViewStore, 'createDraft' | 'getById' | 'getPage' | 'updatePage' | 'update' | 'findIdByAnchorKey'>
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
  /** Storage for window-audio persistence + finalize. Absent → finalize 503s and window audio is not kept. */
  filesResolver?: FilesClientResolver
  transcribeWindow?: (input: { buffer: Buffer; mime: string }) => Promise<LiveTranscriptionResult>
  reviseNotes?: (input: { previousNotes: string; transcript: string }) => Promise<LiveNotesResult>
  // Injectable seams for tests; default to the real store/helpers.
  liveWindows?: {
    insert: typeof insertLiveWindow
    has: typeof hasLiveWindow
    listByPage: typeof listLiveWindowsByPage
    listBySession: typeof listLiveWindowsBySession
    clearAudio: typeof clearLiveWindowAudio
  }
  liveInteraction?: Pick<LiveInteractionService, 'getCapture' | 'ingest'>
  getRecording?: typeof getRecording
  concatWindows?: typeof concatAudioWindows
}

type LivePageBlocks = {
  notesHeadingId: string
  notesBlockId: string
  markerBlockId: string
  page: Page
}

function userIdOf(req: unknown): string | undefined {
  return (req as { userId?: string }).userId
}

function livePageBlocks(): LivePageBlocks {
  const notesHeadingId = randomUUID()
  const notesBlockId = randomUUID()
  const markerBlockId = `${LIVE_MARKER_ID_PREFIX}${randomUUID()}`
  return {
    notesHeadingId,
    notesBlockId,
    markerBlockId,
    page: {
      blocks: [
        { id: notesHeadingId, kind: 'heading', level: 2, text: 'Meeting notes' },
        { id: notesBlockId, kind: 'text', variant: 'muted', text: 'Listening for the first update...' },
        {
          id: markerBlockId,
          kind: 'text',
          variant: 'caption',
          text: 'Notes are provisional while this meeting records. The live transcript streams to the Live transcript panel below and becomes the final, citable transcript when the recording finishes processing.',
        },
      ],
    },
  }
}

/**
 * Parse a window transcript into per-line speaker attributions. Only the
 * "Speaker N:" and "Speaker N (Name):" shapes the prompt asks for are treated
 * as labels — anything else stays inside the text, so a sentence starting
 * "Note:" never becomes a phantom speaker. A single unambiguous name
 * qualification replaces that placeholder throughout THIS window, including
 * earlier lines. Speaker numbers are clip-local, so mappings never cross a
 * window. Conflicting qualifications fail safe to the placeholder.
 */
export function parseTranscriptLines(text: string): LiveTranscriptLine[] {
  const parsed: Array<{
    speaker: string | null
    identifiedName: string | null
    text: string
  }> = []
  const namesBySpeaker = new Map<string, Map<string, string>>()

  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^\*+|\*+$/g, '')
    if (!line) continue
    const match = /^speaker\s*(\d+)(?:\s*[（(]\s*([^()（）:\n]{1,80}?)\s*[)）])?\s*[:：]\s*(.*)$/i.exec(line)
    if (match && match[3]) {
      const speaker = `Speaker ${match[1]}`
      const identifiedName = match[2]?.trim() || null
      parsed.push({ speaker, identifiedName, text: match[3].trim() })
      if (identifiedName) {
        const names = namesBySpeaker.get(speaker) ?? new Map<string, string>()
        names.set(identifiedName.toLocaleLowerCase(), identifiedName)
        namesBySpeaker.set(speaker, names)
      }
    } else {
      parsed.push({ speaker: null, identifiedName: null, text: line })
    }
  }

  const resolvedNames = new Map<string, string>()
  for (const [speaker, names] of namesBySpeaker) {
    if (names.size === 1) resolvedNames.set(speaker, names.values().next().value!)
  }

  return parsed.map(({ speaker, text }) => ({
    speaker: speaker ? (resolvedNames.get(speaker) ?? speaker) : null,
    text,
  }))
}

/**
 * Rewrite the rolling notes REGION — every block strictly between the notes
 * heading and the live marker — with the freshly structured note blocks.
 * Null when either anchor is missing or out of order (the caller 409s: the
 * page was edited out from under the live session).
 */
export function notesRegionOps(
  page: Page,
  notesHeadingId: string,
  markerBlockId: string,
  noteBlocks: Block[],
): Op[] | null {
  const headingIndex = page.blocks.findIndex((block) => block.id === notesHeadingId)
  const markerIndex = page.blocks.findIndex((block) => block.id === markerBlockId)
  if (headingIndex < 0 || markerIndex < 0 || markerIndex < headingIndex) return null
  const ops: Op[] = page.blocks
    .slice(headingIndex + 1, markerIndex)
    .map((block) => ({ op: 'delete', blockId: block.id }))
  let after: string = notesHeadingId
  for (const block of noteBlocks) {
    ops.push({ op: 'add', after, block })
    after = block.id
  }
  return ops
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
      'Maintain concise rolling meeting notes in Markdown. Structure them with short "### " section headings ' +
      '(for example: Summary, Decisions, Action items, Risks, Open questions) and "- " bullet lines under each; ' +
      'keep only sections that have real content. Preserve important decisions, action items with owners, risks, ' +
      'and unresolved questions. Return ONLY the complete revised notes as Markdown - no document title, no commentary.',
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

/** Notes markdown → page blocks; a parse that yields nothing degrades to one text block. */
function notesBlocksOf(markdown: string): Block[] {
  try {
    const blocks = markdownToBlocks(markdown)
    if (blocks.length > 0) return blocks
  } catch {
    // Fall through to the plain-text degrade.
  }
  return [{ id: randomUUID(), kind: 'text', text: markdown }]
}

export function recordingLiveRoutes(deps: RecordingLiveRouteDeps): Router {
  const router = Router()
  const meetingTags = createMeetingTagsService(deps.savedViewStore)
  router.use(meetingTagRoutes(meetingTags, deps.getRole))
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: LIVE_WINDOW_MAX_BYTES, files: 2 },
  })
  const windows = deps.liveWindows ?? {
    insert: insertLiveWindow,
    has: hasLiveWindow,
    listByPage: listLiveWindowsByPage,
    listBySession: listLiveWindowsBySession,
    clearAudio: clearLiveWindowAudio,
  }
  const readRecording = deps.getRecording ?? getRecording

  router.post('/live/start', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    if (!deps.voiceTranscription.enabled) {
      return void res.status(503).json({ error: 'Live transcription is not available' })
    }
    const { workspaceId, destination, pageId, parentPageId, title, folderName } = (req.body ?? {}) as {
      workspaceId?: string
      destination?: 'existing' | 'new' | 'meeting-notes'
      pageId?: string
      parentPageId?: string | null
      title?: string
      folderName?: string
    }
    if (!workspaceId || !['existing', 'new', 'meeting-notes'].includes(destination ?? '')) {
      return void res.status(400).json({ error: 'workspaceId and a valid destination are required' })
    }
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }

    try {
      const seeded = livePageBlocks()
      const sessionId = randomUUID()
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
        let resolvedParentId = parentPageId ?? null
        if (destination === 'meeting-notes') {
          resolvedParentId = await ensureMeetingNotesFolder(deps.savedViewStore, userId, workspaceId, folderName)
        }
        if (resolvedParentId) {
          const parent = await deps.savedViewStore.getById(userId, resolvedParentId)
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
          nestParentId: resolvedParentId,
          state: 'saved',
          writtenBy: 'user',
        })
        resolvedPageId = created.id
      }

      try { await meetingTags.apply(userId, workspaceId, resolvedPageId) }
      catch (error) { console.error('[recording-live] initial meeting tagging failed:', error) }
      res.status(201).json({
        pageId: resolvedPageId,
        title: resolvedTitle,
        sessionId,
        notesHeadingId: seeded.notesHeadingId,
        markerBlockId: seeded.markerBlockId,
      })
    } catch (error) {
      console.error('[recording-live] start failed:', error)
      res.status(503).json({ error: 'Could not prepare the live meeting page' })
    }
  })

  router.post('/live/chunk', upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'microphone', maxCount: 1 }]), async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined
    req.file = files?.audio?.[0]
    const microphone = files?.microphone?.[0]
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    if (!deps.voiceTranscription.enabled) {
      return void res.status(503).json({ error: 'Live transcription is not available' })
    }
    if (!req.file) return void res.status(400).json({ error: 'audio is required' })
    if (!req.file.mimetype.startsWith('audio/') && !req.file.mimetype.startsWith('video/')) {
      return void res.status(400).json({ error: 'Only audio/video live windows are supported' })
    }
    const { workspaceId, pageId, assistantId, sessionId, notesHeadingId, markerBlockId, chunkId } =
      req.body as Record<string, string | undefined>
    const offsetMs = Number(req.body.offsetMs)
    const durationMs = Number(req.body.durationMs)
    const missedWindows = Number(req.body.missedWindows ?? 0)
    if (!workspaceId || !pageId || !assistantId || !sessionId || !notesHeadingId || !markerBlockId || !chunkId) {
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
    if (await windows.has(chunkId)) {
      return void res.json({ ok: true, duplicate: true })
    }
    const current = await deps.savedViewStore.getPage(userId, pageId)
    if (!current) return void res.status(409).json({ error: 'Destination page is unavailable' })
    const notesHeading = current.blocks.find((block) => block.id === notesHeadingId)
    const marker = current.blocks.find((block) => block.id === markerBlockId)
    if (!notesHeading || !marker) {
      return void res.status(409).json({ error: 'Live page anchors are no longer available' })
    }

    const interactionCaptureId = req.body.interactionCaptureId
    const interactionSource = req.body.interactionSource
    let interactionError = false
    let interactionAuthorized = false
    if (interactionCaptureId !== undefined) {
      try {
        if (typeof interactionCaptureId !== 'string' || !/^[0-9a-f-]{36}$/i.test(interactionCaptureId) ||
          !['microphone', 'mixed'].includes(interactionSource) || !deps.liveInteraction) throw new Error('Invalid interaction capture')
        // getCapture rechecks owner and workspace/page/chat/assistant access.
        const capture = await deps.liveInteraction.getCapture(userId, interactionCaptureId)
        // getCapture authorizes the destination assistant. The recorder's
        // upload assistant can differ from the active main-chat assistant.
        if (capture.ownerId !== userId || capture.workspaceId !== workspaceId || capture.pageId !== pageId ||
          capture.state !== 'listening') throw new Error('Capture mismatch')
        interactionAuthorized = true
      } catch {
        interactionError = true
      }
    }
    const ingest = async (source: 'microphone' | 'system', text: string, gap = false) => {
      if (!interactionAuthorized) return
      await deps.liveInteraction!.ingest(userId, interactionCaptureId, {
        id: `${sessionId}:${chunkId}:${source}`, source, text,
        startMs: offsetMs, endMs: offsetMs + durationMs,
        discontinuity: gap || missedWindows > 0 || req.body.discontinuity === 'true',
      })
    }
    const ingestSafely = async (source: 'microphone' | 'system', text: string, gap = false) => {
      try { await ingest(source, text, gap) }
      catch {
        interactionError = true
        // Best-effort durable gap if the text write failed. Never substitute
        // mixed playback as microphone evidence, even during recovery.
        try { await ingest(source, '', true) }
        catch { console.error('[recording-live] interaction gap persist failed') }
      }
    }

    // 1. Persist the window bytes FIRST (best-effort): even when transcription
    //    fails, the audio must survive for the finalize fallback — the window
    //    may end up being the only copy of this stretch of the meeting that
    //    ever reached a server.
    let audioKey: string | null = null
    if (deps.filesResolver) {
      try {
        const resolved = await deps.filesResolver.forWorkspace(workspaceId)
        const key = buildStorageKey(
          workspaceId,
          `recordings/live/${sessionId}/${String(Math.floor(offsetMs)).padStart(10, '0')}`,
        )
        await resolved.gcs.writeBlob(key, req.file.buffer, {
          workspaceId,
          createdByUserId: userId,
          mime: req.file.mimetype,
        })
        audioKey = key
      } catch (error) {
        console.error('[recording-live] window audio persist failed:', error)
      }
    }

    // 2. Transcribe. A failure still records the (audio-bearing) window row,
    //    so finalize keeps its bytes; the client counts the miss and the pane
    //    shows the gap.
    const transcribe = (file: Express.Multer.File): Promise<LiveTranscriptionResult> =>
      deps.transcribeWindow
        ? deps.transcribeWindow({ buffer: file.buffer, mime: file.mimetype })
        : transcribeAudio(
            { buffer: file.buffer, mime: file.mimetype },
            {
              apiKey: deps.voiceTranscription.apiKey,
              backend: deps.voiceTranscription.backend,
              model: deps.voiceTranscription.model,
              prompt:
                'Transcribe this meeting-audio window verbatim. When more than one speaker is audible, ' +
                "prefix each line with a consistent label like 'Speaker 1:' or 'Speaker 2:' (numbers are " +
                "local to this clip). If this clip's words make a speaker's personal name unambiguous, " +
                "qualify that label on at least one line like 'Speaker 2 (Holly):'. Use only personal names " +
                'stated or directly confirmed in the clip; do not turn roles or descriptions into names and ' +
                'do not guess. Return only the transcript lines - no timestamps, no commentary.',
            },
          )
    let transcription: LiveTranscriptionResult
    try {
      transcription = await transcribe(req.file)
    } catch (error) {
      await ingestSafely(interactionSource === 'mixed' ? 'system' : 'microphone', '', true)
      if (interactionSource === 'mixed') await ingestSafely('microphone', '', true)
      console.error('[recording-live] window transcription failed:', error)
      if (audioKey) {
        await windows
          .insert({
            chunkId, sessionId, workspaceId, pageId,
            offsetMs, durationMs, missedBefore: missedWindows,
            lines: [], audioKey,
          })
          .catch(() => {})
      }
      return void res.status(503).json({ error: 'This live transcript window could not be processed', ...(interactionError ? { interactionError } : {}) })
    }

    const transcript = transcription.text.trim()
    const lines = parseTranscriptLines(transcript)

    void recordUsage(deps, {
      userId, workspaceId, assistantId,
      model: transcription.model,
      usage: transcription.usage,
      source: 'overhead:transcription',
      triggerKey: 'live_recording_transcription',
      audioSeconds: durationMs / 1000,
    })

    // Enqueue before the canonical window's duplicate boundary. A crash before
    // insert can retry safely: the interaction store deduplicates source IDs.
    if (interactionAuthorized) {
      await ingestSafely(interactionSource === 'mixed' ? 'system' : 'microphone', transcript)
      if (interactionSource === 'mixed') {
        if (!microphone || !/^(audio|video)\//.test(microphone.mimetype)) {
          interactionError = true
          await ingestSafely('microphone', '', true)
        } else {
          try {
            const mic = await transcribe(microphone)
            void recordUsage(deps, {
              userId, workspaceId, assistantId, model: mic.model, usage: mic.usage,
              source: 'overhead:transcription', triggerKey: 'live_recording_transcription',
              audioSeconds: durationMs / 1000,
            })
            await ingestSafely('microphone', mic.text.trim())
          } catch {
            interactionError = true
            await ingestSafely('microphone', '', true)
          }
        }
      }
    }

    // 3. Interaction failure never discards the recording or transcript. Mark
    // a visible gap as well as returning interactionError when ingestion failed.
    try {
      await windows.insert({
        chunkId, sessionId, workspaceId, pageId,
        offsetMs, durationMs, missedBefore: Math.max(missedWindows, interactionError ? 1 : 0),
        lines, audioKey,
      })
    } catch (error) {
      console.error('[recording-live] window insert failed:', error)
      return void res.status(503).json({ error: 'This live transcript window could not be processed', ...(interactionError ? { interactionError } : {}) })
    }

    // 4. Rolling notes: failure here is isolated — the transcript window
    //    already landed, and the next window's revision self-heals the notes.
    let notesText: string | undefined
    try {
      const previousNotes = notesRegionText(current, notesHeadingId, markerBlockId)
      const notes = await (deps.reviseNotes ?? ((input) => defaultReviseNotes(deps, input)))({
        previousNotes,
        transcript: lines.map((line) => (line.speaker ? `${line.speaker}: ${line.text}` : line.text)).join('\n') || transcript,
      })
      const ops = notesRegionOps(current, notesHeadingId, markerBlockId, notesBlocksOf(notes.text))
      if (ops) await applyPageOps(deps, userId, pageId, ops)
      notesText = notes.text
      // Tagging failures must not interrupt the lossless capture or its notes.
      try { await meetingTags.apply(userId, workspaceId, pageId, notes.text) }
      catch (error) { console.error('[recording-live] meeting tagging failed:', error) }
      void recordUsage(deps, {
        userId, workspaceId, assistantId,
        model: notes.model,
        usage: notes.usage,
        source: 'overhead:synthesis',
        triggerKey: 'live_meeting_notes',
      })
    } catch (error) {
      console.error('[recording-live] notes revision failed:', error)
    }

    res.json({ ok: true, transcript, lines, ...(interactionError ? { interactionError } : {}), ...(notesText !== undefined ? { notes: notesText } : {}) })
  })

  // The live transcript pane's read: one page's windows, capture order.
  router.get('/live/windows', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { workspaceId, pageId } = req.query as Record<string, string | undefined>
    if (!workspaceId || !pageId) {
      return void res.status(400).json({ error: 'workspaceId and pageId are required' })
    }
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }
    const view = await deps.savedViewStore.getById(userId, pageId)
    if (!view || view.workspaceId !== workspaceId) {
      return void res.status(404).json({ error: 'Page not found' })
    }
    const rows = await windows.listByPage(workspaceId, pageId)
    res.json({
      windows: rows.map((row) => ({
        chunkId: row.chunkId,
        offsetMs: row.offsetMs,
        durationMs: row.durationMs,
        missedBefore: row.missedBefore,
        lines: row.lines,
      })),
    })
  })

  // Link a recording to a page the moment its id exists (upload-url mint) —
  // so a live meeting page carries its recording even when the upload or
  // processing later fails, and the chrome can state that status honestly.
  router.post('/live/link', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { pageId, recordingId } = (req.body ?? {}) as { pageId?: string; recordingId?: string }
    if (!pageId || !recordingId) {
      return void res.status(400).json({ error: 'pageId and recordingId are required' })
    }
    const view = await deps.savedViewStore.getById(userId, pageId)
    if (!view) return void res.status(404).json({ error: 'Page not found' })
    const recording = await readRecording(userId, recordingId)
    if (!recording || recording.workspaceId !== view.workspaceId) {
      return void res.status(400).json({ error: 'That recording is not in this page’s workspace' })
    }
    const updated = await deps.savedViewStore.update(userId, pageId, { linkedRecordingId: recordingId })
    if (!updated) return void res.status(404).json({ error: 'Page not found' })
    res.json({ ok: true })
  })

  // Finalize fallback: assemble the persisted live windows into a usable
  // recording when the lossless full upload cannot complete (offline stop,
  // failed PUT, dead client). The result is honest about its provenance —
  // re-encoded 30s windows with sub-second seams — and the normal
  // estimate → confirm → process flow still runs on it.
  router.post('/live/finalize', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    if (!deps.filesResolver || !deps.filesApi) {
      return void res.status(503).json({ error: 'Storage is not available for live assembly' })
    }
    const { workspaceId, assistantId, sessionId, pageId } = (req.body ?? {}) as {
      workspaceId?: string
      assistantId?: string
      sessionId?: string
      pageId?: string
    }
    if (!workspaceId || !assistantId || !sessionId) {
      return void res.status(400).json({ error: 'workspaceId, assistantId, and sessionId are required' })
    }
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }
    try {
      const rows = (await windows.listBySession(workspaceId, sessionId)).filter((row) => row.audioKey)
      if (rows.length === 0) {
        return void res.status(409).json({ error: 'no_stored_windows' })
      }
      const resolved = await deps.filesResolver.forWorkspace(workspaceId)
      const buffers: Buffer[] = []
      for (const row of rows) {
        const blob = await resolved.gcs.readBlob(row.audioKey!)
        if (!blob) return void res.status(409).json({ error: 'recording_window_audio_missing' })
        buffers.push(blob.bytes)
      }
      if (buffers.length === 0) {
        return void res.status(409).json({ error: 'no_stored_windows' })
      }
      const assembled = await (deps.concatWindows ?? concatAudioWindows)(buffers)

      const fileName = `Assembled meeting recording ${randomUUID()}.m4a`
      const written = await deps.filesApi.writeBytes({ workspaceId, userId }, {
        path: `/recordings/${fileName}`, bytes: assembled.buffer, mime: assembled.mime,
      })
      if (!written.ok) {
        return void res.status(503).json({ error: 'recording_upload_preparation_failed', detail: written.error.kind })
      }
      const recordingId = await adoptRecordingUpload(written.value, userId, workspaceId, 'meeting', deps)

      // Best-effort: link the meeting page, then reclaim the window objects.
      if (pageId) {
        try {
          const view = await deps.savedViewStore.getById(userId, pageId)
          if (view && view.workspaceId === workspaceId) {
            await deps.savedViewStore.update(userId, pageId, { linkedRecordingId: recordingId })
          }
        } catch (error) {
          console.error('[recording-live] finalize page link failed:', error)
        }
      }
      void (async () => {
        for (const row of rows) {
          await resolved.gcs.deleteBlob(row.audioKey!).catch(() => {})
        }
        await windows.clearAudio(workspaceId, sessionId).catch(() => {})
      })()

      const last = rows[rows.length - 1]
      res.status(201).json({
        recordingId,
        windowCount: rows.length,
        coverageMs: last.offsetMs + last.durationMs,
      })
    } catch (error) {
      console.error('[recording-live] finalize failed:', error)
      const message = error instanceof Error ? error.message : String(error)
      res.status(503).json({ error: /(?:ffmpeg|ffprobe).*ENOENT/i.test(message)
        ? 'recording_media_tools_unavailable' : 'recording_upload_preparation_failed' })
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

/** The current notes region as Markdown (the revision prompt's "previous notes"). */
function notesRegionText(page: Page, notesHeadingId: string, markerBlockId: string): string {
  const headingIndex = page.blocks.findIndex((block) => block.id === notesHeadingId)
  const markerIndex = page.blocks.findIndex((block) => block.id === markerBlockId)
  if (headingIndex < 0 || markerIndex < 0 || markerIndex <= headingIndex) return ''
  const region = page.blocks
    .slice(headingIndex + 1, markerIndex)
    .filter((block) => (block as { text?: unknown }).text !== 'Listening for the first update...')
  return blocksToMarkdown(region).trim()
}
