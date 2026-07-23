/**
 * `searchEmailArchive` — semantic recall over the synced mailbox archive
 * (mailbox-imap.md §Phase 2; the searchRecording pattern: an api-side core
 * `Tool` over a store-level hybrid search).
 *
 * Query routing is honest in the description: fresh/exact lookups belong to
 * the live imapSearch* tools; semantic mailbox recall belongs here; cross-
 * source knowledge belongs to searchBrain. Person-compartmented: the owner
 * and instance are BOUND AT INJECTION (never model input), and the store fn
 * owner-gates twice (predicate + owner-scoped RLS) — another member's
 * search cannot read this archive.
 *
 * The embedder reaches the injector through a late-bound global seam
 * (`setGlobalMailboxArchiveDeps`, the agentmail provider pattern) so every
 * `injectMcpTools` call site gets the tool without a params-chain change;
 * with no embedder wired the vector arm soft-fails to ILIKE inside the
 * store fn.
 *
 * [COMP:tools/email-archive-search]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '@use-brian/core'
import { searchEmailArchive } from '../db/email-archive-store.js'

export type MailboxArchiveDeps = {
  /** Query embedder for the vector arm; omit to run ILIKE-only. */
  embedder?: { embed(texts: string[]): Promise<number[][]> }
  /** Store override (tests). Defaults to the email-archive-store fn. */
  search?: typeof searchEmailArchive
}

let globalMailboxArchiveDeps: MailboxArchiveDeps | null = null

/** Boot wires this once (DB + embedder available); null = archive search dark. */
export function setGlobalMailboxArchiveDeps(deps: MailboxArchiveDeps | null): void {
  globalMailboxArchiveDeps = deps
}

export function getGlobalMailboxArchiveDeps(): MailboxArchiveDeps | null {
  return globalMailboxArchiveDeps
}

const inputSchema = z.object({
  query: z
    .string()
    .describe('What to look for across the synced mailbox, in natural language.'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('How many passages to return (default 8, max 20).'),
  from: z.string().optional().describe('Only messages whose sender matches this substring.'),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Earliest sent date (YYYY-MM-DD).'),
  before: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('Latest sent date (YYYY-MM-DD), exclusive.'),
  account: z
    .string()
    .optional()
    .describe(
      'Which connected company mailbox to search, by its email address. ' +
      'Omit to search the primary (first-connected) mailbox. Only needed when more than one mailbox is connected.',
    ),
})

/** A connected mailbox archive, primary first — bound at injection, never model input. */
export type ArchiveAccountRef = {
  /** The imap connector instance owning this archive. */
  instanceId: string
  /** The mailbox email — the value the model passes as `account`. */
  email: string
  /** True for the primary (first-connected) mailbox — the default. */
  isPrimary: boolean
}

export type CreateArchiveSearchToolOptions = {
  /** The mailbox owner — bound at injection, never model input. */
  ownerUserId: string
  /** The owner's connected mailboxes, primary first — bound at injection. */
  accounts: ArchiveAccountRef[]
  deps: MailboxArchiveDeps
}

export function createSearchEmailArchiveTool(opts: CreateArchiveSearchToolOptions): Tool {
  const search = opts.deps.search ?? searchEmailArchive
  return buildTool({
    name: 'searchEmailArchive',
    description:
      "Semantic search over the user's SYNCED company-mailbox archive — meaning-based recall across the whole mailbox history " +
      '("what did the landlord say about the deposit"), even when exact words are unknown. ' +
      'Results carry a message id (`folder:uid`) usable with imapGetMessage for the full message. ' +
      'For fresh or exact lookups (new mail, a known sender/date), use imapSearchMessages instead — the archive syncs on a delay. ' +
      'For cross-source company knowledge, use searchBrain. ' +
      'If more than one company mailbox is connected, pass `account` (the mailbox email) to choose which; omit it for the primary.',
    inputSchema,
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input) {
      const accounts = opts.accounts
      if (accounts.length === 0) {
        return { data: 'No company mailbox is connected. Connect one in Studio → Connectors, then try again.', isError: true }
      }
      let target: ArchiveAccountRef | undefined
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
        const hits = await search(
          {
            ownerUserId: opts.ownerUserId,
            instanceId: target.instanceId,
            query: input.query,
            topK: input.topK,
            from: input.from,
            since: input.since,
            before: input.before,
          },
          opts.deps.embedder ? { embedder: opts.deps.embedder } : undefined,
        )
        return { data: hits }
      } catch (err) {
        return {
          data: `searchEmailArchive failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}
