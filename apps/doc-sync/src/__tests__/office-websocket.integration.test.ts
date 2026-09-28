import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { Hocuspocus } from '@hocuspocus/server'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as Y from 'yjs'
import type { ResolvedOfficeAccess } from '@use-brian/api/office/access.js'
import { bridgeConnection } from '../ws-bridge.js'
import { revalidateOfficeRoom, type OfficeRoomDocument } from '../office-authority.js'

const room = 'office:00000000-0000-4000-8000-000000000001'
const access = (canEdit: boolean): ResolvedOfficeAccess => ({
  artifactId: room.slice('office:'.length), workspaceId: 'workspace', role: canEdit ? 'edit' : 'view',
  workspaceRole: 'member', lifecycleState: 'active', canView: true, canComment: canEdit,
  canEdit, canRestore: false, canDeletePermanently: false, canElevate: false, canManageSharing: false,
})

async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('[COMP:doc-sync/office-collab] actual Office WebSocket delivery', () => {
  const cleanup: Array<() => void | Promise<void>> = []
  afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose()
  })

  it('broadcasts to current peers, removes a revoked passive peer first, and blocks a downgraded writer', async () => {
    const grants = new Map<string, ResolvedOfficeAccess | null>([
      ['editor', access(true)],
      ['viewer', access(false)],
    ])
    const deps = {
      validateSession: async () => true,
      resolveAccess: async (userId: string) => grants.get(userId) ?? null,
    }
    const hocuspocus = new Hocuspocus({
      quiet: true,
      async onAuthenticate(data) {
        const userId = String(data.token)
        const current = grants.get(userId)
        if (!current) throw new Error('office_access_denied')
        data.connectionConfig.readOnly = !current.canEdit
        return { userId, sessionId: `session-${userId}`, authVersion: 1, office: true as const }
      },
      async beforeHandleMessage(data) {
        const results = await revalidateOfficeRoom({
          artifactId: room.slice('office:'.length),
          document: data.document as unknown as OfficeRoomDocument,
          deps,
        })
        if (results.get(data.connection as never) === 'denied') throw new Error('office_access_denied')
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
    await until(() => viewer.getMap('transport').get('value') === 1, 'authorized viewer missed update')

    grants.set('viewer', null)
    editor.getMap('transport').set('value', 2)
    await until(() => denied.includes('viewer:office-access-denied'), 'revoked viewer was not removed')
    expect(viewer.getMap('transport').get('value')).toBe(1)
    expect(hocuspocus.documents.get(room)?.getMap('transport').get('value')).toBe(2)

    grants.set('editor', access(false))
    editor.getMap('transport').set('value', 3)
    await until(() => denied.includes('editor:office-write-denied'), 'writer downgrade was not delivered')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(hocuspocus.documents.get(room)?.getMap('transport').get('value')).toBe(2)
  })
})
