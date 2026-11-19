/**
 * Reply publication under the original turn owner (plan section 3.3, D9).
 *
 * Every entrypoint (web, channel, public API, delegated callee, durable
 * resume) and both editions publish assistant-authored transcript rows through
 * `AssistantTurn.publish`, which calls the one writer here. The writer chooses
 * the existing store operation exactly as the adapters did before the transfer:
 *
 *   - canonical native batch (`publishNativeSessionMessageBatch`, or the
 *     shared-web `publishBufferedWebConversation` with its terminal binding)
 *     when the adapter holds native transcript authority and its write carries
 *     a derivation;
 *   - otherwise the stored writer: one `addSessionMessage` for a single row, or
 *     one transaction for several, inside the adapter's authority bracket.
 *
 * The owner, not the adapter, supplies the lease pin (`turnToken`, or
 * `stoppedTurnToken` for a stopped streaming buffer), the terminal binding and
 * the durable completion identity. The writer adds no lock, statement or
 * authorization of its own: the native transaction keeps its opening,
 * pre-commit and post-commit checks and its uncertain-outcome marker; the
 * stored writer keeps the adapter's bracket. Permission results never cross
 * this operation, and post-commit delivery stays a separate fresh check.
 *
 * Spec: docs/architecture/engine/turn-kernel.md "Reply publication";
 * docs/architecture/context-engine/session-messages.md "Reply publication
 * belongs to the turn owner". [COMP:api/turn-kernel]
 */
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import { synthesizeMissingToolResults } from '@use-brian/agent-runtime/engine/tool-pairing.js'
import type { ContentBlock } from '@use-brian/agent-runtime/providers/types.js'
import type { DerivedWriteEvidence, ResourceScope } from '@use-brian/agent-runtime/security/derived-scope.js'
import { publishBufferedWebConversation, publishNativeSessionMessageBatch, publishStoredTurnPublication } from '../db/conversation-store.js'
import type { BufferedWebPublication, TurnCompletionInput, TurnCompletionLane } from '../db/conversation-publication-recovery.js'
import type { SessionMessage, SessionMessageAttachment } from '../db/sessions.js'
import type { BoundBufferedTerminalCommand } from './terminal-publication.js'
import type { PublicTurnConversationBinding } from '../db/public-conversation.js'
import type { ChannelRecordPublication } from '../db/verified-channel-record.js'

/** One transcript row the turn publishes; identity and scope come from the owner and the write. */
export type TurnPublicationRow = {
  role: 'assistant' | 'user'
  content: unknown
  senderAssistantId?: string | null
  senderUserId?: string | null
  channelMessageId?: string | null
  attachments?: SessionMessageAttachment[]
}

/** Exactly what the adapter's `turnOutputWrite` produced for this publication. */
export type TurnPublicationWrite =
  | { derivation: DerivedWriteEvidence; derivationTarget?: ResourceScope }
  | { scope: ResourceScope }

export type TurnPublicationRequest = {
  /** `reply`: the turn's one reply publication. `closing`: a recovery/synthesis
   * row written after or instead of it; it never marks a published reply. */
  disposition: 'reply' | 'closing'
  rows: readonly TurnPublicationRow[]
  write: TurnPublicationWrite
  /** The adapter's native transcript authority; absent selects the stored writer. */
  native?: SessionContextAuthority | null
  /** The adapter's authority bracket for the stored writer. */
  execute: <T>(operation: () => Promise<T>) => Promise<T>
  /** Public stored reply uses the exact original credential in its transaction. */
  publicConversation?: PublicTurnConversationBinding
  /** Verified provider append pins the addressed envelope inside the writer. */
  channelRecord?: ChannelRecordPublication
  /** Native only: the classification's pending annotation, published in the same transaction. */
  pendingAnnotation?: object
  /** Native shared web only: the buffered root and the selected terminal ordinals. */
  buffered?: { root: BufferedWebPublication; selectedOrdinals: readonly number[] | null }
  measure?: <T>(counter: string, run: () => Promise<T>) => Promise<T>
  /** `reply` only: the lane and turn input of the durable completion header
   * (migration 8277). Recorded in the same transaction as the rows; the owner
   * supplies the operation identity. Ignored for a `closing` publication. */
  completion?: { lane: TurnCompletionLane; input: TurnCompletionInput | null; assistantId: string }
}

/** The owner's per-publication capabilities; never exposed to adapters. */
export type TurnPublicationOwnerPort = {
  sessionId: string
  token: string
  /** The owner's one completion identity (`owner.completion.operationId`). */
  operationId: string
  stopped: boolean
  bindTerminal(root: BufferedWebPublication, authority: SessionContextAuthority,
    rows: readonly { role: string; content: unknown; senderAssistantId?: string | null }[], ordinals: readonly number[] | null): BoundBufferedTerminalCommand
}

