export type { MailboxAccountSettings, MailboxPreset, MailboxVerifyResult } from './types.js'
export { resolveMailboxPreset, presetForMxHost } from './presets.js'
export { buildImapSearchQuery, compileKeywordOrTree, hasNonAsciiTerm } from './search-criteria.js'
export type { ImapSearchQuery } from './search-criteria.js'
export {
  createMailboxSessionCache,
  createImapClient,
  defaultMailboxSessionCache,
  MAILBOX_SESSION_IDLE_MS,
  MAILBOX_SESSION_MAX_LIFETIME_MS,
} from './imap-session.js'
export type { ImapClientLike, ImapFetchedMessage, MailboxSessionCache } from './imap-session.js'
export {
  createMailboxApi,
  messageRef,
  parseMessageRef,
  parseReferencesHeader,
  htmlToText,
} from './mailbox-api.js'
export type { CreateMailboxApiOptions } from './mailbox-api.js'
export { composeMailboxMessage, sendComposedMessage, sanitizeHeaderValue, verifySmtpLogin } from './smtp.js'
export type { ComposedMailboxMessage } from './smtp.js'
export { verifyMailboxConnection } from './verify.js'
export type { VerifyMailboxDeps } from './verify.js'
export {
  createMailboxSyncWorker,
  createMailboxBrainRouter,
  buildMailboxIngestEngine,
  parseSyncedMessage,
  readMailboxSyncState,
  backfillFloorDate,
} from './sync-worker.js'
export type {
  MailboxSyncWorker,
  MailboxSyncWorkerDeps,
  MailboxBrainRouter,
  MailboxBrainRouterDeps,
  MailboxBrainContext,
  MailboxSyncState,
  MailboxFolderCursor,
  MailboxBackfillScope,
  MailboxBackfillState,
} from './sync-worker.js'
export { probeMailboxFolders } from './probe.js'
export type { MailboxProbeResult } from './probe.js'
export {
  createSearchEmailArchiveTool,
  setGlobalMailboxArchiveDeps,
  getGlobalMailboxArchiveDeps,
} from './archive-search-tool.js'
export type { MailboxArchiveDeps, CreateArchiveSearchToolOptions } from './archive-search-tool.js'
