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
  /** Listed or previously known folders that STATUS could not count on this pass. */
  failedFolders: Array<{ path: string }>
  /** True only when every listed or previously known syncable folder contributed to `total`. */
  complete: boolean
  /** Sum of successful folder counts; never presented as complete when false. */
  total: number
}

export async function probeMailboxFolders(
  settings: MailboxAccountSettings,
  createClient: (s: MailboxAccountSettings) => ImapClientLike = createImapClient,
  knownFolderPaths: readonly string[] = [],
): Promise<MailboxProbeResult> {
  const client = createClient(settings)
  await client.connect()
  try {
    const syncable = syncableFolders(await client.list())
    // LIST is normally authoritative, but some enterprise servers have
    // returned a temporarily truncated folder universe while the same paths
    // remained directly addressable. The durable cursor roster lets the cheap
    // probe recover those folders by path instead of blessing the truncated
    // LIST sum as the whole mailbox.
    const paths = [...new Set([
      ...syncable.map((folder) => folder.path),
      ...knownFolderPaths.filter((path) => path.length > 0),
    ])]
    const folders: Array<{ path: string; messages: number }> = []
    const failedFolders: Array<{ path: string }> = []
    for (const path of paths) {
      try {
        const status = await client.status(path, { messages: true, uidNext: true, uidValidity: true })
        folders.push({ path, messages: status.messages ?? 0 })
      } catch {
        // LIST succeeded but this folder did not contribute to the estimate.
        // Preserve that fact: silently summing the survivors produced an
        // archived-count versus tiny partial-total progress lie on an
        // intermittently reachable mailbox. Non-selectable LIST containers
        // were already removed by syncableFolders(), so this is a real
        // incomplete probe.
        failedFolders.push({ path })
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
