/**
 * Mailbox (imap connector) ingest adapter — the brain-routing half of the
 * mailbox sync (docs/architecture/integrations/mailbox-imap.md).
 *
 * The Episode shape is the existing email adapter's (`normalizeEmailMessage`
 * → `email_thread` Episode with spotlight-delimited bodies at the Pipeline B
 * boundary); only the filters differ — an owned corporate mailbox has no
 * webhook sender gate, so routing keys off machine-sender and bulk markers
 * instead of `gate_match`.
 *
 * [COMP:brain/source-adapters/mailbox]
 */

export { normalizeMailboxMessage, mailboxEpisodeText } from './normalize.js'
export type { MailboxIngestMessage } from './normalize.js'
export { mailboxFilterImplementations, isMachineSenderAddress } from './filters.js'
