// [COMP:files/artifact-promote] — silent promotion of a large upload/paste to
// a durable workspace_files artifact + file_segments (large-content-artifacts
// §Phase 2.3).
//
// Boundary contract: cheap sync work only. writeBytes (one storage write +
// one insert) + indexFileArtifact (pure CPU chunk + one batched insert; NO
// model call) run inline so keyword/range retrieval is live when the request
// returns; the optional `enqueue` hands Pipeline B decomposition (a model
// pass) to the file_ingest_jobs worker. Every failure degrades to null —
// promotion NEVER fails the upload/message that triggered it (the file_cache
// row still exists; behavior falls back to the pre-artifact pointer).

import type { FilesApi, FilesContext } from '@sidanclaw/core'
import { indexFileArtifact } from './artifact-index.js'

export type PromotedArtifact = {
  fileId: string
  path: string
  status: 'ready' | 'pending'
  segmentCount: number
  truncated: boolean
}

export type ArtifactPromoteInput = {
  fileName: string
  mime: string
  bytes: Buffer
  /** Canonical parsed text (the chunker input). Empty -> store-only. */
  parsedText: string
  summary?: string | null
  workspaceId: string
  actingUserId: string
  assistantId?: string | null
  /** Skip chunking (e.g. big PDFs on the silent path — store-only). */
  storeOnly?: boolean
  /** Path prefix; default '/uploads/chat'. Pastes use '/uploads/pastes'. */
  pathPrefix?: string
}

export type ArtifactPromoter = (input: ArtifactPromoteInput) => Promise<PromotedArtifact | null>

/** Filesystem-safe slug of an original file name (keeps the extension). */
function slugName(fileName: string): string {
  return (
    fileName
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'file'
  )
}

export function createArtifactPromoter(deps: {
  filesApi: FilesApi
  /** file_ingest_jobs enqueue (Pipeline B via the worker). Absent -> segments only. */
  enqueue?: (job: {
    fileId: string
    workspaceId: string
    actingUserId: string
    assistantId: string | null
    sourceLabel: string
  }) => Promise<unknown>
}): ArtifactPromoter {
  return async function promote(input) {
    try {
      const ctx: FilesContext = {
        workspaceId: input.workspaceId,
        userId: input.actingUserId,
        ...(input.assistantId ? { assistantId: input.assistantId } : {}),
      }
      // Timestamped path: no path-UNIQUE conflicts on re-upload; the artifact
      // is workspace-shared (filesApi default NULL/NULL visibility, decision D4).
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = `${input.pathPrefix ?? '/uploads/chat'}/${stamp}-${slugName(input.fileName)}`
      const stored = await deps.filesApi.writeBytes(ctx, {
        path,
        bytes: input.bytes,
        mime: input.mime,
        title: input.fileName,
        ...(input.summary ? { summary: input.summary } : {}),
        sensitivity: 'internal',
      })
      if (!stored.ok) {
        console.warn('[artifact-promote] writeBytes failed (cache-only fallback):', stored.error)
        return null
      }
      const file = stored.value

      let segmentCount = 0
      let truncated = false
      if (!input.storeOnly && input.parsedText.trim().length > 0) {
        const indexed = await indexFileArtifact({
          fileId: file.id,
          workspaceId: input.workspaceId,
          text: input.parsedText,
          actingUserId: input.actingUserId,
        })
        segmentCount = indexed.segmentCount
        truncated = indexed.truncated
      }

      let status: PromotedArtifact['status'] = 'ready'
      if (deps.enqueue) {
        // Pipeline B decomposition rides the worker (decision D5). Segments are
        // already live, so the manifest stays 'ready'; enqueue failure is loud
        // but non-fatal (decomposition is additive).
        await deps
          .enqueue({
            fileId: file.id,
            workspaceId: input.workspaceId,
            actingUserId: input.actingUserId,
            assistantId: input.assistantId ?? null,
            sourceLabel: input.fileName,
          })
          .catch((err) => console.error('[artifact-promote] enqueue failed (segments still live):', err))
      }
      if (input.storeOnly) status = 'ready'

      return { fileId: file.id, path: file.path, status, segmentCount, truncated }
    } catch (err) {
      console.error('[artifact-promote] promotion failed (cache-only fallback):', err)
      return null
    }
  }
}
