/** Real PostgreSQL index and local object receiving boundary. Spec: turn-ledger.md. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { query } from '../../db/client.js'
import { createLocalFilesClient } from '../../files/local-files-client.js'
import { createLedgerPayloadStore, hashPayload } from '../payload-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const baseDir = await mkdtemp(join(tmpdir(), 'ledger-batch-'))
afterAll(() => rm(baseDir, { recursive: true, force: true }))
const files = () => createLocalFilesClient({ baseDir, apiUrl: 'http://localhost:3001', signingSecret: 'fictional-ledger-batch' })

describe('[COMP:api/ledger-payload-store] bounded native payload capture', () => {
  it('persists a thousand ordered messages, duplicate hashes, scope isolation and erased rows', async () => {
    const workspaceId = randomUUID()
    const store = createLedgerPayloadStore(files())
    const messages = Array.from({ length: 1000 }, (_, n) => ({ workspaceId, content: `fictional message ${n}` }))
    const refs = await store.putMany!([...messages, messages[0]])
    expect(refs).toEqual([...messages, messages[0]].map((p) => hashPayload(p.content)))
    expect((await query<{ count: string }>('SELECT count(*) FROM turn_payloads WHERE scope = $1', [workspaceId])).rows[0].count).toBe('1000')
    expect(await store.get(workspaceId, refs[999])).toMatchObject({ content: messages[999].content })
    await store.erase(workspaceId, [refs[0]])
    await store.putMany!(messages)
    expect(await store.get(workspaceId, refs[0])).toEqual({ erased: true })
    const other = randomUUID()
    await store.putMany!([{ ...messages[0], workspaceId: other }])
    expect(await store.get(other, refs[0])).toMatchObject({ content: messages[0].content })
  })

  it('indexes confirmed prefix bytes when a later object write fails', async () => {
    const workspaceId = randomUUID()
    const client = files()
    const write = client.writeBlob.bind(client)
    client.writeBlob = async (...args) => {
      if (args[0].endsWith(hashPayload('failure'))) throw new Error('injected blob failure')
      return write(...args)
    }
    const store = createLedgerPayloadStore(client)
    await expect(store.putMany!(['prefix', 'failure', 'unattempted'].map((content) => ({ workspaceId, content })))).rejects.toThrow('injected blob failure')
    expect(await store.get(workspaceId, hashPayload('prefix'))).toMatchObject({ content: 'prefix' })
    expect(await store.get(workspaceId, hashPayload('failure'))).toBeNull()
    expect(await store.get(workspaceId, hashPayload('unattempted'))).toBeNull()
  })

  it('retains a real concurrent erased conflict and removes newly written bytes', async () => {
    const workspaceId = randomUUID()
    const client = files()
    const write = client.writeBlob.bind(client)
    client.writeBlob = async (...args) => {
      await write(...args)
      await query(`INSERT INTO turn_payloads(scope, hash, workspace_id, byte_size, storage_ref, erased_at)
        VALUES($1::text,$2,$1::text::uuid,5,$3,now())`, [workspaceId, hashPayload('raced'), args[0]])
    }
    const store = createLedgerPayloadStore(client)
    await store.putMany!([{ workspaceId, content: 'raced' }])
    expect(await store.get(workspaceId, hashPayload('raced'))).toEqual({ erased: true })
    expect(await client.readBlob(`ledger/${workspaceId}/${hashPayload('raced')}`)).toBeNull()
  })
})
