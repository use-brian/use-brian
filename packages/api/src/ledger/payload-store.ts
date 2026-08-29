/**
 * Ledger payload store — content-addressed bytes behind the turn ledger.
 *
 * Composes the SAME storage abstraction the file system already uses
 * (`GcsFilesClient`: real GCS on hosted, `createLocalFilesClient` on
 * self-host, BYO bucket via the resolver), so "both drivers" is the
 * existing boot-time choice, not new code paths. Keys are
 * `ledger/<scope>/<hash>` where scope is the workspace id or 'global' —
 * identical content in two workspaces never shares an object (privacy
 * over dedup, plan §4).
 *
 * Ordering contract (the files-api precedent): the OBJECT write lands
 * before the INDEX row insert, so a row in turn_payloads always points at
 * bytes that exist.
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 * [COMP:api/ledger-payload-store]
 */

import { createHash } from 'node:crypto'
import type { GcsFilesClient } from '../files/gcs-client.js'
import {
  getPayloadIndexRow,
  insertPayloadIndex,
  markPayloadsErased,
  payloadExists,
  payloadScope,
} from '../db/turn-ledger-store.js'

export type LedgerPayloadStore = {
  /**
   * Content-address `content` and persist it (skipping the object write
   * when the hash already exists for this scope). Returns the hash ref.
   */
  put(args: {
    workspaceId?: string | null
    content: string
    mediaType?: string
    sensitivity?: string
  }): Promise<string>
  /**
   * Resolve a hash to its bytes. Returns `{ erased: true }` for a
   * tombstoned payload (plan §7 — explicit marker, never silent absence),
   * null for an unknown hash.
   */
  get(
    workspaceId: string | null | undefined,
    hash: string,
  ): Promise<{ content: string; mediaType: string } | { erased: true } | null>
  /** Erasure cascade: tombstone index rows, delete the objects. */
  erase(workspaceId: string | null | undefined, hashes: string[]): Promise<number>
}

export function hashPayload(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export function ledgerStorageKey(workspaceId: string | null | undefined, hash: string): string {
  return `ledger/${payloadScope(workspaceId)}/${hash}`
}

export function createLedgerPayloadStore(files: GcsFilesClient): LedgerPayloadStore {
  return {
    async put({ workspaceId, content, mediaType = 'application/json', sensitivity }) {
      const hash = hashPayload(content)
      if (await payloadExists(workspaceId, hash)) return hash
      const key = ledgerStorageKey(workspaceId, hash)
      const bytes = Buffer.from(content, 'utf8')
      await files.writeBlob(key, bytes, {
        workspaceId: payloadScope(workspaceId),
        mime: mediaType,
      })
      await insertPayloadIndex({
        workspaceId: workspaceId ?? null,
        hash,
        byteSize: bytes.byteLength,
        mediaType,
        storageRef: key,
        sensitivity,
      })
      return hash
    },

    async get(workspaceId, hash) {
      const row = await getPayloadIndexRow(workspaceId, hash)
      if (!row) return null
      if (row.erasedAt) return { erased: true }
      const blob = await files.readBlob(row.storageRef)
      if (!blob) return null
      return { content: blob.bytes.toString('utf8'), mediaType: row.mediaType }
    },

    async erase(workspaceId, hashes) {
      const refs = await markPayloadsErased(workspaceId, hashes)
      for (const ref of refs) {
        try {
          await files.deleteBlob(ref)
        } catch (err) {
          console.warn(
            `[turn-ledger] erase: deleteBlob(${ref}) failed (tombstone already stamped): ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      return refs.length
    },
  }
}
