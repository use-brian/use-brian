/**
 * `syncMailboxNow` — force an immediate delta sync of a connected company
 * mailbox into the searchable archive, instead of waiting for the background
 * poll (mailbox-imap.md §Phase 2 → "On-demand sync + sync-on-connect").
 *
 * The on-demand twin of the sync worker: the archive otherwise catches up on
 * a few-minute cadence, so this tool lets the assistant make it current right
 * before a `searchEmailArchive` over very recent mail. (A single fresh/exact
 * lookup does not need it — `imapSearchMessages` hits the live server.)
 *
 * Owner + the connected mailbox set are BOUND AT INJECTION (never model
 * input), exactly like `searchEmailArchive`. The sync runs through the
 * worker's single-instance path, reached via a late-bound global seam
 * (`setGlobalMailboxSyncDeps`, the archive-search pattern) so every
 * `injectMcpTools` call site gets the tool without a params-chain change;
 * with no seam wired the tool is simply not injected.
 *
 * [COMP:tools/mailbox-sync-now]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'
import type { MailboxSyncSummary } from './sync-worker.js'

export type MailboxSyncNowDeps = {
  /** Sync one instance now; never throws (returns a reasoned summary). */
  syncInstanceById: (instanceId: string) => Promise<MailboxSyncSummary>
}

let globalMailboxSyncDeps: MailboxSyncNowDeps | null = null

/** Boot wires this once to the sync worker; null = on-demand sync dark. */
export function setGlobalMailboxSyncDeps(deps: MailboxSyncNowDeps | null): void {
  globalMailboxSyncDeps = deps
}

export function getGlobalMailboxSyncDeps(): MailboxSyncNowDeps | null {
  return globalMailboxSyncDeps
}

const inputSchema = z.object({
  account: z
    .string()
    .optional()
    .describe(
      'Which connected company mailbox to sync, by its email address. ' +
      'Omit to sync the primary (first-connected) mailbox. Only needed when more than one mailbox is connected.',
    ),
})

/** A connected mailbox, primary first — bound at injection, never model input. */
export type SyncAccountRef = {
  instanceId: string
  email: string
  isPrimary: boolean
}

export type CreateSyncMailboxNowToolOptions = {
  /** The owner's connected mailboxes, primary first — bound at injection. */
  accounts: SyncAccountRef[]
  deps: MailboxSyncNowDeps
}

export function createSyncMailboxNowTool(opts: CreateSyncMailboxNowToolOptions): Tool {
  return buildTool({
    name: 'syncMailboxNow',
    description:
      "Pull new mail from the user's company mailbox into the searchable archive right now. " +
      'The archive otherwise syncs on a few-minute delay, so call this first when the user asks about very recent mail and you intend to answer with searchEmailArchive. ' +
      'For a single fresh or exact lookup (a known sender, subject, or date), imapSearchMessages queries the live server directly and needs no sync. ' +
      'Returns how many new messages were pulled. ' +
      'If more than one company mailbox is connected, pass `account` (the mailbox email) to choose which; omit it for the primary.',
    inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    timeoutMs: 60_000,
    async execute(input) {
      const accounts = opts.accounts
      if (accounts.length === 0) {
        return { data: 'No company mailbox is connected. Connect one in Studio → Connectors, then try again.', isError: true }
      }
      let target: SyncAccountRef | undefined
      if (input.account) {
        const wanted = input.account.trim().toLowerCase()
        target = accounts.find((a) => a.email.trim().toLowerCase() === wanted)
        if (!target) {
          return {
            data: `No connected company mailbox "${input.account}". Connected mailboxes: ${accounts.map((a) => a.email).join(', ')}.`,
            isError: true,
          }
        }
      } else {
        target = accounts.find((a) => a.isPrimary) ?? accounts[0]
      }
      try {
        const summary = await opts.deps.syncInstanceById(target.instanceId)
        if (!summary.synced) {
          if (summary.reason === 'in_progress') {
            return { data: `A sync is already running for ${target.email}; the archive will be current shortly.` }
          }
          const why =
            summary.reason === 'disconnected'
              ? 'the mailbox is disconnected - reconnect it in Studio → Connectors'
              : summary.reason === 'not_found'
                ? 'the mailbox connection was not found'
                : summary.error ?? 'the sync could not complete'
          return { data: `Could not sync ${target.email}: ${why}.`, isError: true }
        }
        const n = summary.newMessages
        return {
          data:
            n === 0
              ? `${target.email} is already up to date - no new mail since the last sync.`
              : `Pulled ${n} new message${n === 1 ? '' : 's'} from ${target.email} into the searchable archive.`,
        }
      } catch (err) {
        return { data: `syncMailboxNow failed: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })
}
