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
  /** Folders LIST returned but STATUS could not count on this pass. */
  failedFolders: Array<{ path: string }>
  /** True only when every syncable folder contributed to `total`. */
  complete: boolean
  /** Sum of successful folder counts; never presented as complete when false. */
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
    const failedFolders: Array<{ path: string }> = []
    for (const f of syncable) {
      try {
        const status = await client.status(f.path, { messages: true, uidNext: true, uidValidity: true })
        folders.push({ path: f.path, messages: status.messages ?? 0 })
      } catch {
        // LIST succeeded but this folder did not contribute to the estimate.
        // Preserve that fact: silently summing the survivors produced the
        // an archived count versus a tiny partial-total progress lie on an
        // intermittently reachable mailbox. Non-selectable LIST containers
        // were already removed by syncableFolders(), so this is a real
        // incomplete probe.
        failedFolders.push({ path: f.path })
      }
    }
    return {
      folders,
      failedFolders,
      complete: failedFolders.length === 0,
      total: folders.reduce((sum, f) => sum + f.messages, 0),
    }
  } finally {
    try {
      await client.logout()
    } catch {
      client.close()
    }
  }
}
