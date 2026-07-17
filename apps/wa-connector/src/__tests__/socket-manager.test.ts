/**
 * Unit tests for the Baileys socket lifecycle manager.
 * Component tag: [COMP:wa-connector/socket-manager].
 *
 * Mocks Baileys (makeWASocket → a fake EventEmitter-backed socket) and
 * the GCS auth-state module. Verifies connect() socket creation +
 * status, the connection.update transitions (qr_pending / connected),
 * the connect-replaces-existing close, send() (not-connected guard +
 * messageId), disconnect() registry cleanup + optional cred deletion,
 * and restoreAll() fan-out.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

type FakeSocket = {
  ev: EventEmitter
  end: ReturnType<typeof vi.fn>
  sendMessage: ReturnType<typeof vi.fn>
  sendPresenceUpdate: ReturnType<typeof vi.fn>
  readMessages: ReturnType<typeof vi.fn>
  user: { id: string }
  signalRepository: { lidMapping: { getPNForLID: ReturnType<typeof vi.fn> } }
}

const fakeSockets: FakeSocket[] = []

function makeFakeSocket(): FakeSocket {
  const s: FakeSocket = {
    ev: new EventEmitter(),
    end: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamsg-1' } }),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    user: { id: '15551234567:7@s.whatsapp.net' },
    signalRepository: { lidMapping: { getPNForLID: vi.fn().mockResolvedValue(null) } },
  }
  fakeSockets.push(s)
  return s
}

vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  // Keep the real pure message-parser helpers (extractMessageContent /
  // getContentType / normalizeMessageContent) so driving a real inbound text
  // message through handleInboundMessage works; override only the socket factory
  // and network-touching exports.
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>()
  return {
    ...actual,
    makeWASocket: vi.fn(() => makeFakeSocket()),
    fetchLatestBaileysVersion: vi.fn().mockResolvedValue({ version: [2, 3000, 0] }),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    DisconnectReason: { loggedOut: 401 },
    downloadMediaMessage: vi.fn(),
  }
})

vi.mock('../gcs-auth-state.js', () => ({
  useGCSAuthState: vi.fn().mockResolvedValue({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() }),
  authStateExists: vi.fn(),
  deleteAuthState: vi.fn().mockResolvedValue(undefined),
  listStoredChannels: vi.fn().mockResolvedValue([]),
  waitForCredsSaveQueue: vi.fn().mockResolvedValue(undefined),
}))

import { createSocketManager } from '../socket-manager.js'
import { listStoredChannels, deleteAuthState } from '../gcs-auth-state.js'

const mockListStored = vi.mocked(listStoredChannels)
const mockDeleteAuth = vi.mocked(deleteAuthState)

function manager() {
  return createSocketManager({
    bucket: {} as never,
    pool: null,
    apiUrl: 'http://api.test',
    connectorSecret: 'secret',
  })
}

beforeEach(() => {
  fakeSockets.length = 0
  vi.clearAllMocks()
  mockListStored.mockResolvedValue([])
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:wa-connector/socket-manager] connect + connection lifecycle', () => {
  it('creates a socket in the connecting state and registers it', async () => {
    const mgr = manager()
    const managed = await mgr.connect('a-1')
    expect(managed.status).toBe('connecting')
    expect(mgr.getStatus('a-1')).toBe(managed)
  })

  it('transitions to qr_pending and notifies the onQr listener', async () => {
    const mgr = manager()
    const onQr = vi.fn()
    await mgr.connect('a-1', { onQr })
    fakeSockets[0].ev.emit('connection.update', { qr: 'QR-CODE-DATA' })
    expect(mgr.getStatus('a-1')?.status).toBe('qr_pending')
    expect(onQr).toHaveBeenCalledWith('QR-CODE-DATA')
  })

  it('transitions to connected and reports the phone number on connection open', async () => {
    const mgr = manager()
    const onConnected = vi.fn()
    await mgr.connect('a-1', { onConnected })
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    expect(mgr.getStatus('a-1')?.status).toBe('connected')
    expect(onConnected).toHaveBeenCalledWith('15551234567')
  })

  it('ends the previous socket when connect is called again for the same assistant', async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    await mgr.connect('a-1')
    expect(fakeSockets[0].end).toHaveBeenCalled()
    expect(fakeSockets).toHaveLength(2)
  })

  it('a connect-replace does NOT reconnect the replaced socket (QR-retry storm guard)', async () => {
    vi.useFakeTimers()
    try {
      const mgr = manager()
      await mgr.connect('a-1') // socket 0
      await mgr.connect('a-1') // socket 1 replaces 0 (0 marked intentionalClose)
      expect(fakeSockets).toHaveLength(2)
      // The replaced socket 0 now emits its close (a generic, non-401/440 one).
      // Pre-fix this scheduled a 2s reconnect that raced socket 1 into a storm.
      fakeSockets[0].ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 500 } } },
      })
      await vi.advanceTimersByTimeAsync(5000) // past the reconnect backoff
      expect(fakeSockets).toHaveLength(2) // no phantom reconnect socket
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('[COMP:wa-connector/socket-manager] send', () => {
  it('throws when there is no connected socket for the assistant', async () => {
    const mgr = manager()
    await expect(mgr.send('ghost', 'jid@s', { text: 'hi' })).rejects.toThrow(/No active/)
  })

  it('sends a message through a connected socket and returns the message id', async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    const out = await mgr.send('a-1', 'jid@s.whatsapp.net', { text: 'hello' })
    expect(out.messageId).toBe('wamsg-1')
    expect(fakeSockets[0].sendMessage).toHaveBeenCalledWith('jid@s.whatsapp.net', { text: 'hello' })
  })
})

describe('[COMP:wa-connector/socket-manager] channel aliases (auto / pn:)', () => {
  it("'auto' resolves the single connected channel", async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    const out = await mgr.send('auto', 'jid@s.whatsapp.net', { text: 'hi' })
    expect(out.messageId).toBe('wamsg-1')
    expect(fakeSockets[0].sendMessage).toHaveBeenCalled()
  })

  it("'auto' throws when no channel is connected", async () => {
    const mgr = manager()
    await mgr.connect('a-1') // still connecting, never opens
    await expect(mgr.send('auto', 'jid@s', { text: 'hi' })).rejects.toThrow(/no connected/)
  })

  it("'auto' throws with the candidates when several channels are connected", async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    await mgr.connect('a-2')
    fakeSockets[1].ev.emit('connection.update', { connection: 'open' })
    await expect(mgr.send('auto', 'jid@s', { text: 'hi' })).rejects.toThrow(/ambiguous.*a-1.*a-2/)
  })

  it("'pn:<digits>' resolves the connected channel with that paired number", async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].user.id = '85211111111:1@s.whatsapp.net'
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    await mgr.connect('a-2')
    fakeSockets[1].user.id = '85257153090:3@s.whatsapp.net'
    fakeSockets[1].ev.emit('connection.update', { connection: 'open' })

    await mgr.send('pn:+852 5715 3090', 'jid@s.whatsapp.net', { text: 'hi' })
    expect(fakeSockets[1].sendMessage).toHaveBeenCalled()
    expect(fakeSockets[0].sendMessage).not.toHaveBeenCalled()
  })

  it("'pn:<digits>' throws when no connected channel matches", async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    await expect(mgr.send('pn:85299999999', 'jid@s', { text: 'hi' })).rejects.toThrow(
      /no connected channel with that phone number/,
    )
  })

  it("a channel literally named 'auto' wins over the alias", async () => {
    const mgr = manager()
    await mgr.connect('auto')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    await mgr.connect('a-2')
    fakeSockets[1].ev.emit('connection.update', { connection: 'open' })
    // Two connected channels, but the exact-id match short-circuits the alias.
    const out = await mgr.send('auto', 'jid@s.whatsapp.net', { text: 'hi' })
    expect(out.messageId).toBe('wamsg-1')
    expect(fakeSockets[0].sendMessage).toHaveBeenCalled()
  })

  it('listConnections reports every socket with its live state', async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    await mgr.connect('a-2') // never opens
    const conns = mgr.listConnections()
    expect(conns).toHaveLength(2)
    const byId = Object.fromEntries(conns.map((c) => [c.channelId, c]))
    expect(byId['a-1']).toMatchObject({ status: 'connected', phoneNumber: '15551234567' })
    expect(byId['a-2'].status).toBe('connecting')
  })
})

describe('[COMP:wa-connector/socket-manager] disconnect + restore', () => {
  it('disconnect ends the socket and drops it from the registry', async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    await mgr.disconnect('a-1')
    expect(fakeSockets[0].end).toHaveBeenCalled()
    expect(mgr.getStatus('a-1')).toBeUndefined()
  })

  it('disconnect with deleteCreds wipes the stored auth state', async () => {
    const mgr = manager()
    await mgr.connect('a-1')
    await mgr.disconnect('a-1', true)
    expect(mockDeleteAuth).toHaveBeenCalledOnce()
  })

  it('restoreAll re-creates a socket for every stored channel', async () => {
    mockListStored.mockResolvedValueOnce(['a-1', 'a-2'])
    const mgr = manager()
    await mgr.restoreAll()
    expect(mgr.getStatus('a-1')?.channelId).toBe('a-1')
    expect(mgr.getStatus('a-2')?.channelId).toBe('a-2')
  })

  it('on a 401 logout: purges creds and notifies the API /disconnected endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    })
    await Promise.resolve()
    expect(mockDeleteAuth).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://api.test/internal/whatsapp/disconnected',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(mgr.getStatus('a-1')).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('[COMP:wa-connector/dedup-store] outbound self-echo suppression', () => {
  /** Connect + open a socket so send()/inbound work. */
  async function connected() {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    return mgr
  }

  /** Emit one inbound text message and drain the async handler microtasks. */
  async function emitInbound(opts: { id: string; fromMe: boolean }) {
    fakeSockets[0].ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id: opts.id, remoteJid: '1234@s.whatsapp.net', fromMe: opts.fromMe },
          message: { conversation: 'hello' },
          messageTimestamp: 1_700_000_000,
          pushName: 'Someone',
        },
      ],
    })
    // Drain the async messages.upsert handler (forward) across a
    // few hops to be safe.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }

  /** The forward POST to the inbound relay, if any was made. */
  function inboundForwards(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(
      (c) => String(c[0]) === 'http://api.test/internal/whatsapp/inbound',
    )
  }

  /**
   * Emit one upsert whose `message` is empty — the shape of an undecryptable
   * delivery (Bad MAC). Same id as a later decrypted re-delivery.
   */
  async function emitUndecryptable(id: string) {
    fakeSockets[0].ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id, remoteJid: '1234@s.whatsapp.net', fromMe: false },
          message: null,
          messageTimestamp: 1_700_000_000,
          pushName: 'Someone',
        },
      ],
    })
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }

  it('forwards the decrypted re-delivery after earlier undecryptable attempts (no dedup poisoning)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const mgr = await connected()
    void mgr

    // WhatsApp re-delivers a settling message several times: empty (Bad MAC)
    // first, decrypted last. The empty attempts must NOT claim the dedup key.
    await emitUndecryptable('settling-1')
    await emitUndecryptable('settling-1')
    expect(inboundForwards(fetchMock)).toHaveLength(0) // nothing to forward yet

    await emitInbound({ id: 'settling-1', fromMe: false }) // decrypted arrival
    expect(inboundForwards(fetchMock)).toHaveLength(1) // gets through

    // A genuine duplicate of the now-forwarded message is suppressed.
    await emitInbound({ id: 'settling-1', fromMe: false })
    expect(inboundForwards(fetchMock)).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('drops a bot-sent message echoing back as fromMe (recorded at send time)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const mgr = await connected()

    // send() returns the fake socket id 'wamsg-1' and records it.
    const { messageId } = await mgr.send('a-1', '1234@s.whatsapp.net', { text: 'reply' })
    expect(messageId).toBe('wamsg-1')

    await emitInbound({ id: 'wamsg-1', fromMe: true })
    expect(inboundForwards(fetchMock)).toHaveLength(0) // suppressed
    vi.unstubAllGlobals()
  })

  it('forwards a fromMe HUMAN message that was never recorded (not a bot send)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const mgr = await connected()

    // A message typed from the connected companion phone: fromMe, but its id
    // was never recorded by send() — it must still be ingested.
    await emitInbound({ id: 'human-typed-1', fromMe: true })
    expect(inboundForwards(fetchMock)).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('forwards a previously-recorded id once it has aged out of the TTL window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const t0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const mgr = await connected()

    await mgr.send('a-1', '1234@s.whatsapp.net', { text: 'reply' }) // records 'wamsg-1' at t0

    // Jump past the 10-minute TTL; the recorded id is now stale.
    nowSpy.mockReturnValue(t0 + 10 * 60 * 1000 + 1)
    await emitInbound({ id: 'wamsg-1', fromMe: true })
    expect(inboundForwards(fetchMock)).toHaveLength(1) // no longer suppressed

    nowSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('[COMP:wa-connector/socket-manager] append messages (owner self-sends)', () => {
  async function connected() {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    return mgr
  }

  function inboundForwards(fetchMock: ReturnType<typeof vi.fn>) {
    return fetchMock.mock.calls.filter(
      (c) => String(c[0]) === 'http://api.test/internal/whatsapp/inbound',
    )
  }

  /**
   * Emit one `append`-typed upsert — the path WhatsApp uses to sync messages
   * the owner typed from their own phone to a companion device. `tsMs` is the
   * message time; the handler keeps only fromMe appends fresher than
   * APPEND_MAX_AGE_MS (5 min) so a reconnect history replay can't flood.
   */
  async function emitAppend(opts: { id: string; fromMe: boolean; tsMs: number }) {
    fakeSockets[0].ev.emit('messages.upsert', {
      type: 'append',
      messages: [
        {
          key: {
            id: opts.id,
            remoteJid: '120363000000000000@g.us',
            fromMe: opts.fromMe,
            participant: '85299999999@s.whatsapp.net',
          },
          message: { conversation: 'our team standup is every monday 10am' },
          messageTimestamp: Math.floor(opts.tsMs / 1000),
          pushName: 'Owner',
        },
      ],
    })
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }

  it('forwards a recent fromMe append (owner typing from their own phone)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const t0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const mgr = await connected()
    void mgr

    await emitAppend({ id: 'own-recent', fromMe: true, tsMs: t0 - 1000 })
    expect(inboundForwards(fetchMock)).toHaveLength(1)

    nowSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('drops a non-fromMe append (not the owner — history/other-device sync)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const t0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const mgr = await connected()
    void mgr

    await emitAppend({ id: 'other-append', fromMe: false, tsMs: t0 - 1000 })
    expect(inboundForwards(fetchMock)).toHaveLength(0)

    nowSpy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('drops a stale fromMe append beyond the recency window (replay-flood guard)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    const t0 = 1_700_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0)
    const mgr = await connected()
    void mgr

    await emitAppend({ id: 'own-stale', fromMe: true, tsMs: t0 - 10 * 60 * 1000 })
    expect(inboundForwards(fetchMock)).toHaveLength(0)

    nowSpy.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('[COMP:wa-connector/media-routing] inbound media relay routing', () => {
  async function connected() {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    return mgr
  }

  /** Emit one inbound media message and drain the async handler. */
  async function emitMedia(message: Record<string, unknown>, id = 'media-1') {
    fakeSockets[0].ev.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { id, remoteJid: '1234@s.whatsapp.net', fromMe: false },
          message,
          messageTimestamp: 1_700_000_000,
          pushName: 'Someone',
        },
      ],
    })
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
  }

  function inboundBody(fetchMock: ReturnType<typeof vi.fn>) {
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]) === 'http://api.test/internal/whatsapp/inbound',
    )
    return call ? JSON.parse((call[1] as { body: string }).body) : undefined
  }

  /** fetch mock that mints an upload URL, accepts the PUT, and ACKs /inbound. */
  function streamingFetchMock() {
    return vi.fn(async (url: unknown, init?: { method?: string }) => {
      if (String(url).endsWith('/internal/whatsapp/media-upload-url')) {
        return {
          ok: true,
          json: async () => ({ gcsKey: 'channel-media/k.bin', uploadUrl: 'https://gcs.test/put' }),
        }
      }
      if (init?.method === 'PUT') return { ok: true }
      return { ok: true }
    })
  }

  it('streams a sub-cap VIDEO to GCS and relays a mediaRef (never mediaBase64)', async () => {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    const { Readable } = await import('node:stream')
    vi.mocked(downloadMediaMessage).mockResolvedValue(Readable.from([Buffer.from('vid')]) as never)
    const fetchMock = streamingFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitMedia({ videoMessage: { mimetype: 'video/mp4', fileLength: 9_000_000 } })

    const body = inboundBody(fetchMock)
    expect(body).toBeDefined()
    expect(body.mediaRef).toMatchObject({ gcsKey: 'channel-media/k.bin', mimeType: 'video/mp4' })
    expect(body.mediaBase64).toBeUndefined()
    // Streamed, not buffered: the buffer arm was never used.
    expect(vi.mocked(downloadMediaMessage)).toHaveBeenCalledWith(expect.anything(), 'stream', expect.anything())
    vi.unstubAllGlobals()
  })

  it('includes the API response body when upload URL minting fails', async () => {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/internal/whatsapp/media-upload-url')) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: async () => '{"error":"channel not resolvable"}',
        }
      }
      return { ok: true }
    })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitMedia({ videoMessage: { mimetype: 'video/mp4', fileLength: 9_000_000 } })

    expect(vi.mocked(downloadMediaMessage)).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Media stream-to-GCS failed'),
      expect.objectContaining({ message: expect.stringContaining('{"error":"channel not resolvable"}') }),
    )
    error.mockRestore()
    vi.unstubAllGlobals()
  })

  it('keeps a sub-cap voice note (ptt) inline as mediaBase64', async () => {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    vi.mocked(downloadMediaMessage).mockResolvedValue(Buffer.from('voice-bytes') as never)
    const fetchMock = streamingFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitMedia({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true, fileLength: 80_000 } })

    const body = inboundBody(fetchMock)
    expect(body).toBeDefined()
    expect(body.mediaBase64).toBe(Buffer.from('voice-bytes').toString('base64'))
    expect(body.mediaRef).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('streams a sub-cap audio FILE (no ptt) to GCS', async () => {
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
    const { Readable } = await import('node:stream')
    vi.mocked(downloadMediaMessage).mockResolvedValue(Readable.from([Buffer.from('mp3')]) as never)
    const fetchMock = streamingFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitMedia({ audioMessage: { mimetype: 'audio/mpeg', fileLength: 3_000_000 } })

    const body = inboundBody(fetchMock)
    expect(body).toBeDefined()
    expect(body.mediaRef).toMatchObject({ mimeType: 'audio/mpeg' })
    expect(body.mediaBase64).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('[COMP:wa-connector/socket-manager] LID sender resolution (Baileys v7)', () => {
  async function connected() {
    const mgr = manager()
    await mgr.connect('a-1')
    fakeSockets[0].ev.emit('connection.update', { connection: 'open' })
    return mgr
  }

  async function emitRaw(msg: Record<string, unknown>) {
    fakeSockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [msg] })
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }

  function inboundBody(fetchMock: ReturnType<typeof vi.fn>) {
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]) === 'http://api.test/internal/whatsapp/inbound',
    )
    return call ? JSON.parse((call[1] as { body: string }).body) : undefined
  }

  it('resolves a LID DM sender via the key remoteJidAlt PN twin', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitRaw({
      key: {
        id: 'lid-dm-1',
        remoteJid: '237288437104831@lid',
        remoteJidAlt: '85266986281@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'hello from a hidden number' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Hidden',
    })

    const body = inboundBody(fetchMock)
    expect(body).toBeDefined()
    expect(body.senderJid).toBe('237288437104831@lid')
    expect(body.senderPnJid).toBe('85266986281@s.whatsapp.net')
    vi.unstubAllGlobals()
  })

  it('resolves a LID group participant via participantAlt', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitRaw({
      key: {
        id: 'lid-grp-1',
        remoteJid: '120363000000000000@g.us',
        participant: '237288437104831@lid',
        participantAlt: '85266986281@s.whatsapp.net',
        fromMe: false,
      },
      message: { conversation: 'group message' },
      messageTimestamp: 1_700_000_000,
      pushName: 'Hidden',
    })

    const body = inboundBody(fetchMock)
    expect(body).toBeDefined()
    expect(body.isGroup).toBe(true)
    expect(body.senderJid).toBe('237288437104831@lid')
    expect(body.senderPnJid).toBe('85266986281@s.whatsapp.net')
    vi.unstubAllGlobals()
  })

  it('falls back to the LID mapping store when the key has no alt, and omits senderPnJid when unknown', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()
    fakeSockets[0].signalRepository.lidMapping.getPNForLID.mockResolvedValueOnce(
      '85266986281@s.whatsapp.net',
    )

    await emitRaw({
      key: { id: 'lid-dm-2', remoteJid: '237288437104831@lid', fromMe: false },
      message: { conversation: 'mapped via store' },
      messageTimestamp: 1_700_000_000,
    })
    let body = inboundBody(fetchMock)
    expect(body.senderPnJid).toBe('85266986281@s.whatsapp.net')

    // Second message: the store has no mapping — relay without a PN twin.
    fetchMock.mockClear()
    await emitRaw({
      key: { id: 'lid-dm-3', remoteJid: '999999999@lid', fromMe: false },
      message: { conversation: 'unknown lid' },
      messageTimestamp: 1_700_000_001,
    })
    body = inboundBody(fetchMock)
    expect(body).toBeDefined()
    expect(body.senderPnJid).toBeUndefined()
    expect(body.senderJid).toBe('999999999@lid')
    vi.unstubAllGlobals()
  })

  it('does not resolve anything for a plain PN sender', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await connected()

    await emitRaw({
      key: { id: 'pn-dm-1', remoteJid: '85266986281@s.whatsapp.net', fromMe: false },
      message: { conversation: 'normal' },
      messageTimestamp: 1_700_000_000,
    })

    const body = inboundBody(fetchMock)
    expect(body.senderPnJid).toBeUndefined()
    expect(fakeSockets[0].signalRepository.lidMapping.getPNForLID).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
