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

/**
 * Channels whose adapter actually puts a document on the wire.
 *
 * This list is the `sendFile` gate's authority, and it exists because the
 * pipeline hands `documents` to every adapter and **an adapter that cannot
 * deliver them just ignores the argument** (`channel-pipeline.ts` → "Channels
 * that can't deliver documents ignore the argument"). Without the gate the
 * tool reports success, the model tells the user the file is attached, and
 * nothing arrives — the worst failure shape available, since the user has no
 * way to tell a lost document from one that was never sent.
 *
 * **Adding a channel here is a claim about its adapter, not a preference.**
 * Only add one once its adapter reads `response.documents` and uploads them.
 */
export const DOCUMENT_CAPABLE_CHANNELS: ReadonlySet<string> = new Set([
  'web',
  'telegram',
  'slack',
  'discord',
  'email',
  'msteams',
])

/**
 * Per-channel byte ceilings for platforms stricter than
 * {@link MAX_EXTERNAL_DOCUMENT_BYTES}. Discord's upload limit on an
 * unboosted server is 10 MiB, so a 20 MB file would 413 at the adapter — the
 * gate refuses it up front instead, where the model can relay a real reason.
 */
const CHANNEL_DOCUMENT_BYTE_CAPS: Readonly<Record<string, number>> = {
  discord: 10 * 1024 * 1024,
}

/** The document byte ceiling in force for a channel. Web is uncapped. */
export function documentByteCapFor(channelType: string): number {
  return CHANNEL_DOCUMENT_BYTE_CAPS[channelType] ?? MAX_EXTERNAL_DOCUMENT_BYTES
}

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
