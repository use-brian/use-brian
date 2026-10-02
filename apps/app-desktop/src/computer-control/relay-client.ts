import { ServerMessageSchema, NATIVE_PROTOCOL, MAX_MESSAGE_BYTES, parseMessage, sameIdentity, type NativeIdentity } from './contracts.js'
import type { NativeComputerController } from './controller.js'

/** Separate native namespace/token. Construct only after a local grant is active.
 * Parent obtains a short-lived native audience token from authenticated API; never browser tokens.
 */
export class NativeRelayClient {
  private socket?: WebSocket
  private ready = false
  private closed = false
  private heartbeat?: ReturnType<typeof setInterval>
  constructor(private readonly controller: NativeComputerController, private readonly identity: NativeIdentity, private readonly makeSocket: (url: string) => WebSocket = url => new WebSocket(url)) {}
  connect(url: string, token: string): void {
    const endpoint = new URL(url)
    if (this.socket || this.closed || !(endpoint.protocol === 'wss:' || (endpoint.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname))) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token || token.length > 8192) throw new Error('Invalid native relay connection')
    const status = this.controller.status()
    if (status.state !== 'active' || !status.identity || !sameIdentity(status.identity, this.identity)) throw new Error('Local native grant required')
    const socket = this.socket = this.makeSocket(url)
    const timeout = setTimeout(() => this.disconnect(), 5000)
    socket.addEventListener('open', () => {
      if (!this.closed) socket.send(JSON.stringify({ type: 'hello', protocol: NATIVE_PROTOCOL, token }))
      token = ''
    })
    socket.addEventListener('message', event => {
      if (this.closed) return
      try {
        if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) throw new Error('Invalid native relay payload')
        const message = ServerMessageSchema.parse(parseMessage(event.data))
        if (message.type === 'revoke') { this.disconnect(); return }
        if (message.type === 'ready') {
          if (this.ready || !sameIdentity(message.identity, this.identity)) throw new Error('Wrong native identity')
          this.ready = true; clearTimeout(timeout)
          this.send({ type: 'status', status: this.controller.status() })
          this.heartbeat = setInterval(() => this.send({ type: 'heartbeat' }), 10_000)
        } else {
          if (!this.ready || !sameIdentity(message.command.identity, this.identity)) throw new Error('Unbound command')
          void this.controller.execute(message.command).then(receipt => this.send({ type: 'receipt', receipt }), () => this.disconnect())
        }
      } catch { this.disconnect() }
    })
    socket.addEventListener('error', () => this.disconnect())
    socket.addEventListener('close', () => { clearTimeout(timeout); this.disconnect() })
  }
  async waitUntilReady(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 5000
    while (!this.ready) {
      if (this.closed || signal.aborted || Date.now() >= deadline) throw new Error('Native relay not ready')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  private send(message: unknown): void {
    if (!this.closed && this.socket?.readyState === 1) {
      try { this.socket.send(JSON.stringify(message)) } catch { this.disconnect() }
    }
  }
  disconnect(): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.heartbeat)
    this.controller.relayDisconnected()
    this.socket?.close()
  }
}
