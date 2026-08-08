/**
 * Cheap mailbox probe — per-folder STATUS counts over a short-lived IMAP
 * session. This is the D9 pre-flight: ~1s of STATUS commands, never the
 * expensive work itself. The backfill consent UI quotes these counts before
 * any fetch/embedding spend is committed.
 *
 * [COMP:api/mailbox-connect-routes]
 */

import { createImapClient, syncableFolders, type ImapClientLike } from './imap-session.js'
import type { MailboxAccountSettings } from './types.js'

export type MailboxProbeResult = {
  folders: Array<{ path: string; messages: number }>
  total: number
}

export async function probeMailboxFolders(
  settings: MailboxAccountSettings,
  createClient: (s: MailboxAccountSettings) => ImapClientLike = createImapClient,
): Promise<MailboxProbeResult> {
  const client = createClient(settings)
  await client.connect()
  try {
    const syncable = syncableFolders(await client.list())
    const folders: Array<{ path: string; messages: number }> = []
    for (const f of syncable) {
      try {
        const status = await client.status(f.path, { messages: true, uidNext: true, uidValidity: true })
        folders.push({ path: f.path, messages: status.messages ?? 0 })
      } catch {
        // A non-STATUSable folder (e.g. \Noselect) is skipped, never fatal.
      }
    }
    return { folders, total: folders.reduce((sum, f) => sum + f.messages, 0) }
  } finally {
    try {
      await client.logout()
    } catch {
      client.close()
    }
  }
}
