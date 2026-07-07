import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import {
  applyExplicitCloses,
  applyExplicitLinks,
  explicitClosesField,
  explicitLinksField,
  formatClosesSummary,
  formatLinksSummary,
  type EntityLinksStore,
} from '../entities/index.js'
import type { FilesApi } from './api.js'
import {
  FILE_SENSITIVITIES,
  workspaceFileStatus,
  type FileSensitivity,
  type WorkspaceFile,
  type WorkspaceFileIndexRow,
  type WorkspaceFileMetaPatch,
  type WorkspaceFileRowStatus,
} from './types.js'
import type { CachedFile } from '../files/types.js'
import type { AccessContext } from '../security/access-context.js'
import { createSendFileTool } from './send-file.js'
import { ctxFor, errorMessage, idOrPathShape, workspaceGate } from './tool-helpers.js'

/**
 * Nine chat tools for the workspace filesystem primitive
 * (company-brain §10, Q3 Phase A): fileWrite, fileAppend, fileRead,
 * fileSearch, fileSetMeta, fileDelete, saveFileToBrain, saveFileBytes,
 * plus the outbound sendFile (built in `send-file.ts`). See
 * docs/architecture/features/files.md.
 *
 * `saveFileBytes` is the byte-preserving sibling of `fileWrite`: the caller
 * provides raw bytes as base64 (not a cache id like saveFileToBrain, not
 * UTF-8 text like fileWrite), so a programmatic caller that holds a file's
 * bytes can persist the real binary. It is the one file tool that lets bytes
 * cross a tool-call boundary; the size cap below is the guard.
 *
 * Capability: every tool carries `requiresCapability: 'files'` so the
 * §17 grant column gates them at `filterToolsByCapabilities` time. The
 * `OFFICIAL_CONNECTOR_TOOLS.files` row in `packages/shared/src/builtin-
 * connectors.ts` is for governance display (Settings ▸ Connectors,
 * Assistant ▸ Tools) — it does NOT drive runtime injection here.
 *
 * Workspace gate: every tool returns an isError result when
 * `ctx.workspaceId` is absent. Files require a workspace by definition;
 * the §9 collapse migration guarantees every signed-in user has at
 * least a Personal workspace.
 */

export type FileToolEvent =
  | { type: 'file_created'; fileId: string; path: string; sizeBytes: number }
  | { type: 'file_appended'; fileId: string; path: string; sizeBytes: number }
  | { type: 'file_meta_updated'; fileId: string; path: string; fields: string[] }
  | { type: 'file_deleted'; fileId: string; path: string }
  | { type: 'file_searched'; resultCount: number; query?: string }

export type FileToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

export type FileToolOptions = {
  /** Receives every primitive event with the originating tool context. Wire to AnalyticsLogger at boot. */
  onEvent?: (event: FileToolEvent, ctx: FileToolEventContext) => void
  /**
   * Edge store for writing `links` rows alongside the file. Files
   * link as `sourceKind: 'file'` to entities — most useful with
   * `documented_by` (file documents an entity) or `mentioned` (file
   * references an entity).
   */
  entityLinks?: EntityLinksStore
  /**
   * Reader for the transient upload cache (`file_cache`). When wired, the
   * `saveFileToBrain` tool can promote an uploaded attachment (by its
   * `file_cache` id) into the permanent workspace file primitive, preserving
   * the original bytes. Wire to `fileStore.get` at boot. The `ctx` gates the
   * read through the universal access predicate so a model can't promote
   * another workspace/user's cached upload by id (audit #3).
   */
  readCachedFile?: (id: string, ctx: AccessContext) => Promise<CachedFile | null>
}

const SENSITIVITY_VALUES = [...FILE_SENSITIVITIES] as [FileSensitivity, ...FileSensitivity[]]
const sensitivityEnum = z.enum(SENSITIVITY_VALUES)

const idShape = z.string().uuid()
const tagShape = z.array(z.string().min(1).max(64)).max(20)

/**
 * Hard ceiling on the base64 payload `saveFileBytes` accepts, checked BEFORE
 * decode. Unlike the multipart upload route (`POST /api/files/upload`, capped
 * by multer), a tool-call argument has no body limit, so this is the guard
 * against a giant JSON arg blowing up memory ahead of the workspace quota. At
 * ~14M base64 chars ≈ 10 MB decoded — larger files belong on the upload route.
 */
