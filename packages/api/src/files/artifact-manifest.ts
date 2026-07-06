// [COMP:files/artifact-manifest] — the compact manifest a chat turn carries
// instead of a large file's raw content (large-content-artifacts §Phase 2.3,
// decision D1: artifact-not-conversation).
//
// One shared renderer so web attach, channel content blocks, and paste
// promotion emit byte-identical manifests. The manifest is persisted in
// session_messages, so the artifact id outlives file_cache's 7-day TTL —
// the tools read durable tables. Keeps the `<attached_file>` envelope the
// app-web attachment correlator + channel renderers already understand.
// No em dash anywhere (transcript text can surface in user-facing renders).

export type ArtifactManifestData = {
  fileId: string
  fileName: string
  mime: string
  sizeBytes: number
  /** Length of the canonical parsed text, when known. */
  charLength?: number
  /** Indexed section count, when segments exist. */
  segmentCount?: number
  summary?: string | null
  /**
   * ready   -> chunked; keyword/range retrieval live (semantic follows within
   *            minutes via the embedding worker).
   * pending -> stored + queued; sections appear shortly.
   * failed  -> stored; indexing failed (readFileContent still works via cache).
   */
  status: 'ready' | 'pending' | 'failed'
  /** True when chunking stopped at the segment cap (manifest says so). */
  truncated?: boolean
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

const STATUS_LINES: Record<ArtifactManifestData['status'], string> = {
  ready: 'indexed (keyword search live; semantic ranking finishes within a couple of minutes)',
  pending: 'indexing (stored and queued; sections become searchable in a minute or two)',
  failed: 'indexing failed (the stored file is intact; readFileContent can read what was parsed)',
}

/** Render the `<attached_file kind="artifact">` manifest block. */
export function renderArtifactManifest(d: ArtifactManifestData): string {
  const stats = [
    formatSize(d.sizeBytes),
    ...(d.charLength !== undefined ? [`~${d.charLength.toLocaleString('en-US')} chars`] : []),
    ...(d.segmentCount !== undefined
      ? [`${d.segmentCount} indexed sections${d.truncated ? ' (first part only; the stored file holds the rest)' : ''}`]
      : []),
  ].join(' | ')
  const lines = [
    `[Stored document - content NOT inlined (too large for context).`,
    `artifactId: ${d.fileId}   ${stats}`,
    ...(d.summary ? [`summary: ${d.summary}`] : []),
    `status: ${STATUS_LINES[d.status]}`,
    `To extract: call searchFileContent with fileId="${d.fileId}" and a natural-language query to get`,
    `the most relevant sections (each carries segment_index and a heading breadcrumb); pass`,
    `fromIndex/toIndex instead to read sequential sections in order. Sections from this document`,
    `also appear in general brain search results.]`,
  ]
  return `<attached_file id="${d.fileId}" name="${d.fileName}" type="${d.mime}" kind="artifact">\n${lines.join('\n')}\n</attached_file>`
}
