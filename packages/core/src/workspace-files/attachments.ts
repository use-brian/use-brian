/**
 * Per-turn outbound-attachment collector — the seam between the `sendFile`
 * tool and channel delivery. The tool registers INTENT here (metadata only,
 * no bytes); the channel route drains the collector at `turn_complete` and
 * resolves bytes via `FilesApi.readBytes` for the documents that actually
 * deliver. Same per-turn-accumulator idiom as `SensitivityAccumulator`.
 *
 * See docs/architecture/channels/adapter-pattern.md → "Outbound documents"
 * and docs/architecture/features/files.md → "`sendFile`".
 */

export type OutboundAttachment = {
  /** `workspace_files.id` — resolved to bytes at delivery time. */
  fileId: string
  workspaceId: string
  path: string
  /** User-visible filename (becomes the document's name on the channel). */
  name: string
  mime: string
  sizeBytes: number
  /** Optional caption (Telegram caption / Slack title). Plain text. */
  caption?: string
}

/** Max attachments a single reply may carry. */
export const MAX_ATTACHMENTS_PER_TURN = 5

/**
 * Max bytes per document on messaging channels (Telegram multipart bound is
 * 50 MB — 45 MB leaves headroom). Web has no cap: no byte transfer happens
 * there (the client downloads via signed URL).
 */
export const MAX_EXTERNAL_DOCUMENT_BYTES = 45 * 1024 * 1024

export class AttachmentCollector {
  private items: OutboundAttachment[] = []

  /** Register an attachment. Dedup by fileId; capped per turn. */
  note(att: OutboundAttachment): 'added' | 'duplicate' | 'cap_reached' {
    if (this.items.some((i) => i.fileId === att.fileId)) return 'duplicate'
    if (this.items.length >= MAX_ATTACHMENTS_PER_TURN) return 'cap_reached'
    this.items.push(att)
    return 'added'
  }

  /** Snapshot without consuming (web persistence reads this). */
  list(): OutboundAttachment[] {
    return [...this.items]
  }

  /** Consume — delivery paths drain so a recovery resend can't double-attach. */
  drain(): OutboundAttachment[] {
    const out = this.items
    this.items = []
    return out
  }

  get count(): number {
    return this.items.length
  }
}
