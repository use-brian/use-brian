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

const syncAccountField = z
  .string()
  .optional()
  .describe(
    'Which connected email account to sync, by its email address. ' +
    'Omit to sync the primary (first-connected) email account. Only needed when more than one email account is connected.',
  )

/** A connected mailbox, primary first — bound at injection, never model input. */
export type SyncAccountRef = {
  instanceId: string
  email: string
  isPrimary: boolean
}

export type CreateSyncMailboxNowToolOptions = {
  /** The owner's connected mailboxes, primary first — bound at injection. */
  accounts: SyncAccountRef[]
  /** Fixed runtime variant identity. Omits `account` from the tool schema. */
  boundAccount?: SyncAccountRef
  deps: MailboxSyncNowDeps
}

export function createSyncMailboxNowTool(opts: CreateSyncMailboxNowToolOptions): Tool {
  const accountInputShape: z.ZodRawShape = opts.boundAccount ? {} : { account: syncAccountField }
  return buildTool({
    name: 'syncMailboxNow',
    description:
      "Pull new email from the user's connected email account into the searchable email archive right now. " +
      'The archive otherwise syncs on a few-minute delay, so call this first when the user asks about very recent mail and you intend to answer with searchEmailArchive. ' +
      'For a single fresh or exact lookup (a known sender, subject, or date), imapSearchMessages queries the live server directly and needs no sync. ' +
      'Returns how many new messages were pulled. ' +
      (opts.boundAccount
        ? `This tool is bound to the email account ${opts.boundAccount.email}; use the separately named tool set for another email account.`
        : 'If more than one email account is connected, pass `account` (the email address) to choose which; omit it for the primary.'),
    inputSchema: z.object(accountInputShape),
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresConfirmation: false,
    timeoutMs: 60_000,
    async execute(input) {
      const accounts = opts.accounts
      if (accounts.length === 0) {
        return { data: 'No email account is connected through IMAP/SMTP. Connect one in Studio → Connectors, then try again.', isError: true }
      }
      let target: SyncAccountRef | undefined = opts.boundAccount
      const inputWithAccount = input as unknown as { account?: unknown }
      const selectedAccount = typeof inputWithAccount.account === 'string'
        ? inputWithAccount.account
        : undefined
      if (!target && selectedAccount) {
        const wanted = selectedAccount.trim().toLowerCase()
        target = accounts.find((a) => a.email.trim().toLowerCase() === wanted)
        if (!target) {
          return {
            data: `No connected email account "${selectedAccount}". Connected email accounts: ${accounts.map((a) => a.email).join(', ')}.`,
            isError: true,
          }
        }
      } else if (!target) {
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
        // A thrown sync is a FAILURE, never "already up to date".
        return {
          data: `syncMailboxNow could not pull new mail for ${target.email} (${err instanceof Error ? err.message : String(err)}). This is a failure of the sync, NOT "no new mail" — the archive may be behind. Nothing about the arguments is wrong; retry once after a short wait, and if it persists tell the user the mailbox sync is failing (a rejected login means the app password must be reconnected in Studio → Connectors).`,
          isError: true,
        }
      }
    },
  })
}
