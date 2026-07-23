// [COMP:recordings/transcript-artifact] - persist a recording transcript as a
// durable workspace file without duplicating it into file_segments.

import type { FilesApi, FilesContext } from '@use-brian/core'
import { formatTranscript, type TranscriptLineSource } from '@use-brian/shared'

export type PersistTranscriptInput = {
  recordingId: string
  workspaceId: string
  actingUserId: string
  assistantId: string | null
  sensitivity: string
  utterances: readonly TranscriptLineSource[]
  title?: string | null
}

export type PersistedTranscript = { fileId: string; path: string; bytes: number }

function slug(name: string): string {
  return (
    name
      .replace(/\.[^.]+$/, '')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 120) || 'recording'
  )
}

export function createTranscriptArtifactWriter(deps: {
  filesApi: FilesApi
  now?: () => Date
}) {
  return async function persistTranscript(
    input: PersistTranscriptInput,
  ): Promise<PersistedTranscript | null> {
    try {
      if (input.utterances.length === 0) return null

      const text = formatTranscript(input.utterances)
      if (!text.trim()) return null

      const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const path = `/recordings/${stamp}-${slug(input.title ?? 'recording')}.md`
      const ctx: FilesContext = {
        workspaceId: input.workspaceId,
        userId: input.actingUserId,
        ...(input.assistantId ? { assistantId: input.assistantId } : {}),
      }
      const bytes = Buffer.from(text, 'utf8')
      const stored = await deps.filesApi.writeBytes(ctx, {
        path,
        bytes,
        mime: 'text/markdown',
        title: input.title ? `Transcript - ${input.title}` : 'Transcript',
        sensitivity: input.sensitivity as never,
      })
      if (!stored.ok) {
        console.warn('[transcript-artifact] writeBytes failed (non-fatal):', stored.error)
        return null
      }

      await deps.filesApi
        .setMeta(ctx, stored.value.id, {
          metadata: {
            recording_id: input.recordingId,
            indexing: { status: 'skipped', reason: 'transcript_segments' },
          },
        } as never)
        .catch((err: unknown) =>
          console.warn('[transcript-artifact] setMeta failed (artifact still durable):', err),
        )

      return { fileId: stored.value.id, path: stored.value.path, bytes: bytes.length }
    } catch (err) {
      console.error('[transcript-artifact] persist failed (non-fatal):', err)
      return null
    }
  }
}
