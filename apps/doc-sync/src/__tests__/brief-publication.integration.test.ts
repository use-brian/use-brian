/**
 * Brief publication against the actual Yjs/Hocuspocus path and PostgreSQL
 * (project-briefs.md -> "The publication barrier"). The Hocuspocus instance is
 * composed from the same modules the live server wires (persistence, the
 * clearance gate's RLS query and brief-guard). Runs only through
 * scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { applyOpsToYDoc, FRAGMENT_FIELD, healBlockIds, yDocToSnapshot } from '@use-brian/doc-model'
import { getAppPool, getPool, query } from '@use-brian/api/db/client.js'
import { createProjectSharedStore } from '@use-brian/api/db/project-shared-store.js'
import { ensureBrief, inspectBrief } from '@use-brian/api/briefs/service.js'
import { applyDirection, setBriefSyncClientForTests } from '@use-brian/api/briefs/publication.js'
import { bridgeConnection } from '../ws-bridge.js'
import { loadPageUpdate, type SysQuery } from '../persistence.js'
import {
  assertBriefDirection,
  BRIEF_PROTECTED_REASON,
  briefLayoutFor,
  directionChangedByOps,
  recoverBriefDocument,
  storePageSnapshotGuarded,
} from '../brief-guard.js'

const { assertLocalFixture } = await import(new URL('../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = getPool()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)
const sysQuery: SysQuery = (sql, params) => query(sql, params as unknown[]).then(r => r.rows as never[])
afterAll(async () => { await getAppPool().end(); await pool.end() })

async function until(predicate: () => boolean | Promise<boolean>, message: string, ms = 6_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

async function seed() {
  const workspaceId = randomUUID(), lead = randomUUID(), member = randomUUID()
  for (const id of [lead, member]) await q(`INSERT INTO users(id,auth_provider_id,name) VALUES($1,$2,'Fictional person')`, [id, id])
  await q(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional sync fixture',$2)`, [workspaceId, lead])
  await q(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','internal'),($1,$3,'member','internal')`, [workspaceId, lead, member])
  await q('UPDATE workspaces SET department_read_v2=true, project_shared_spaces=true WHERE id=$1', [workspaceId])
  const projectId = await createProjectSharedStore().create(lead, workspaceId, { name: 'Harbor', userIds: [member], assistantIds: [] })
  const actor = { userId: lead, workspaceId, assistantId: null }
  const { bindingId } = await ensureBrief(actor, { kind: 'project', id: projectId })
  setBriefSyncClientForTests(null)
  await applyDirection(actor, bindingId, { change: { sections: { rules: ['Accepted rule'] } }, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
  const view = await inspectBrief(actor, { bindingId })
  return { workspaceId, lead, member, projectId, bindingId, pageId: view.pageId!, view, actor }
}

const snapshotRegion = async (pageId: string) => {
  const row = (await q('SELECT snapshot_json, seq FROM documents WHERE page_id=$1', [pageId])).rows[0]
  return { blocks: row.snapshot_json.blocks as Array<{ id: string; text?: string }>, seq: Number(row.seq) }
}

describe('[COMP:doc-sync/brief-publication] Brief Direction on the live Yjs path', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

  async function startServer() {
    const hocuspocus = new Hocuspocus({
      quiet: true, debounce: 50, maxDebounce: 200, unloadImmediately: false,
      async onAuthenticate(data) { return { userId: String(data.token) } },
      async beforeSync(data) {
        if (data.type !== 0) {
          assertBriefDirection({ doc: data.document, type: data.type, update: data.payload,
            layout: await briefLayoutFor(data.documentName, sysQuery), connection: data.connection })
        }
      },
      async onLoadDocument(data) {
        const loaded = await loadPageUpdate({ pageId: data.documentName, query: sysQuery })
        const doc = data.document as unknown as Y.Doc
        if (loaded) Y.applyUpdate(doc, loaded.update)
        doc.transact(() => healBlockIds(doc.getXmlFragment(FRAGMENT_FIELD)))
        return data.document
      },
      async onStoreDocument(data) {
        await storePageSnapshotGuarded({ pageId: data.documentName, ydoc: data.document as unknown as Y.Doc, query: sysQuery })
      },
    })
    const server = createServer()
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => {
      bridgeConnection(hocuspocus.handleConnection(ws as never, request as never) as never, ws)
    }))
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(async () => {
      hocuspocus.closeConnections()
      await new Promise<void>(resolve => sockets.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('listener address unavailable')
    const stateless: string[] = []
    const closes: number[] = []
    const connect = async (userId: string, name: string, doc = new Y.Doc()) => {
      const socket = new HocuspocusProviderWebsocket({ url: `ws://127.0.0.1:${address.port}`, WebSocketPolyfill: WebSocket,
        autoConnect: false, delay: 10, minDelay: 10, maxDelay: 20, maxAttempts: 1 })
      let synced = false
      const provider = new HocuspocusProvider({ websocketProvider: socket, name, document: doc, token: userId,
        onSynced: () => { synced = true }, onStateless: ({ payload }) => stateless.push(`${userId}:${payload}`),
        onClose: ({ event }) => closes.push(event.code) })
      provider.attach()
      await socket.connect()
      await until(() => synced, `${userId} did not synchronize`)
      cleanup.push(() => { provider.destroy(); socket.destroy() })
      return doc
    }
    return { hocuspocus, connect, stateless, closes }
  }

  it('refuses a live or offline-replayed Direction edit before broadcast; Current context edits flow and persist', async () => {
    const f = await seed()
    const { hocuspocus, connect, stateless } = await startServer()
    const rule = f.view.directionBlocks!.rules[0].id
    const findings = f.view.binding.layout.sectionIds.findings
    const editor = await connect(f.lead, f.pageId)
    const watcher = await connect(f.member, f.pageId)
    // A Current-context edit is ordinary collaboration.
    applyOpsToYDoc(editor, [{ op: 'add', after: findings, block: { kind: 'text', id: randomUUID(), text: 'A finding' } }])
    await until(() => yDocToSnapshot(watcher).page.blocks.some(b => (b as { text?: string }).text === 'A finding'), 'context edit not delivered')
    await until(async () => (await snapshotRegion(f.pageId)).blocks.some(b => b.text === 'A finding'), 'context edit not persisted')
    // A Direction edit (typing over an accepted rule) is refused before integration.
    applyOpsToYDoc(editor, [{ op: 'edit', blockId: rule, patch: { text: 'Injected rule' } }])
    await until(() => stateless.includes(`${f.lead}:${BRIEF_PROTECTED_REASON}`), 'direction edit was not refused')
    await new Promise(resolve => setTimeout(resolve, 150))
    const live = hocuspocus.documents.get(f.pageId) as unknown as Y.Doc
    expect(yDocToSnapshot(live).page.blocks.find(b => b.id === rule)).toMatchObject({ text: 'Accepted rule' })
    expect(yDocToSnapshot(watcher).page.blocks.find(b => b.id === rule)).toMatchObject({ text: 'Accepted rule' })
    expect((await snapshotRegion(f.pageId)).blocks.find(b => b.id === rule)).toMatchObject({ text: 'Accepted rule' })
    // An offline client replaying a stale Direction edit on reconnect is refused the same way.
    const offline = new Y.Doc()
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(live))
    applyOpsToYDoc(offline, [{ op: 'delete', blockId: rule }])
    await connect(f.member, f.pageId, offline).catch(() => undefined)
    await until(() => stateless.includes(`${f.member}:${BRIEF_PROTECTED_REASON}`), 'offline replay was not refused')
    expect(yDocToSnapshot(live).page.blocks.some(b => b.id === rule)).toBe(true)
  })

  it('a publication reaches live tabs through the post-commit merge, and self-heals when the notice is missed', async () => {
    const f = await seed()
    const { hocuspocus, connect } = await startServer()
    const watcher = await connect(f.member, f.pageId)
    const live = hocuspocus.documents.get(f.pageId) as unknown as Y.Doc
    // Owner applies through the API while the page is live (the notice is delivered).
    setBriefSyncClientForTests({ syncBrief: async pageId => recoverBriefDocument({ pageId, ydoc: live, query: sysQuery }) })
    await applyDirection(f.actor, f.bindingId, { change: { sections: { outcome: ['Live outcome'] } }, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    await until(() => yDocToSnapshot(watcher).page.blocks.some(b => (b as { text?: string }).text === 'Live outcome'), 'publication not broadcast')
    // Missed notice: the next store is refused by the guard trigger, then recovers.
    setBriefSyncClientForTests({ syncBrief: async () => false })
    await applyDirection(f.actor, f.bindingId, { change: { sections: { decisions: ['Missed-notice decision'] } }, expectedDirectionRevision: 2, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    expect(yDocToSnapshot(live).page.blocks.some(b => (b as { text?: string }).text === 'Missed-notice decision')).toBe(false)
    applyOpsToYDoc(watcher, [{ op: 'add', after: f.view.binding.layout.sectionIds.questions, block: { kind: 'text', id: randomUUID(), text: 'Open question' } }])
    await until(() => yDocToSnapshot(watcher).page.blocks.some(b => (b as { text?: string }).text === 'Missed-notice decision'), 'missed publication not recovered')
    await until(async () => {
      const stored = await snapshotRegion(f.pageId)
      return stored.blocks.some(b => b.text === 'Open question') && stored.blocks.some(b => b.text === 'Missed-notice decision')
    }, 'recovered state not persisted')
    expect((await inspectBrief(f.actor, { bindingId: f.bindingId })).direction!.decisions).toEqual(['Missed-notice decision'])
    setBriefSyncClientForTests(undefined)
  })

  it('the internal apply guard refuses an op batch that would change Direction and admits context ops', async () => {
    const f = await seed()
    const doc = new Y.Doc()
    const loaded = await loadPageUpdate({ pageId: f.pageId, query: sysQuery })
    Y.applyUpdate(doc, loaded!.update)
    const layout = await briefLayoutFor(f.pageId, sysQuery)
    expect(layout).not.toBeNull()
    const rule = f.view.directionBlocks!.rules[0].id
    expect(directionChangedByOps(doc, [{ op: 'edit', blockId: rule, patch: { text: 'Brian rewrite' } }], layout!)).toBe(true)
    expect(directionChangedByOps(doc, [{ op: 'move', blockId: rule, after: f.view.binding.layout.sectionIds.findings }], layout!)).toBe(true)
    expect(directionChangedByOps(doc, [{ op: 'add', after: f.view.binding.layout.sectionIds.references, block: { kind: 'text', id: randomUUID(), text: 'ref' } }], layout!)).toBe(false)
    // An ordinary page has no Brief layout and is never inspected.
    expect(await briefLayoutFor(randomUUID(), sysQuery)).toBeNull()
  })
})
