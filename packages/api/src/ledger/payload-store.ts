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
  getPayloadIndexStates,
  insertPayloadIndexes,
  markPayloadsErased,
  payloadScope,
  PAYLOAD_INDEX_BATCH_SIZE,
  type PayloadIndexInsert,
} from '../db/turn-ledger-store.js'

export type LedgerPayloadInput = {
  workspaceId?: string | null
  content: string
  mediaType?: string
  sensitivity?: string
}

export type LedgerPayloadStore = {
  /**
   * Content-address `content` and persist it (skipping the object write
   * when the hash already exists for this scope). Returns the hash ref.
   */
  put(args: LedgerPayloadInput): Promise<string>
  /** Ordered references, with bounded set-wise index work per workspace. */
  putMany?(args: LedgerPayloadInput[]): Promise<string[]>
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
  const putMany = async (args: LedgerPayloadInput[]): Promise<string[]> => {
    const refs = args.map((p) => hashPayload(p.content))
    const groups = new Map<string, Map<string, LedgerPayloadInput>>()
    args.forEach((p, i) => {
      const scope = payloadScope(p.workspaceId)
      let group = groups.get(scope)
      if (!group) groups.set(scope, group = new Map())
      if (!group.has(refs[i])) group.set(refs[i], p)
    })
    for (const group of groups.values()) {
      const entries = [...group.entries()]
      for (let offset = 0; offset < entries.length; offset += PAYLOAD_INDEX_BATCH_SIZE) {
        const batch = entries.slice(offset, offset + PAYLOAD_INDEX_BATCH_SIZE)
        const workspaceId = batch[0][1].workspaceId
        const existing = new Set((await getPayloadIndexStates(workspaceId, batch.map(([hash]) => hash))).map((r) => r.hash))
        const written: PayloadIndexInsert[] = []
        let failed = false
        let failure: unknown
        for (const [hash, p] of batch) {
          if (existing.has(hash)) continue
          const key = ledgerStorageKey(workspaceId, hash)
          const bytes = Buffer.from(p.content, 'utf8')
          try {
            await files.writeBlob(key, bytes, { workspaceId: payloadScope(workspaceId), mime: p.mediaType ?? 'application/json' })
          } catch (err) {
            failed = true
            failure = err
            break
          }
          written.push({ workspaceId, hash, byteSize: bytes.byteLength, mediaType: p.mediaType ?? 'application/json', storageRef: key, sensitivity: p.sensitivity })
        }
        const inserted = new Set(await insertPayloadIndexes(written))
        const conflicts = written.filter((p) => !inserted.has(p.hash))
        if (conflicts.length) {
          const states = await getPayloadIndexStates(workspaceId, conflicts.map((p) => p.hash))
          for (const row of states) {
            if (row.erasedAt) await files.deleteBlob(ledgerStorageKey(workspaceId, row.hash))
          }
        }
        if (failed) throw failure
      }
    }
    return refs
  }
  return {
    putMany,
    async put(args) { return (await putMany([args]))[0] },

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
