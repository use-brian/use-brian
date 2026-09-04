import { Router, type Request, type Response, type NextFunction } from 'express'
import multer, { MulterError } from 'multer'
import { z } from 'zod'
import { getDefaultAssistant, findAssistantById, getWorkspacePrimaryAssistant } from '../db/users.js'
import { getWorkspaceFileById } from '../db/workspace-files.js'
import { isMediaMime, resolveRecordingForFile } from '../recordings/recording-for-file.js'
import { enqueueFileIngestJob, getFileIngestJob } from '../db/file-ingest-jobs-store.js'
import { findOrCreateSession, findSessionById } from '../db/sessions.js'
import {
  isStructuredDocument,
  documentMimeType,
  documentFormatFromMetadata,
  DOCUMENT_FORMATS,
  parseFileContent,
  shouldInline,
  probePdfPageCount,
  convertToPdfWithLibreOffice,
  LibreOfficeError,
  PDF_CONFIRM_PAGE_THRESHOLD,
  type FileStore,
} from '@use-brian/core'
import { FileIngestError } from '../files/ingest-error.js'
import type { FileIngestor } from '../files/ingest-port.js'
import type { ArtifactPromoter } from '../files/artifact-promote.js'
import { resolveUser } from './route-helpers.js'
import { mintFilePreviewToken, verifyFilePreviewToken } from './file-preview-token.js'
import {
  ChunkedUploadError,
  MAX_CHUNKED_UPLOAD_BYTES,
  type ChunkedFileUploadService,
} from '../files/chunked-upload.js'

/** Silent-path PDFs promote store-only above this (native inlineData stays the read path below). */
const PDF_STORE_ONLY_MIN_BYTES = 2 * 1024 * 1024

const MAX_CACHE_FILE_SIZE = 20 * 1024 * 1024 // 20 MiB — transient chat cache
const MAX_INGEST_FILE_SIZE = 30 * 1024 * 1024 // 30 MiB — 2 MiB below Cloud Run HTTP/1
const MAX_FILES_PER_REQUEST = 10
// Preview capability-URL TTL. The browser fetches the signed `<img src>` /
// download URL promptly after the mint round-trip, so a few minutes is ample
// and bounds the replay window on a leaked URL. See file-preview-token.ts.
const PREVIEW_URL_TTL_MS = 5 * 60_000
// Ingest does a model distill + a Pipeline B pass per file, synchronously, so
// the per-request fan-out is capped tighter than the plain cache upload. A
// background job queue is the documented scale follow-up (files.md).
const MAX_INGEST_FILES = 5

function memoryUpload(maxFileSize: number) {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxFileSize,
      files: MAX_FILES_PER_REQUEST,
    },
  })
}

const cacheUpload = memoryUpload(MAX_CACHE_FILE_SIZE)
const ingestUpload = memoryUpload(MAX_INGEST_FILE_SIZE)

/**
 * Multipart upload allowlist — shared between the transient chat-attachment
 * upload (`/api/files`) and the durable doc-block upload
 * (`packages/api/src/routes/doc-files.ts`). Exported so the two stay in
 * lockstep; widening one without the other is the bug.
 */
export const ALLOWED_MIME_PREFIXES = [
  'text/',
  'image/',
  // Voice-note uploads from the web recorder. Transcription happens
  // just-in-time in `chat.ts` (see docs/architecture/media/transcription.md).
  'audio/',
  'application/json',
]

export function isAllowedMime(mime: string, fileName?: string): boolean {
  const normalized = mime.toLowerCase().split(';', 1)[0]!.trim()
  return (
    ALLOWED_MIME_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    isStructuredDocument(normalized, fileName)
  )
}

/**
 * File upload routes.
 *
 * POST /api/files/upload (multipart, field "files")
 *   - Body field "sessionId" (optional). If absent, file is cached against
 *     a fresh session that the chat endpoint will adopt later.
 *   - Returns: [{ id, fileName, mimeType, sizeBytes, summary }]
 *
 * POST /api/files/ingest (multipart, field "files")
 *   - Body field "workspaceId" (required). The authenticated user must be a
 *     member; the workspace primary is the assistant the write binds to.
 *   - Stores each file's raw bytes in workspace_files AND decomposes its
 *     content into the brain (Pipeline B). Returns per-file results. Present
 *     only when a blob client is configured (`ingestor` passed). See
 *     docs/architecture/features/files.md → "Direct ingest".
 *
 * POST /api/files/store (multipart, field "files")
 *   - Same durable byte write and membership gate as `/ingest`, but does not
 *     parse, distill, index, create an Episode, or run Pipeline B. Used when a
 *     user is staging context before deciding what Brian should do with it.
 *
 * `ingestor` is null on a files-less deploy; the ingest route then 503s.
 */
