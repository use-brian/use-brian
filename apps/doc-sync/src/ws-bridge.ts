/**
 * Bridge a `ws` WebSocket to the Hocuspocus `ClientConnection` returned by
 * `hocuspocus.handleConnection()`.
 *
 * **Why this exists (load-bearing).** Hocuspocus **v4** changed the
 * integration contract: `handleConnection(ws, request)` now *returns* a
 * `ClientConnection` and attaches **no** listeners to the socket itself — the
 * caller must forward raw socket events into `connection.handleMessage()` /
 * `connection.handleClose()` (see the lib's own `src/Server.ts`, which wires
 * `message → handleMessage`, `close → handleClose` via crossws). The pre-v4
 * pattern — calling `handleConnection` and discarding its return — leaves the
 * socket open but **unread**: the browser connects, but the server never sees
 * the client's Auth/Sync messages, so `onConnect`/`onAuthenticate` never run,
 * the Yjs initial sync never completes, and the editor shows "Reconnecting…"
 * forever (connected-but-never-synced).
 *
 * Keeping the forwarding in this tiny pure function (rather than inline in the
 * `index.ts` upgrade closure) makes the regression unit-testable without a
 * live socket or DB.
 *
 * [COMP:doc-sync/ws-bridge]
 */

/** The slice of a Hocuspocus `ClientConnection` this bridge drives. */
export type HocuspocusConnectionLike = {
  handleMessage(data: Uint8Array): void
  handleClose(event: { code: number; reason: string }): void
}

/** The slice of a `ws` WebSocket this bridge listens on. */
export type SocketLike = {
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

/**
 * Normalise a `ws` message payload to a standalone `Uint8Array`. `ws` delivers
 * a Node `Buffer` by default (and, depending on options, an `ArrayBuffer` or a
 * `Buffer[]` of frame fragments). We always **copy**: Hocuspocus may queue the
 * reference until the connection is established, and a view over a pooled
 * Node `Buffer` can be overwritten before it's drained.
 */
export function toUint8Array(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  return new Uint8Array(data) // Node Buffer → copy (typed-array constructor)
}

/**
 * Forward `ws` socket events into the Hocuspocus connection. Call once per
 * connection, immediately after `hocuspocus.handleConnection(ws, request)`.
 */
export function bridgeConnection(
  connection: HocuspocusConnectionLike,
  socket: SocketLike,
  onError?: (err: Error) => void,
): void {
  socket.on('message', (data) => connection.handleMessage(toUint8Array(data)))
  socket.on('close', (code, reason) =>
    connection.handleClose({ code, reason: reason?.toString() ?? '' }),
  )
  socket.on('error', (err) => onError?.(err))
}
