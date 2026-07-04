import { Router } from 'express'
import multer from 'multer'
import { getDefaultAssistant, findAssistantById, getWorkspacePrimaryAssistant } from '../db/users.js'
import { findOrCreateSession, findSessionById } from '../db/sessions.js'
import { parseFileContent, shouldInline, type FileStore } from '@sidanclaw/core'
import { FileIngestError } from '../files/ingest-error.js'
import type { FileIngestor } from '../files/ingest-port.js'
import { resolveUser } from './route-helpers.js'

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20 MB
const MAX_FILES_PER_REQUEST = 10
// Ingest does a model distill + a Pipeline B pass per file, synchronously, so
// the per-request fan-out is capped tighter than the plain cache upload. A
// background job queue is the documented scale follow-up (files.md).
const MAX_INGEST_FILES = 5

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES_PER_REQUEST,
  },
})

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
  'application/pdf',
  'application/json',
  'application/vnd.openxmlformats-officedocument',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))
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
 * `ingestor` is null on a files-less deploy; the ingest route then 503s.
 */
export function fileRoutes(fileStore: FileStore, ingestor?: FileIngestor | null): Router {
  const router = Router()

  router.post('/upload', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
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

        if (!isAllowedMime(file.mimetype)) {
          results.push({
            error: `Unsupported file type: ${file.mimetype}`,
            fileName,
          })
          continue
        }

        try {
          const { text, summary } = await parseFileContent(
            file.buffer,
            file.mimetype,
            fileName,
          )

          // Inline-media MIME types are stored as data URLs so the raw bytes
          // are available later (images + PDFs → Gemini inline_data; audio →
          // decoded and transcribed in `chat.ts` before Gemini sees it).
          // Text-extractable files store the parsed text.
          const isInlineMedia =
            file.mimetype.startsWith('image/') ||
            file.mimetype.startsWith('audio/') ||
            file.mimetype === 'application/pdf'
          const content = isInlineMedia
            ? `data:${file.mimetype};base64,${file.buffer.toString('base64')}`
            : text

          const cached = await fileStore.cache({
            sessionId: session.id,
            fileName,
            mimeType: file.mimetype,
            content,
            summary,
            sizeBytes: file.size,
            workspaceId: fileWorkspaceId,
            userId: user.id,
            sensitivity: 'internal',
          })

          results.push({
            id: cached.id,
            fileName: cached.fileName,
            mimeType: cached.mimeType,
            sizeBytes: cached.sizeBytes,
            summary,
            inline: shouldInline(text),
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

  /**
   * POST /api/files/ingest — store raw bytes + decompose content into the brain.
   *
   * Multipart field "files"; body field "workspaceId" (required). Deterministic
   * (no chat turn): each file's bytes land in workspace_files AND its content is
   * distilled/parsed to text and run through Pipeline B. Per-file results.
   */
  router.post('/ingest', upload.array('files', MAX_FILES_PER_REQUEST), async (req, res) => {
    if (!ingestor) {
      res.status(503).json({ error: 'File ingest is not available on this deployment.' })
      return
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (files.length === 0) {
      res.status(400).json({ error: 'No files provided' })
      return
    }
    if (files.length > MAX_INGEST_FILES) {
      res.status(400).json({ error: `Too many files: ingest accepts at most ${MAX_INGEST_FILES} per request.` })
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

    // Sequential — each file does a model distill + a Pipeline B pass, so we
    // bound concurrent model calls rather than fanning out per file.
    const results = []
    for (const file of files) {
      // Recover a UTF-8 filename mojibaked by multer's latin1 decode (see /upload).
      const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8')
      if (!isAllowedMime(file.mimetype)) {
        results.push({ fileName, ok: false, error: `Unsupported file type: ${file.mimetype}` })
        continue
      }
      try {
        const r = await ingestor({ fileName, mime: file.mimetype, bytes: file.buffer }, ctx)
        results.push({
          fileName,
          ok: true,
          fileId: r.fileId,
          path: r.path,
          sizeBytes: r.sizeBytes,
          distilled: r.distilled,
          decomposed: r.decomposed,
          counts: r.counts,
        })
      } catch (err) {
        const message =
          err instanceof FileIngestError && err.kind === 'quota_exceeded'
            ? 'Workspace storage quota exceeded.'
            : err instanceof FileIngestError && err.kind === 'conflict'
              ? 'A file with that name is already in your brain.'
              : `Failed to ingest ${fileName}: ${(err as Error).message}`
        console.error('File ingest error:', err)
        results.push({ fileName, ok: false, error: message })
      }
    }

    res.json({ files: results })
  })

  /**
   * GET /api/files/:id/preview — serve a previously cached file.
   * For images: streams the image bytes inline so <img src="..."> works.
   * For other files: returns JSON metadata.
   */
  router.get('/:id/preview', async (req, res) => {
    try {
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

  return router
}