export function fileRoutes(
  fileStore: FileStore,
  ingestor?: FileIngestor | null,
  /**
   * Silent large-upload promotion (large-content-artifacts §Phase 2.3): a
   * text-extractable file over the inline threshold (or a big PDF, store-only)
   * is ALSO written to workspace_files + chunked into file_segments, and the
   * cache row carries the artifact link so the chat seam renders a manifest.
   * Absent (files-less deploy) -> cache-only, exactly the legacy behavior.
   */
  artifactPromoter?: ArtifactPromoter | null,
  /**
   * HMAC secret for signed preview capability URLs (WS3 #8). When set, the
   * `/preview` GET requires a valid `?sig` and gains an authenticated
   * `/preview-url` mint route; when absent (secret-less test/deploy) the mint
   * route 503s and `/preview` falls back to the legacy unsigned read. Prod
   * always passes `JWT_SECRET`. See file-preview-token.ts.
   */
  previewSecret?: string | null,
  /** Large durable-file lane. Metadata crosses the API; exact parts do not. */
  chunkedUploads?: ChunkedFileUploadService | null,
  /**
   * Office→PDF converter seam for `/:id/preview-pdf` — tests inject a fake so
   * no LibreOffice spawn happens; production uses the ONE LibreOffice runner
   * (`@use-brian/core` `convertToPdfWithLibreOffice`), never a second renderer.
   */
  convertPdf: (bytes: Uint8Array, opts: { inputName: string; tempPrefix?: string }) => Promise<Uint8Array> = convertToPdfWithLibreOffice,
): Router {
  const router = Router()

  router.post('/upload', cacheUpload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? []

    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' })
      return
    }

    try {
      // Resolve user
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.status(401).json({ error: 'User not found' }); return }

      const assistant = await getDefaultAssistant(user.id)
      if (!assistant) {
        res.status(500).json({ error: 'No assistant found' })
        return
      }

      // Resolve session — try requested ID first, else create staging session
      // The frontend may send sessionId from `bodyData` if available.
      const requestedSessionId = (req.body?.sessionId as string | undefined) ?? undefined
      let session
      if (requestedSessionId) {
        session = await findSessionById(requestedSessionId)
      }
      if (!session) {
        // Create a fresh session — the chat endpoint will reuse this if the user
        // sends their first message immediately after upload.
        session = await findOrCreateSession({
          assistantId: assistant.id,
          userId: user.id,
          channelType: 'web',
          channelId: crypto.randomUUID(),
        })
      }

      // Clearance scoping (audit #3, Option B): the cached file is partitioned
      // to the session's workspace and made user-private to the uploader, so a
      // gated read (chat fileIds / readFileContent) from another workspace or
      // another user is filtered out by `buildAccessPredicate`. Default
      // sensitivity 'internal'. Resolve the workspace from the session's
      // assistant (the workspace the read will run in).
      const fileWorkspaceId =
        (await findAssistantById(session.assistantId))?.workspaceId ?? assistant.workspaceId ?? null

      // Parse + cache each file
      const results = []
      for (const file of files) {
        // multer/busboy decodes the multipart filename header as latin1, so a
        // UTF-8 name (e.g. the narrow no-break space macOS puts in
        // "3.46.35 PM.png") arrives mojibaked ("3.46.35â€¯PM.png"). Re-decode
        // latin1→UTF-8 to recover it; a no-op for pure-ASCII names.
        const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8')

        if (!isAllowedMime(file.mimetype, fileName)) {
          results.push({
            error: `Unsupported file type: ${file.mimetype}`,
            fileName,
          })
          continue
        }

        try {
          const { text, summary, mediaMimeType, detectedFormat } = await parseFileContent(
            file.buffer,
            file.mimetype,
            fileName,
          )

          // Inline-media MIME types are stored as data URLs so the raw bytes
          // are available later (images + PDFs → Gemini inline_data; audio →
          // decoded and transcribed in `chat.ts` before Gemini sees it).
          // Text-extractable files store the parsed text.
          const isInlineMedia = mediaMimeType !== undefined
          const effectiveMimeType =
            mediaMimeType ?? (detectedFormat ? documentMimeType(detectedFormat) : file.mimetype)
          const content = isInlineMedia
            ? `data:${effectiveMimeType};base64,${file.buffer.toString('base64')}`
            : text

          // A structured document (docx/pptx/xlsx/csv/…) keeps its ORIGINAL
          // bytes beside the parsed text (migration 487) so `/:id/preview-pdf`
          // can render it later. Deliberately cache-side (7-day TTL) rather
          // than promoted: durable promotion would put every attachment on the
          // workspace storage quota and into brain file listings. `content`
          // stays the parsed text, so the chat `isTextLike` inline branch is
          // untouched.
          const keepOriginalBytes = !isInlineMedia && detectedFormat !== undefined

          const cached = await fileStore.cache({
            sessionId: session.id,
            fileName,
            mimeType: effectiveMimeType,
            content,
            summary,
            sizeBytes: file.size,
            workspaceId: fileWorkspaceId,
            userId: user.id,
            sensitivity: 'internal',
            ...(keepOriginalBytes
              ? { originalContent: `data:${effectiveMimeType};base64,${file.buffer.toString('base64')}` }
              : {}),
          })

          // ── Silent artifact promotion (large-content-artifacts §Phase 2.3) ──
          // Text-extractable + over the inline threshold → durable artifact +
          // segments (retrieval outlives the 7-day cache). Big PDFs promote
          // store-only (chunking a PDF needs a model distill — explicit-ingest
          // territory). Never fails the upload: null → cache-only fallback.
          let artifact: { fileId: string; path: string; indexing: string } | null = null
          const isPdf = effectiveMimeType === 'application/pdf'
          const promotable =
            artifactPromoter &&
            fileWorkspaceId &&
            ((!isInlineMedia && !shouldInline(text)) || (isPdf && file.size > PDF_STORE_ONLY_MIN_BYTES))
          if (promotable) {
            const promoted = await artifactPromoter!({
              fileName,
              mime: file.mimetype,
              bytes: file.buffer,
              parsedText: isPdf ? '' : text,
              summary,
              workspaceId: fileWorkspaceId!,
              actingUserId: user.id,
              assistantId: session.assistantId ?? null,
              storeOnly: isPdf,
            })
            if (promoted) {
              artifact = { fileId: promoted.fileId, path: promoted.path, indexing: promoted.status }
              if (fileStore.linkArtifact) {
                await fileStore
                  .linkArtifact(cached.id, promoted.fileId, promoted.segmentCount)
                  .catch((err) => console.error('[files/upload] artifact link failed:', err))
              }
            }
          }

          // Cheap pre-flight probe (parses structure; no render, no model
          // call) so the client can confirm before a big document is read.
          // See docs/architecture/engine/preflight-confirmation.md — the
          // probe must never be the expensive work it gates.
          const pdfPageCount = isPdf ? await probePdfPageCount(file.buffer) : null

          results.push({
            id: cached.id,
            fileName: cached.fileName,
            mimeType: cached.mimeType,
            sizeBytes: cached.sizeBytes,
            summary,
            inline: shouldInline(text),
            artifact,
            ...(pdfPageCount !== null ? { pdfPageCount } : {}),
            ...(pdfPageCount !== null && pdfPageCount > PDF_CONFIRM_PAGE_THRESHOLD
              ? { needsReadConfirm: true }
              : {}),
            // Send back the parsed text preview so the chat endpoint can inline it
            // without re-fetching (saves a round-trip)
            preview: text.slice(0, 200),
          })
        } catch (err) {
          console.error('File parse failed:', err)
          results.push({
            error: `Failed to parse ${fileName}: ${(err as Error).message}`,
            fileName,
          })
        }
      }

      res.json({
        sessionId: session.id,
        files: results,
      })
    } catch (err) {
      console.error('File upload error:', err)
      res.status(500).json({ error: 'Failed to upload files' })
    }
  })

  const handleDurableUpload = async (
    req: Request,
    res: Response,
    processFile: boolean,
  ) => {
    if (!ingestor) {
      res.status(503).json({ error: 'Durable file storage is not available on this deployment.' })
      return
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' })
      return
    }
    if (files.length > MAX_INGEST_FILES) {
      res.status(400).json({
        error: `Too many files: durable ${processFile ? 'ingest' : 'storage'} accepts at most ${MAX_INGEST_FILES} per request.`,
      })
      return
    }

    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId = typeof req.body?.workspaceId === 'string' ? req.body.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }

    // One query gives both the membership gate (404 hides existence) and the
    // assistant the ingest binds to (the workspace primary, with its clearance
    // + compartments). Mirrors the chat route's workspace-aware routing.
    const assistant = await getWorkspacePrimaryAssistant(userId, workspaceId)
    if (!assistant || !assistant.workspaceId) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const ctx = {
      workspaceId: assistant.workspaceId,
      userId,
      assistantId: assistant.id,
      assistantKind: assistant.kind,
      clearance: assistant.clearance,
      compartments: assistant.compartments,
    }

    // Sequential keeps multipart writes bounded. Both lanes now exit after the
    // byte write: /store stops there, /ingest hands parse/chunk/decompose to
    // the file_ingest_jobs worker rather than running it on the request thread.
    const results = []
    for (const file of files) {
      // Recover a UTF-8 filename mojibaked by multer's latin1 decode (see /upload).
      const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8')
      if (!isAllowedMime(file.mimetype, fileName)) {
        results.push({ fileName, ok: false, error: `Unsupported file type: ${file.mimetype}` })
        continue
      }
      try {
        // `process: false` on BOTH lanes. Semantic work is never inline here —
        // see the route doc on POST /ingest for why the request may not wait.
        const r = await ingestor({
          fileName,
          mime: file.mimetype,
          bytes: file.buffer,
          process: false,
        }, ctx)
        if (!processFile) {
          results.push({
            fileName,
            ok: true,
            fileId: r.fileId,
            path: r.path,
            sizeBytes: r.sizeBytes,
            status: 'stored' as const,
            distilled: r.distilled,
            decomposed: r.decomposed,
            counts: r.counts,
          })
          continue
        }
        // Explicit ingest: the user asked for this file to be interpreted, so
        // the job carries `mode: 'explicit'` and the worker may distill a
        // PDF/image for it (migration 404).
        const { enqueued, jobId } = await enqueueFileIngestJob({
          fileId: r.fileId,
          workspaceId: ctx.workspaceId,
          actingUserId: ctx.userId,
          assistantId: ctx.assistantId,
          sourceLabel: fileName,
          mode: 'explicit',
        })
        results.push({
          fileName,
          ok: true,
          fileId: r.fileId,
          path: r.path,
          sizeBytes: r.sizeBytes,
          // `enqueued: false` means a job for this file is already in flight —
          // the work is happening either way, so this is not a failure.
          status: 'queued' as const,
          jobId,
          ...(enqueued ? {} : { alreadyQueued: true }),
        })
      } catch (err) {
        const message =
          err instanceof FileIngestError && err.kind === 'quota_exceeded'
            ? 'Workspace storage quota exceeded.'
            : err instanceof FileIngestError && err.kind === 'conflict'
              ? 'A file with that name is already in your brain.'
              : `Failed to ${processFile ? 'ingest' : 'store'} ${fileName}: ${(err as Error).message}`
        console.error(`File ${processFile ? 'ingest' : 'storage'} error:`, err)
        results.push({ fileName, ok: false, error: message })
      }
    }

    res.json({ files: results })
  }

  /**
   * POST /api/files/store — store raw bytes only.
   *
   * This is the reversible staging boundary for chat/room context. It returns
   * durable ids but deliberately performs no semantic work.
   */
  router.post('/store', ingestUpload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    await handleDurableUpload(req, res, false)
  })

  const ChunkedStartBody = z.object({
    workspaceId: z.string().min(1),
    fileName: z.string().min(1).max(1024),
    mime: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive().max(MAX_CHUNKED_UPLOAD_BYTES),
  })
  const ChunkedWorkspaceBody = z.object({ workspaceId: z.string().min(1) })

  async function chunkedContext(req: Request, res: Response, workspaceId: string) {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return null
    }
    const assistant = await getWorkspacePrimaryAssistant(userId, workspaceId)
    if (!assistant || !assistant.workspaceId) {
      res.status(404).json({ error: 'Not found' })
      return null
    }
    return {
      workspaceId: assistant.workspaceId,
      userId,
      assistantId: assistant.id,
      assistantKind: assistant.kind,
      clearance: assistant.clearance,
      compartments: assistant.compartments,
    }
  }

  function sendChunkedError(res: Response, err: unknown): void {
    if (!(err instanceof ChunkedUploadError)) {
      console.error('[files/chunked-upload] unexpected error:', err)
      res.status(500).json({ error: 'upload_failed', detail: 'Could not upload this file.' })
      return
    }
    const status =
      err.kind === 'invalid' ? 400
        : err.kind === 'too_large' || err.kind === 'quota_exceeded' ? 413
          : err.kind === 'not_found' ? 404
            : err.kind === 'expired' ? 410
              : 409
    res.status(status).json({ error: err.kind, detail: err.message })
  }

  /** Start a 24-hour direct-to-storage upload and mint exact-part PUT URLs. */
  router.post('/uploads/start', async (req, res) => {
    if (!chunkedUploads) {
      res.status(503).json({ error: 'file_storage_unavailable' })
      return
    }
    const parsed = ChunkedStartBody.safeParse(req.body)
    if (!parsed.success) {
      const tooLarge = typeof req.body?.sizeBytes === 'number' && req.body.sizeBytes > MAX_CHUNKED_UPLOAD_BYTES
      res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'too_large' : 'invalid_upload',
        detail: tooLarge ? 'Each file must be 1 GiB or smaller.' : 'Invalid upload metadata.',
      })
      return
    }
    if (!isAllowedMime(parsed.data.mime, parsed.data.fileName)) {
      res.status(400).json({ error: 'unsupported_file_type', detail: `Unsupported file type: ${parsed.data.mime}` })
      return
    }
    const ctx = await chunkedContext(req, res, parsed.data.workspaceId)
    if (!ctx) return
    try {
      res.status(201).json(await chunkedUploads.start(ctx, parsed.data))
    } catch (err) {
      sendChunkedError(res, err)
    }
  })

  /** Verify exact parts, stream-assemble the final object, and commit its row. */
  router.post('/uploads/:uploadId/complete', async (req, res) => {
    if (!chunkedUploads) {
      res.status(503).json({ error: 'file_storage_unavailable' })
      return
    }
    const parsed = ChunkedWorkspaceBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_upload', detail: 'workspaceId is required.' })
      return
    }
    const ctx = await chunkedContext(req, res, parsed.data.workspaceId)
    if (!ctx) return
    try {
      const file = await chunkedUploads.complete(ctx, req.params.uploadId)
      res.json({
        fileName: file.name,
        ok: true,
        fileId: file.id,
        path: file.path,
        sizeBytes: file.sizeBytes,
        distilled: false,
        decomposed: false,
        counts: { entities: 0, edges: 0, memories: 0, tasks: 0 },
      })
    } catch (err) {
      sendChunkedError(res, err)
    }
  })

  /** Abort an incomplete upload and delete any staged part objects. */
  router.delete('/uploads/:uploadId', async (req, res) => {
    if (!chunkedUploads) {
      res.status(503).json({ error: 'file_storage_unavailable' })
      return
    }
    const parsed = ChunkedWorkspaceBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_upload', detail: 'workspaceId is required.' })
      return
    }
    const ctx = await chunkedContext(req, res, parsed.data.workspaceId)
    if (!ctx) return
    try {
      await chunkedUploads.abort(ctx, req.params.uploadId)
      res.status(204).end()
    } catch (err) {
      sendChunkedError(res, err)
    }
  })

  /**
   * POST /api/files/ingest — store raw bytes, then QUEUE the brain ingest.
   *
   * Multipart field "files"; body field "workspaceId" (required). Deterministic
   * (no chat turn): each file's bytes land in workspace_files synchronously and
   * a `file_ingest_jobs` row carries parse -> chunk -> Pipeline B to the worker.
   * Per-file results carry `status: 'queued'` + `jobId`; poll
   * `GET /api/files/ingest-jobs/:jobId` for the outcome.
   *
   * WHY THIS IS NOT SYNCHRONOUS. It used to be, and the request took as long as
   * decomposition did: a 4 MB HTML document billed 47 extraction windows and
   * held the connection 185 s. `api.usebrian.ai` is fronted by Cloudflare, whose
   * origin-response timeout is 100 s, so the browser got a 524 while Cloud Run
   * ran happily to completion and logged 200. The user saw "Failed" for files
   * that were fully ingested, retried, and hit the path-UNIQUE conflict — the
   * worst available shape, because the recovery action was the one that could
   * not work. Semantic work is unbounded by nature; an HTTP request behind a
   * CDN is not. Keep the two apart: anything model-priced belongs on the queue.
   */
  router.post('/ingest', ingestUpload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    await handleDurableUpload(req, res, true)
  })

  /**
   * GET /api/files/ingest-jobs/:jobId — poll one queued ingest.
   *
   * The completion signal for POST /ingest: the upload answers `queued`, the UI
   * polls here until `done` / `failed` rather than guessing. Membership-gated
   * through the job's own workspace (404 hides existence), so a bare job id from
   * another workspace reveals nothing.
   */
  router.get('/ingest-jobs/:jobId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const job = await getFileIngestJob(req.params.jobId)
    if (!job) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const assistant = await getWorkspacePrimaryAssistant(userId, job.workspaceId)
    if (!assistant || !assistant.workspaceId) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    res.json({
      jobId: job.id,
      fileId: job.fileId,
      status: job.status,
      ...(job.status === 'failed' && job.lastError ? { error: job.lastError } : {}),
    })
  })

  /**
   * POST /api/files/:fileId/ingest — deterministic (re-)ingestion of a file
   * ALREADY stored in workspace_files (file-artifacts.md §"Re-ingest").
   * Enqueues the same parse → chunk → Pipeline B routine the async worker runs
   * for every boundary, so coverage, provenance, metering, and failure
   * surfacing match a fresh ingest. Body: { workspaceId, confirm? }.
   *
   * Double-ingestion guard: a file that already produced an episode
   * (source_episode_id set) answers 409 { requiresConfirmation: true, … }
   * until the caller re-sends with confirm: true — re-ingesting spends model
   * credits and can duplicate extracted memories, so it is never silent. An
   * in-flight job answers 409 { error: 'ingest_in_flight' } (queue-level
   * idempotency; nothing new was started).
   */
  router.post('/:fileId/ingest', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const body = (req.body ?? {}) as { workspaceId?: string; confirm?: boolean }
    if (!body.workspaceId || typeof body.workspaceId !== 'string') {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }

    // Same gate + actor as POST /ingest: membership via the workspace primary
    // (404 hides existence), which is also the assistant the episode binds to.
    const assistant = await getWorkspacePrimaryAssistant(userId, body.workspaceId)
    if (!assistant || !assistant.workspaceId) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const file = await getWorkspaceFileById(
      {
        workspaceId: assistant.workspaceId,
        userId,
        assistantId: assistant.id,
        assistantKind: assistant.kind,
        clearance: assistant.clearance,
        compartments: assistant.compartments,
      },
      req.params.fileId,
    )
    if (!file) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (isMediaMime(file.mime)) {
      // Still refused here — media is transcribed, not parsed — but the answer
      // now names the lane that CAN do it. A client that reaches this without
      // checking the mime first can follow `handoff` rather than dead-ending on
      // a red line, which is exactly what the brain drawer used to do.
      res.status(400).json({
        error: 'media_owned_by_recordings',
        handoff: { kind: 'recording', route: `/api/files/${file.id}/recording` },
        detail:
          'Audio and video are transcribed through the recording pipeline, not file ingest. ' +
          `Resolve the recording with POST /api/files/${file.id}/recording, then run the ` +
          'recording estimate → confirm → process flow.',
      })
      return
    }

    if (file.sourceEpisodeId && body.confirm !== true) {
      res.status(409).json({
        requiresConfirmation: true,
        reason: 'already_ingested',
        fileId: file.id,
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        detail:
          'This file was already ingested. Re-ingesting runs knowledge extraction again (model cost) and may duplicate extracted memories. Re-send with confirm: true to proceed.',
      })
      return
    }

    const { enqueued, jobId } = await enqueueFileIngestJob({
      fileId: file.id,
      workspaceId: assistant.workspaceId,
      actingUserId: userId,
      assistantId: assistant.id,
      sourceLabel: file.sourceEpisodeId ? 'reingest' : 'upload',
      // User-initiated, so the worker may distill a PDF/image for it — the same
      // coverage a fresh POST /ingest gets (migration 404).
      mode: 'explicit',
    })
    if (!enqueued) {
      res.status(409).json({ error: 'ingest_in_flight', detail: 'An ingest for this file is already running.' })
      return
    }
    res.status(202).json({ fileId: file.id, status: 'queued', jobId })
  })

  /**
   * POST /api/files/:fileId/recording — the media half of "Re-ingest to brain".
   *
   * Answers WHICH recording owns this stored audio/video, adopting one when the
   * file has never had a recording. Body: { workspaceId }. Answers
   * `200 { recordingId, adopted, alreadyProcessed }` - the last so the caller's
   * single confirmation can carry the duplicate-memory warning alongside the
   * cost, instead of discovering it as a 409 after the user already agreed.
   *
   * This route starts nothing and spends nothing: it neither probes the audio
   * nor enqueues a job. The caller continues through the ordinary recording
   * flow — `POST /api/recordings/:id/estimate` for the server-authoritative
   * duration and surcharge, the cost + blueprint confirmation, then
   * `POST /api/recordings/:id/process`. Keeping the enqueue out of here is what
   * preserves the pre-flight-confirmation invariant: a click that resolves a
   * recording must not also be a click that buys a transcription.
   *
   * Same gate and actor as `/:fileId/ingest`, so an invisible file 404s
   * identically. Non-media is refused (`not_media`) rather than adopted — a PDF
   * has no audio to transcribe and belongs on the ingest lane next door.
   *
   * Spec: docs/architecture/brain/file-artifacts.md → "Re-ingest", and
   * docs/architecture/media/transcription.md → "Re-processing".
   */
  router.post('/:fileId/recording', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const body = (req.body ?? {}) as { workspaceId?: string }
    if (!body.workspaceId || typeof body.workspaceId !== 'string') {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }

    const assistant = await getWorkspacePrimaryAssistant(userId, body.workspaceId)
    if (!assistant || !assistant.workspaceId) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const file = await getWorkspaceFileById(
      {
        workspaceId: assistant.workspaceId,
        userId,
        assistantId: assistant.id,
        assistantKind: assistant.kind,
        clearance: assistant.clearance,
        compartments: assistant.compartments,
      },
      req.params.fileId,
    )
    if (!file) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    if (!isMediaMime(file.mime)) {
      res.status(400).json({
        error: 'not_media',
        detail: 'Only audio and video files are handled by the recording pipeline.',
      })
      return
    }

    const resolved = await resolveRecordingForFile(file, userId)
    if (resolved.status === 'refused') {
      res.status(409).json({
        error: 'compartmented_media',
        detail:
          'This file is restricted to a compartment, and recordings do not carry compartments yet, ' +
          'so transcribing it here would widen who can read it.',
      })
      return
    }
    res.json({
      recordingId: resolved.recordingId,
      adopted: resolved.adopted,
      alreadyProcessed: resolved.alreadyProcessed,
    })
  })

  /**
   * GET /api/files/:id/preview-url?workspaceId=… — mint a short-lived signed
   * preview URL (WS3 #8). AUTHENTICATED + access-scoped: the caller must be
   * able to read the `file_cache` row through the universal access predicate
   * (`fileStore.get(id, ctx)`), so a bare id from another user/workspace mints
   * nothing (404, existence-hiding). Returns `{ url }` — a relative
   * `/api/files/:id/preview?sig=…` the browser uses cross-origin as `<img src>`
   * without needing the SameSite=Lax cookie.
   *
   * This is the mint half; the `/preview` GET below is the (unauthenticated)
   * verify half. Requires `previewSecret`; 503s without it.
   */
  const PreviewUrlQuery = z.object({ workspaceId: z.string().min(1) })
  router.get('/:id/preview-url', async (req, res) => {
    if (!previewSecret) {
      res.status(503).json({ error: 'Signed preview URLs are not available on this deployment.' })
      return
    }
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const parsed = PreviewUrlQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }

    // Access gate: mirror the chat/skill-draft `file_cache` read ctx
    // (skills.ts "Gate each client-supplied fileId by the turn's identity").
    // A non-assistant caller echoes its userId into assistantId so
    // workspace-shared rows (assistant_id IS NULL) still match; the
    // workspace + user visibility axes are the real gate. `fileStore.get`
    // with a ctx runs the access-predicate branch, so a foreign-workspace or
    // foreign-user id returns null → 404.
    const ctx = {
      workspaceId: parsed.data.workspaceId,
      userId,
      assistantId: userId,
      assistantKind: 'standard' as const,
    }
    let file
    try {
      file = await fileStore.get(req.params.id, ctx)
    } catch (err) {
      console.error('File preview-url mint error:', err)
      res.status(500).json({ error: 'Failed to mint preview URL' })
      return
    }
    if (!file) {
      res.status(404).json({ error: 'File not found or expired' })
      return
    }

    const token = mintFilePreviewToken({
      fid: file.id,
      ttlMs: PREVIEW_URL_TTL_MS,
      secret: previewSecret,
    })
    res.json({
      url: `/api/files/${encodeURIComponent(file.id)}/preview?sig=${encodeURIComponent(token)}`,
      expiresInMs: PREVIEW_URL_TTL_MS,
    })
  })

  /**
   * GET /api/files/:id/preview?sig=… — serve a previously cached file.
   * For images: streams the image bytes inline so <img src="..."> works.
   * For other files: returns JSON metadata.
   *
   * UNAUTHENTICATED but signature-gated (WS3 #8): mounted `optionalAuth`, so
   * this used to be a bare-UUID IDOR (any holder of a live `file_cache` id got
   * the bytes). It now requires a valid `?sig` minted by `/preview-url` for an
   * authorized viewer — id-bound, short-TTL, HMAC-signed, constant-time
   * verified. No cookie is needed (that's the point — the cross-origin `<img>`
   * can't send the SameSite=Lax cookie). When no `previewSecret` is configured
   * the check is skipped (legacy unsigned behavior for secret-less deploys).
   */
  const PreviewSigQuery = z.object({ sig: z.string().min(1).optional() })
  router.get('/:id/preview', async (req, res) => {
    try {
      if (previewSecret) {
        const parsed = PreviewSigQuery.safeParse(req.query)
        const sig = parsed.success ? parsed.data.sig : undefined
        if (!sig) {
          res.status(401).json({ error: 'Missing preview signature' })
          return
        }
        const verified = verifyFilePreviewToken({
          token: sig,
          fid: req.params.id,
          secret: previewSecret,
        })
        if (!verified.ok) {
          // 403 (not 404) — the id may be valid; it's the capability that's
          // rejected. Reason stays server-side (never leak which check failed).
          res.status(403).json({ error: 'Invalid or expired preview signature' })
          return
        }
      }

      const file = await fileStore.get(req.params.id)
      if (!file) {
        res.status(404).json({ error: 'File not found or expired' })
        return
      }

      if (file.mimeType.startsWith('image/')) {
        // Image content is stored as a "data:mime;base64,<data>" URL string.
        // Decode and stream the raw bytes so browsers can use it as <img src>.
        const match = file.content.match(/^data:[^;]+;base64,(.+)$/)
        const base64 = match ? match[1] : file.content
        try {
          const buffer = Buffer.from(base64, 'base64')
          res.setHeader('Content-Type', file.mimeType)
          res.setHeader('Cache-Control', 'private, max-age=3600')
          res.setHeader('Content-Length', String(buffer.length))
          res.send(buffer)
        } catch {
          res.status(500).json({ error: 'Failed to decode image' })
        }
        return
      }

      // Non-image: return metadata only (the preview card will show a generic icon)
      res.json({
        id: file.id,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      })
    } catch (err) {
      console.error('File preview error:', err)
      res.status(500).json({ error: 'Failed to load file' })
    }
  })

  /**
   * GET /api/files/:id/preview-pdf?workspaceId=… — render a cached upload as
   * a PDF for in-app preview. AUTHENTICATED + access-scoped exactly like
   * `/preview-url` (fileStore.get with the caller's ctx; foreign ids 404,
   * existence-hiding). Two source shapes:
   *
   *  - `application/pdf` whose bytes are inline in `content` → streamed as-is.
   *  - A structured document (docx/pptx/xlsx/csv/doc/odt/…) whose original
   *    bytes were kept in `original_content` (migration 487) → converted
   *    through the ONE LibreOffice runner and streamed.
   *
   * A row with no client-servable bytes (store-only big PDF, legacy row from
   * before 487, or a lapsed cache row) answers 404 `preview_source_unavailable`
   * — the client renders honest "expired/unavailable" copy, never a spinner.
   * Conversion failures follow the views-export precedent: timeout → 504,
   * everything else → 503 `pdf_unavailable`. `Cache-Control: private` lets the
   * browser cache the rendered PDF so repeat opens skip the conversion.
   */
  const PreviewPdfQuery = z.object({ workspaceId: z.string().min(1) })
  router.get('/:id/preview-pdf', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const parsed = PreviewPdfQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'workspaceId is required' })
      return
    }
    // Same ctx shape as `/preview-url`: echo userId into assistantId so
    // workspace-shared rows (assistant_id IS NULL) still match.
    const ctx = {
      workspaceId: parsed.data.workspaceId,
      userId,
      assistantId: userId,
      assistantKind: 'standard' as const,
    }

    const sendPdf = (bytes: Uint8Array) => {
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', 'inline')
      res.setHeader('Cache-Control', 'private, max-age=3600')
      res.setHeader('Content-Length', String(bytes.length))
      res.send(Buffer.from(bytes))
    }

    try {
      const file = await fileStore.get(req.params.id, ctx)
      if (!file) {
        res.status(404).json({ error: 'File not found or expired' })
        return
      }

      // Already a PDF: the inline bytes (≤ the store-only threshold) stream
      // without conversion. Store-only rows keep no inline bytes → 404 below.
      if (file.mimeType === 'application/pdf') {
        const m = file.content.match(/^data:[^;]+;base64,(.+)$/)
        if (m) {
          sendPdf(Buffer.from(m[1]!, 'base64'))
          return
        }
        res.status(404).json({ error: 'Preview source unavailable', code: 'preview_source_unavailable' })
        return
      }

      const format = documentFormatFromMetadata(file.mimeType, file.fileName)
      if (!format || format === 'pdf') {
        res.status(415).json({ error: 'This file type has no PDF preview', code: 'preview_unsupported' })
        return
      }

      const original = await fileStore.getOriginalContent?.(req.params.id, ctx)
      const m = original?.match(/^data:[^;]+;base64,(.+)$/)
      if (!m) {
        res.status(404).json({ error: 'Preview source unavailable', code: 'preview_source_unavailable' })
        return
      }

      // The runner sniffs the format from the input file's extension alone —
      // use the format's canonical extension, never the (user-controlled)
      // upload filename.
      const ext = DOCUMENT_FORMATS[format].extensions[0]!
      const pdf = await convertPdf(Buffer.from(m[1]!, 'base64'), {
        inputName: `attachment.${ext}`,
        tempPrefix: 'brian-attachment-pdf-',
      })
      sendPdf(pdf)
    } catch (err) {
      if (err instanceof LibreOfficeError) {
        // Own-sentence errors only; the vendor text stays server-side (cause).
        const status = err.code === 'timeout' ? 504 : 503
        res.status(status).json({ error: 'PDF preview could not be generated', code: 'pdf_unavailable' })
        return
      }
      console.error('File preview-pdf error:', err)
      res.status(500).json({ error: 'Failed to render preview' })
    }
  })

  // Map multer limit rejections to a clear 413 instead of the generic 500 a
  // thrown MulterError would otherwise surface. The web client guards before
  // POST (`use-file-attachments.ts` → `partitionUpload`), so this is
  // defense-in-depth for direct API callers. Cache uploads remain at 20 MiB;
  // durable ingest has 30 MiB of usable room below Cloud Run's 32 MiB edge
  // cap. See
  // docs/architecture/features/files.md → "Upload limits".
  router.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxFileSize = req.path === '/ingest' || req.path === '/store'
          ? MAX_INGEST_FILE_SIZE
          : MAX_CACHE_FILE_SIZE
        res.status(413).json({
          error: 'file_too_large',
          detail: `Each file must be ${maxFileSize / (1024 * 1024)} MB or smaller.`,
        })
        return
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        res.status(413).json({
          error: 'too_many_files',
          detail: `Attach at most ${MAX_FILES_PER_REQUEST} files per upload.`,
        })
        return
      }
      res.status(400).json({ error: 'upload_rejected', detail: err.message })
      return
    }
    next(err)
  })

  return router
}
