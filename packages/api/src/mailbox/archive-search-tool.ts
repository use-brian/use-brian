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
import { buildTool, inferExactExternalEmail, type Tool } from '@use-brian/core'
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

const archiveSearchShape = {
  query: z
    .string()
    .describe('What to look for across the synced email archive, in natural language.'),
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
}

const archiveAccountField = z
  .string()
  .optional()
  .describe(
    'Which connected email account to search, by its email address. ' +
    'Omit to search the primary (first-connected) email account. Only needed when more than one email account is connected.',
  )

/** A connected mailbox archive, primary first — bound at injection, never model input. */
export type ArchiveAccountRef = {
  /** The imap connector instance owning this archive. */
  instanceId: string
  /** The mailbox email - authoritative identity for binding or legacy routing. */
  email: string
  /** True for the primary (first-connected) mailbox — the default. */
  isPrimary: boolean
}

export type CreateArchiveSearchToolOptions = {
  /** The mailbox owner — bound at injection, never model input. */
  ownerUserId: string
  /** The owner's connected mailboxes, primary first — bound at injection. */
  accounts: ArchiveAccountRef[]
  /** Fixed runtime variant identity. Omits `account` from the tool schema. */
  boundAccount?: ArchiveAccountRef
  deps: MailboxArchiveDeps
}

export function createSearchEmailArchiveTool(opts: CreateArchiveSearchToolOptions): Tool {
  const search = opts.deps.search ?? searchEmailArchive
  const accountInputShape: z.ZodRawShape = opts.boundAccount ? {} : { account: archiveAccountField }
  return buildTool({
    name: 'searchEmailArchive',
    description:
      "Search the user's synced email archive by meaning across the full email history " +
      '("what did the landlord say about the deposit"), even when exact words are unknown. ' +
      'Results carry a message id (`folder:uid`) usable with imapGetMessage for the full message. ' +
      'For fresh or exact lookups (new mail, a known sender/date), use imapSearchMessages instead — the archive syncs on a delay. ' +
      'For cross-source company knowledge, use searchBrain. ' +
      (opts.boundAccount
        ? `This tool is bound to the email account ${opts.boundAccount.email}; use the separately named tool set for another email account.`
        : 'If more than one email account is connected, pass `account` (the email address) to choose which; omit it for the primary.'),
    inputSchema: z.object({ ...archiveSearchShape, ...accountInputShape }),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    timeoutMs: 30_000,
    async execute(input, context) {
      const accounts = opts.accounts
      if (accounts.length === 0) {
        return { data: 'No email account is connected through IMAP/SMTP. Connect one in Studio → Connectors, then try again.', isError: true }
      }
      let target: ArchiveAccountRef | undefined = opts.boundAccount
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
        const inferredFrom = inferExactExternalEmail({
          texts: [context.userMessageText, input.query],
          boundAccountEmail: target.email,
          explicitFrom: input.from,
        })
        const { hits, coverage } = await search(
          {
            ownerUserId: opts.ownerUserId,
            instanceId: target.instanceId,
            query: input.query,
            topK: input.topK,
            from: input.from ?? inferredFrom,
            since: input.since,
            before: input.before,
          },
          opts.deps.embedder ? { embedder: opts.deps.embedder } : undefined,
        )
        // Partial coverage rides WITH the results (B7). Without it the model
        // cannot tell "nothing matched" from "not all of it is indexed yet",
        // and reports an absence it has no basis for — which the embed budget
        // makes a permanent condition, not a transient one.
        return { data: coverage.note ? { hits, coverage: coverage.note } : hits }
      } catch (err) {
        // A thrown search is a FAILURE, never an empty result: the model must
        // not report "no matching email" on the strength of it.
        return {
          data: `searchEmailArchive could not run the search (${err instanceof Error ? err.message : String(err)}). This is a failure of the archive lookup, NOT an empty result — do not tell the user nothing matched. Nothing about the query is wrong; retry once after a short wait, and if it persists tell the user the email archive is unavailable right now (the live mailbox tools, e.g. imapSearchMessages, may still work).`,
          isError: true,
        }
      }
    },
  })
}
