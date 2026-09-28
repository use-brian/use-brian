import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import { bridgeConnection } from '../ws-bridge.js'
import {
  assertPageAccess,
  isReadOnlyRole,
  PAGE_ACCESS_SQL,
  PAGE_ROLE_SQL,
  revalidatePageRoom,
  type PageRoomDocument,
  type RlsQuery,
} from '../clearance-gate.js'

const room = '00000000-0000-4000-8000-000000000001'

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('[COMP:doc-sync/clearance-gate] actual page WebSocket delivery', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  it('delivers to current readers, removes a revoked passive peer, and blocks a read-only writer', async () => {
    const grants = new Map<string, 'write' | 'read' | null>([
      ['editor', 'write'],
      ['viewer', 'read'],
    ])
    const query = (async (userId: string, sql: string) => {
      const grant = grants.get(userId)
      if (sql === PAGE_ACCESS_SQL) return (grant ? [{
        workspaceId: 'workspace', pageClearance: 'internal', memberClearance: 'internal',
        teamspaceSensitivity: 'internal', canMutate: grant === 'write',
      }] : []) as never[]
      if (sql === PAGE_ROLE_SQL) return [{ role: 'edit' }] as never[]
      throw new Error('unexpected query')
    }) as RlsQuery
    const deps = { query, validateSession: async () => true }
    const hocuspocus = new Hocuspocus({
      quiet: true,
      async onAuthenticate(data) {
        const userId = String(data.token)
        const access = await assertPageAccess({ userId, pageId: room, query })
        data.connectionConfig.readOnly = isReadOnlyRole(access.role)
        return { userId, sessionId: `session-${userId}`, authVersion: 1 }
      },
      async beforeHandleMessage(data) {
        const results = await revalidatePageRoom({
          pageId: room,
          document: data.document as unknown as PageRoomDocument,
          deps,
        })
        if (results.get(data.connection as never) === 'denied') throw new Error('page_access_denied')
      },
      async onLoadDocument(data) {
        data.document.getMap('transport').set('value', 0)
        return data.document
      },
    })
    const server = createServer()
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => sockets.handleUpgrade(request, socket, head, ws => {
      bridgeConnection(hocuspocus.handleConnection(ws as never, request as never) as never, ws)
    }))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    cleanup.push(async () => {
      hocuspocus.closeConnections()
      await new Promise<void>(resolve => sockets.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('listener address unavailable')

    const denied: string[] = []
    const connect = async (userId: string) => {
      const doc = new Y.Doc()
      const socket = new HocuspocusProviderWebsocket({
        url: `ws://127.0.0.1:${address.port}`,
        WebSocketPolyfill: WebSocket,
        autoConnect: false,
        delay: 10,
        minDelay: 10,
        maxDelay: 20,
        maxAttempts: 1,
      })
      let synced = false
      const provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: room,
        document: doc,
        token: userId,
        onSynced: () => { synced = true },
        onStateless: ({ payload }) => denied.push(`${userId}:${payload}`),
      })
      provider.attach()
      await socket.connect()
      await until(() => synced, `${userId} did not synchronize`)
      cleanup.push(() => { provider.destroy(); socket.destroy(); doc.destroy() })
      return doc
    }

    const editor = await connect('editor')
    const viewer = await connect('viewer')
    editor.getMap('transport').set('value', 1)
    await until(() => viewer.getMap('transport').get('value') === 1, 'authorized reader missed update')

    grants.set('viewer', null)
    editor.getMap('transport').set('value', 2)
    await until(() => denied.includes('viewer:page-access-denied'), 'revoked reader was not removed')
    expect(viewer.getMap('transport').get('value')).toBe(1)
    expect(hocuspocus.documents.get(room)?.getMap('transport').get('value')).toBe(2)

    grants.set('editor', 'read')
    editor.getMap('transport').set('value', 3)
    await until(() => denied.includes('editor:page-write-denied'), 'writer downgrade was not delivered')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(hocuspocus.documents.get(room)?.getMap('transport').get('value')).toBe(2)
  })
})