/** The single writer. Same store operations, arguments and transaction shape as the
 * displaced adapter branches; the owner supplies the token and terminal binding. */
export async function writeTurnPublication(owner: TurnPublicationOwnerPort, request: TurnPublicationRequest): Promise<SessionMessage[]> {
  const { rows, write, native } = request
  if ('authority' in write) throw new Error('Native transcript authority belongs to the publication request, not its write.')
  const completion = request.disposition === 'reply' && request.completion
    ? { operationId: owner.operationId, ...request.completion } : undefined
  if (native && 'derivation' in write) {
    const command = { sessionId: owner.sessionId, messages: rows, derivation: write.derivation, derivationTarget: write.derivationTarget,
      authority: native, ...(request.measure ? { measure: request.measure } : {}),
      publication: { pendingAnnotation: request.pendingAnnotation, ...(completion ? { completion } : {}),
        ...(request.publicConversation ? { publicConversation: request.publicConversation } : {}),
        ...(request.channelRecord ? { channelRecord: request.channelRecord } : {}),
        ...(owner.stopped ? { stoppedTurnToken: owner.token } : { turnToken: owner.token }) } }
    const buffered = request.buffered
    return buffered
      ? publishBufferedWebConversation({ ...command, operation: buffered.root,
          terminalBinding: values => owner.bindTerminal(buffered.root, native, values, buffered.selectedOrdinals) })
      : publishNativeSessionMessageBatch(command)
  }
  if (request.buffered || request.pendingAnnotation) throw new Error('Buffered terminal and annotation publication require the native writer.')
  // The stored writer (no native transcript authority): the displaced shape
  // without a completion; with one, rows and the completion header commit together.
  return request.execute(() => publishStoredTurnPublication({ sessionId: owner.sessionId, rows, write, token: owner.token,
    stopped: owner.stopped, ...(completion ? { completion } : {}),
    ...(request.publicConversation ? { publicConversation: request.publicConversation } : {}),
    ...(request.channelRecord ? { channelRecord: request.channelRecord } : {}) }))
}

/** A buffered model round: its content and the tool results it received. */
export type BufferedTurnRound = { content: ContentBlock[]; toolResults: ContentBlock[]; origin?: string }

/** Per-row metadata for the assistant rows of an assembled publication. */
export type AssembledTurnRow = { turnIndex: number; isLast: boolean; content: ContentBlock[] }

/**
 * Pairing-safe row assembly shared by the buffering adapters: each non-empty
 * round becomes its assistant row, followed by its tool results with a stub for
 * any tool_use that never received one. `isLast` marks the last round with raw
 * content; attachments ride only on that row. `lead` rows (host observations)
 * precede the rounds and are never last.
 */
export function assembleTurnPublication(rounds: readonly BufferedTurnRound[], options: {
  reason: string
  sender: Pick<TurnPublicationRow, 'senderAssistantId' | 'senderUserId'>
  attachments?: SessionMessageAttachment[]
  transform?: (content: ContentBlock[]) => ContentBlock[]
  lead?: readonly TurnPublicationRow[]
}): { rows: TurnPublicationRow[]; assistantRows: Map<number, AssembledTurnRow>; ordinals: Map<string, number> } {
  const rows: TurnPublicationRow[] = [], assistantRows = new Map<number, AssembledTurnRow>(), ordinals = new Map<string, number>()
  for (const lead of options.lead ?? []) {
    assistantRows.set(rows.length, { turnIndex: -1, isLast: false, content: lead.content as ContentBlock[] })
    rows.push(lead)
  }
  let last = -1
  for (let i = rounds.length - 1; i >= 0; i--) if (rounds[i]!.content.length > 0) { last = i; break }
  for (const [turnIndex, round] of rounds.entries()) {
    if (round.content.length === 0) continue
    const content = options.transform ? options.transform(round.content) : round.content
    if (content.length === 0) continue
    const isLast = turnIndex === last
    assistantRows.set(rows.length, { turnIndex, isLast, content: round.content })
    if (round.origin) {
      if (ordinals.has(round.origin)) throw new Error('Duplicate publication output origin')
      ordinals.set(round.origin, rows.length)
    }
    rows.push({ role: 'assistant', content, ...options.sender,
      attachments: isLast && options.attachments?.length ? options.attachments : undefined })
    const results = [...round.toolResults, ...synthesizeMissingToolResults(round.content, round.toolResults, options.reason)]
    if (results.length > 0) rows.push({ role: 'user', content: results })
  }
  return { rows, assistantRows, ordinals }
}