const MAX_SAVE_FILE_BYTES_BASE64 = 14_000_000

// workspaceGate / ctxFor / errorMessage / idOrPathShape live in
// `tool-helpers.ts` — shared with `send-file.ts` (which this module
// constructs, so it can't be imported back from here).

function eventCtx(context: { userId: string; assistantId: string; sessionId: string; channelType: string }): FileToolEventContext {
  return {
    userId: context.userId,
    assistantId: context.assistantId,
    sessionId: context.sessionId,
    channelType: context.channelType,
  }
}

function compactFile(row: WorkspaceFileIndexRow): {
  id: string
  path: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  size_bytes: number
  tags: string[]
  sensitivity: FileSensitivity
  updated_at: string
} {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    size_bytes: row.sizeBytes,
    tags: row.tags,
    sensitivity: row.sensitivity,
    updated_at: row.updatedAt.toISOString(),
  }
}

function fullFile(row: WorkspaceFile): {
  id: string
  path: string
  parent_path: string
  name: string
  title: string | null
  summary: string | null
  mime: string
  size_bytes: number
  tags: string[]
  related_ids: string[]
  sensitivity: FileSensitivity
  metadata: Record<string, unknown>
  status: WorkspaceFileRowStatus
  valid_from: string
  valid_to: string | null
  superseded_by: string | null
  created_by_user_id: string | null
  created_by_assistant_id: string | null
  created_at: string
  updated_at: string
} {
  return {
    id: row.id,
    path: row.path,
    parent_path: row.parentPath,
    name: row.name,
    title: row.title,
    summary: row.summary,
    mime: row.mime,
    size_bytes: row.sizeBytes,
    tags: row.tags,
    related_ids: row.relatedIds,
    sensitivity: row.sensitivity,
    metadata: row.metadata,
    status: workspaceFileStatus(row),
    valid_from: row.validFrom.toISOString(),
    valid_to: row.validTo ? row.validTo.toISOString() : null,
    superseded_by: row.supersededBy,
    created_by_user_id: row.createdByUserId,
    created_by_assistant_id: row.createdByAssistantId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export function createFileTools(
  api: FilesApi,
  opts?: FileToolOptions,
): {
  fileWrite: Tool
  fileAppend: Tool
  fileRead: Tool
  fileSearch: Tool
  fileSetMeta: Tool
  fileDelete: Tool
  saveFileToBrain: Tool
  saveFileBytes: Tool
  sendFile: Tool
} {
  const fileWrite = buildTool({
    name: 'fileWrite',
    requiresCapability: 'files',
    requiresConfirmation: true,
    description:
      'Create or overwrite a workspace file. Files are workspace-shared — every workspace member can read them. Use for shared artifacts (drafts, notes, reports), not personal scratch (use saveMemory). ' +
'Use this to author NEW text content (you provide the body). To save an UPLOADED file the user attached (an image, PDF, document), use saveFileToBrain instead — it preserves the original bytes; fileWrite would only store text. ' +
      'Path is required and must be unique in the workspace; an overwrite of an existing path returns a conflict error — pass the existing id to fileSetMeta or call fileDelete first. ' +
      'Title and summary are optional but improve discovery — they appear in the # Workspace Files L1 block. The agent should call fileSetMeta later if it learns enough to label a file it wrote without one. ' +
      'Iterating documents (drafts) tag with `draft` while in progress; substantive content edits supersede via the draft-approval flow (not via this tool). To lock in a draft, call fileSetMeta to remove the `draft` tag and optionally add `final` or `final:<commit_sha>`.',
    inputSchema: z.object({
      path: z.string().min(1).max(1024).describe('Workspace-relative path, e.g. "/reports/2026-Q1/recap.md". Forward slashes; leading slash optional.'),
      content: z.string().describe('Full file content. Plain text; agents that need binary should defer to user-driven uploads.'),
      mime: z.string().min(1).max(128).optional().describe('Defaults to inferred-from-extension or text/plain.'),
      title: z.string().min(1).max(256).optional().describe('Display label for L1 surface and search. Distinct from filename.'),
      summary: z.string().min(1).max(512).optional().describe('One-line description visible in the L1 # Workspace Files block.'),
      tags: tagShape.optional(),
      sensitivity: sensitivityEnum.optional().describe('Defaults to internal. public is visible to all workspace members; confidential is reserved for high-sensitivity material.'),
      links: explicitLinksField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const result = await api.write(ctxFor(context), {
        path: input.path,
        content: input.content,
        mime: input.mime,
        title: input.title,
        summary: input.summary,
        tags: input.tags,
        sensitivity: input.sensitivity,
      })
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      const file = result.value
      opts?.onEvent?.(
        { type: 'file_created', fileId: file.id, path: file.path, sizeBytes: file.sizeBytes },
        eventCtx(context),
      )
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'file',
        sourceId: file.id,
        source: 'user',
        links: input.links,
      })
      return {
        data: `Saved ${file.path} (${file.sizeBytes} bytes, ${file.mime}). id=${file.id}${formatLinksSummary(linksSummary)}`,
      }
    },
  })

  const fileAppend = buildTool({
    name: 'fileAppend',
    requiresCapability: 'files',
    requiresConfirmation: true,
    description:
      'Append content to an existing workspace file. Useful for journal-style logs and incremental writes. The append is read-modify-write; concurrent appends are best-effort. Returns the file with its new size.',
    inputSchema: z.object({
      file: idOrPathShape.describe('UUID or absolute workspace path of the file.'),
      content: z.string().describe('Content to append. Caller should include any newline separators.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const result = await api.append(ctxFor(context), input.file, input.content)
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      const file = result.value
      opts?.onEvent?.(
        { type: 'file_appended', fileId: file.id, path: file.path, sizeBytes: file.sizeBytes },
        eventCtx(context),
      )
      return { data: `Appended to ${file.path} (now ${file.sizeBytes} bytes). id=${file.id}` }
    },
  })

  const fileRead = buildTool({
    name: 'fileRead',
    requiresCapability: 'files',
    isConcurrencySafe: true,
    isReadOnly: true,
    description:
      'Read a workspace file by id or path. Returns full content plus metadata. Use this when the # Workspace Files L1 block hint is insufficient — the block only shows path/title/summary/mime, not content.',
    inputSchema: z.object({
      file: idOrPathShape.describe('UUID or absolute workspace path of the file.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const result = await api.read(ctxFor(context), input.file)
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      return {
        data: {
          file: fullFile(result.value.file),
          content: result.value.content,
        },
      }
    },
  })

  const fileSearch = buildTool({
    name: 'fileSearch',
    requiresCapability: 'files',
    isConcurrencySafe: true,
    isReadOnly: true,
    description:
      'Search workspace files by title / summary / tags / name. Returns a compact projection (id, path, name, title, summary, mime, size_bytes, tags, sensitivity, updated_at). For full content use fileRead. ' +
      'Optional: `tag` filters to files with that exact tag; `parent_path` scopes to a folder. Default limit 25 (max 100).',
    inputSchema: z.object({
      query: z.string().min(1).max(512).optional().describe('Free-text search across title, summary, tags, and name. Omit to list all files in the (optional) parent_path / tag scope.'),
      tag: z.string().min(1).max(64).optional().describe('Exact-match tag filter.'),
      parent_path: z.string().min(1).max(1024).optional().describe('Restrict search to a folder, e.g. "/reports/2026-Q1".'),
      limit: z.number().int().min(1).max(100).optional().default(25),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rows = await api.search(ctxFor(context), {
        query: input.query,
        tag: input.tag,
        parentPath: input.parent_path,
        limit: input.limit,
      })
      opts?.onEvent?.(
        { type: 'file_searched', resultCount: rows.length, query: input.query },
        eventCtx(context),
      )
      return { data: rows.map(compactFile) }
    },
  })

  const fileSetMeta = buildTool({
    name: 'fileSetMeta',
    requiresCapability: 'files',
    requiresConfirmation: true,
    description:
      'Update metadata on an existing file: title, summary, tags, related_ids, sensitivity. Path / name / content are not editable here — to rename, fileDelete + fileWrite at the new path. Use this opportunistically when you read or write a file and learn enough to label it well. ' +
      'For the draft lifecycle: to lock in a draft, remove the `draft` tag and optionally add `final` (or `final:<commit_sha>`) — tag-only edits stay in-place. Substantive content edits route through the draft-approval flow, not this tool.',
    inputSchema: z.object({
      file: idOrPathShape.describe('UUID or absolute workspace path of the file.'),
      title: z.string().min(1).max(256).nullable().optional().describe('Pass null to clear, omit to leave unchanged.'),
      summary: z.string().min(1).max(512).nullable().optional().describe('Pass null to clear, omit to leave unchanged.'),
      tags: tagShape.optional(),
      related_ids: z.array(idShape).max(50).optional().describe('UUIDs of other workspace_files this file links to.'),
      sensitivity: sensitivityEnum.optional(),
      links: explicitLinksField,
      closeLinks: explicitClosesField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const patch: WorkspaceFileMetaPatch = {}
      const fields: string[] = []
      if (input.title !== undefined)        { patch.title = input.title;            fields.push('title') }
      if (input.summary !== undefined)      { patch.summary = input.summary;        fields.push('summary') }
      if (input.tags !== undefined)         { patch.tags = input.tags;              fields.push('tags') }
      if (input.related_ids !== undefined)  { patch.relatedIds = input.related_ids; fields.push('related_ids') }
      if (input.sensitivity !== undefined)  { patch.sensitivity = input.sensitivity; fields.push('sensitivity') }

      const hasFieldChange = fields.length > 0
      const hasLinkChange = (input.links?.length ?? 0) > 0
      const hasCloseChange = (input.closeLinks?.length ?? 0) > 0
      if (!hasFieldChange && !hasLinkChange && !hasCloseChange) {
        return {
          data: 'No metadata or links provided. Pass at least one of title, summary, tags, related_ids, sensitivity, links, closeLinks.',
          isError: true,
        }
      }

      // Resolve the file id even when no metadata changes (links-only
      // updates still need to anchor to the file row).
      let fileId: string
      let filePath: string
      if (hasFieldChange) {
        const result = await api.setMeta(ctxFor(context), input.file, patch)
        if (!result.ok) {
          return { data: errorMessage(result.error), isError: true }
        }
        const file = result.value
        fileId = file.id
        filePath = file.path
        opts?.onEvent?.(
          { type: 'file_meta_updated', fileId: file.id, path: file.path, fields },
          eventCtx(context),
        )
      } else {
        // No-op setMeta with an empty patch returns the file row so we
        // can read its id without diverging from the existing call
        // path. The API treats `{}` as a read-back.
        const result = await api.setMeta(ctxFor(context), input.file, {})
        if (!result.ok) {
          return { data: errorMessage(result.error), isError: true }
        }
        fileId = result.value.id
        filePath = result.value.path
      }
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'file',
        sourceId: fileId,
        source: 'user',
        links: input.links,
      })
      const closesSummary = await applyExplicitCloses({
        entityLinks: opts?.entityLinks,
        userId: context.userId,
        sourceKind: 'file',
        sourceId: fileId,
        closes: input.closeLinks,
      })
      const fieldsPart = hasFieldChange ? `Updated ${fields.join(', ')} on ${filePath}.` : `Linked ${filePath}.`
      return { data: `${fieldsPart}${formatLinksSummary(linksSummary)}${formatClosesSummary(closesSummary)}` }
    },
  })

  const fileDelete = buildTool({
    name: 'fileDelete',
    requiresCapability: 'files',
    requiresConfirmation: true,
    description:
      'Permanently delete a workspace file. Both the metadata row and the stored file are removed. Workspace members can recover within a 30-day soft-delete window through support, but there is no in-product undo. Default policy is `block` — a workspace owner must opt in to allow this from chat.',
    inputSchema: z.object({
      file: idOrPathShape.describe('UUID or absolute workspace path of the file.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const result = await api.delete(ctxFor(context), input.file)
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      opts?.onEvent?.(
        { type: 'file_deleted', fileId: result.value.id, path: result.value.path },
        eventCtx(context),
      )
      return { data: `Deleted ${result.value.path}.` }
    },
  })

  // ── saveFileToBrain — promote a transient upload into the file primitive ──
  //
  // The "save permanently" branch for chat/comment attachments. Reads the
  // original bytes from the upload cache (`file_cache`, via `readCachedFile`)
  // and persists them verbatim to `workspace_files` (GCS), so an image/PDF is
  // kept as the real file — not a text summary (that's the bug this fixes).
  const DATA_URL_RE = /^data:[^;]+;base64,(.+)$/

  const saveFileToBrain = buildTool({
    name: 'saveFileToBrain',
    requiresCapability: 'files',
    // No confirmation: the user explicitly asked to save the attachment, it's
    // reversible (fileDelete), and it mirrors saveMemory's friction-free UX.
    // Comment-thread chats also don't surface a confirmation card, so a
    // required confirmation would silently stall the save.
    requiresConfirmation: false,
    description:
      'Save an UPLOADED FILE (a chat or comment attachment) to the workspace brain as a real file, preserving the original — the actual image / PDF / document, not a text summary. ' +
      'Use this — NOT saveMemory — whenever the user asks to save / keep / store / remember an attached file. saveMemory only records a text note and loses the file. ' +
      'Pass the `fileId` from the attachment\'s `<attached_file id="…">` tag. Uploaded files are cached for ~7 days, so a stale id may have expired — if so, ask the user to re-attach. ' +
      'The saved file joins the workspace file index (searchable, shareable) and its path is the durable link.',
    inputSchema: z.object({
      fileId: idShape.describe('The id from the uploaded attachment\'s <attached_file id="…"> tag.'),
      path: z
        .string()
        .min(1)
        .max(1024)
        .optional()
        .describe('Workspace path, e.g. "/uploads/degree-certificate.png". Defaults to /uploads/<original filename>.'),
      title: z.string().min(1).max(256).optional().describe('Display label; defaults to the original filename.'),
      summary: z.string().min(1).max(512).optional().describe('One-line description for the # Workspace Files block.'),
      tags: tagShape.optional(),
      sensitivity: sensitivityEnum.optional(),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (!opts?.readCachedFile) {
        return {
          data: 'This assistant cannot save uploaded files to the brain (the upload cache is not wired here). Tell the user the file can\'t be saved.',
          isError: true,
        }
      }

      const cached = await opts.readCachedFile(input.fileId, {
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        assistantKind: context.assistantKind ?? 'standard',
        clearance: context.clearance,
        compartments: context.compartments,
      })
      if (!cached) {
        return {
          data: `No uploaded file found for id ${input.fileId} — it may have expired (uploads are kept ~7 days). Ask the user to re-attach the file, then try again. Do not substitute a memory.`,
          isError: true,
        }
      }

      // Binary attachments (image/PDF/audio) are cached as a base64 data URL;
      // text-like files are cached as plain UTF-8. Decode either to raw bytes.
      const m = DATA_URL_RE.exec(cached.content)
      const bytes = m ? Buffer.from(m[1], 'base64') : Buffer.from(cached.content, 'utf-8')
      const path = input.path ?? `/uploads/${cached.fileName}`

      const result = await api.writeBytes(ctxFor(context), {
        path,
        bytes,
        mime: cached.mimeType,
        title: input.title ?? cached.fileName,
        summary: input.summary ?? cached.summary ?? null,
        tags: input.tags,
        sensitivity: input.sensitivity,
      })
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      const file = result.value
      opts.onEvent?.(
        { type: 'file_created', fileId: file.id, path: file.path, sizeBytes: file.sizeBytes },
        eventCtx(context),
      )
      return {
        data: `Saved "${cached.fileName}" to the workspace brain at ${file.path} (${file.sizeBytes} bytes, ${file.mime}). id=${file.id}. The original file is preserved and searchable.`,
      }
    },
  })

  // ── saveFileBytes — persist raw bytes the caller holds (base64) ──────────
  //
  // The byte-preserving sibling of fileWrite: fileWrite stores UTF-8 text the
  // caller authors; saveFileToBrain promotes a prior upload by its cache id;
  // saveFileBytes takes the bytes inline as base64 and writes them verbatim.
  // This is the path a programmatic caller (brain MCP) uses to push a real
  // image / PDF / document without a chat upload. The size cap is checked
  // before decode (a tool-call arg has no multipart body limit).
  const DATA_URL_PREFIX_RE = /^data:[^;]+;base64,(.+)$/s

  const saveFileBytes = buildTool({
    name: 'saveFileBytes',
    requiresCapability: 'files',
    requiresConfirmation: true,
    description:
      'Save a file to the workspace brain from raw bytes you provide as base64 (an image, PDF, or document), preserving the EXACT original bytes. ' +
      'Use this when you hold a file\'s bytes directly. To author NEW text content use fileWrite (UTF-8); to save a file the user UPLOADED in chat use saveFileToBrain (it references the upload by id and needs no bytes). ' +
      '`path` is required and must be unique in the workspace; an overwrite of an existing path returns a conflict error — call fileDelete first or pass a new path. ' +
      '`mime` is required (bytes carry no inferable type). `title` / `summary` improve discovery; optional `links` attach entity edges. ' +
      'Large files are rejected (keep under ~10 MB) — bigger files must be uploaded through the app, not sent as a tool argument.',
    inputSchema: z.object({
      path: z.string().min(1).max(1024).describe('Workspace-relative path, e.g. "/uploads/listco-market.pdf". Forward slashes; leading slash optional.'),
      base64: z.string().min(1).describe('The file content as a base64 string (a bare base64 body or a data: URL — the data: prefix is stripped). Decoded verbatim to the stored bytes.'),
      mime: z.string().min(1).max(128).describe('MIME type of the bytes, e.g. "application/pdf". Required — binary cannot be inferred.'),
      title: z.string().min(1).max(256).optional().describe('Display label for the L1 surface and search. Distinct from filename.'),
      summary: z.string().min(1).max(512).optional().describe('One-line description visible in the L1 # Workspace Files block.'),
      tags: tagShape.optional(),
      sensitivity: sensitivityEnum.optional().describe('Defaults to internal. public is visible to all workspace members; confidential is reserved for high-sensitivity material.'),
      links: explicitLinksField,
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      if (input.base64.length > MAX_SAVE_FILE_BYTES_BASE64) {
        return {
          data: `File too large: the base64 payload is ${input.base64.length} characters (limit ${MAX_SAVE_FILE_BYTES_BASE64}, about 10 MB decoded). Upload large files through the app instead of sending them as a tool argument.`,
          isError: true,
        }
      }

      // Tolerate a data: URL form (the cache stores binary that way) by
      // stripping the prefix; otherwise treat the whole string as base64.
      const m = DATA_URL_PREFIX_RE.exec(input.base64)
      const raw = m ? m[1] : input.base64
      const bytes = Buffer.from(raw, 'base64')
      if (bytes.length === 0) {
        return { data: 'Decoded file is empty — check that `base64` is valid base64 content.', isError: true }
      }

      const result = await api.writeBytes(ctxFor(context), {
        path: input.path,
        bytes,
        mime: input.mime,
        title: input.title,
        summary: input.summary ?? null,
        tags: input.tags,
        sensitivity: input.sensitivity,
      })
      if (!result.ok) {
        return { data: errorMessage(result.error), isError: true }
      }
      const file = result.value
      opts?.onEvent?.(
        { type: 'file_created', fileId: file.id, path: file.path, sizeBytes: file.sizeBytes },
        eventCtx(context),
      )
      const linksSummary = await applyExplicitLinks({
        entityLinks: opts?.entityLinks,
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        sourceKind: 'file',
        sourceId: file.id,
        source: 'user',
        links: input.links,
      })
      return {
        data: `Saved ${file.path} (${file.sizeBytes} bytes, ${file.mime}). id=${file.id}${formatLinksSummary(linksSummary)}`,
      }
    },
  })

  // sendFile — outbound document delivery. Built in `send-file.ts`
  // ([COMP:files/send-file]); included here so boot wiring registers all
  // file tools through one constructor.
  const sendFile = createSendFileTool(api)

  return { fileWrite, fileAppend, fileRead, fileSearch, fileSetMeta, fileDelete, saveFileToBrain, saveFileBytes, sendFile }
}
