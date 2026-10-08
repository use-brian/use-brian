/**
 * Supertest starts the server it owns with `listen(0)`, which binds the
 * dual-stack `::` wildcard, and then always dials `127.0.0.1:<port>`
 * (supertest/lib/test.js `serverAddress`). The macOS ephemeral allocator does
 * not reliably check a wildcard IPv6 bind against loopback-specific IPv4
 * listeners, so it can hand that wildcard a port another process already owns
 * on `127.0.0.1` (an editor helper, a browser, a concurrent test run's server).
 * The more specific IPv4 binding wins the connection and the request is answered
 * by that foreign listener: a 404 or 200 the route under test can never produce.
 * Bind the owned server to the exact address supertest dials instead; the kernel
 * then refuses a conflicting loopback port. That bind is asynchronous, so the
 * request waits for `listening` before superagent sends it.
 */
import { once } from 'node:events'
import { createRequire } from 'node:module'
import type { AddressInfo, Server } from 'node:net'
import { Server as TlsServer } from 'node:tls'

type LoopbackTest = {
  url: string
  _server?: Server
  _loopbackBound?: Promise<unknown>
  _loopbackApp?: Server
  _loopbackPath?: string
  _loopbackProtocol?: string
}
type TestPrototype = {
  serverAddress(this: LoopbackTest, app: Server, path: string): string
  end(this: LoopbackTest, fn?: (error: unknown, response?: unknown) => void): unknown
}

const patched = new WeakSet<object>()

/** Patch the caller's installed copy, which can differ between pnpm stores. */
export function installSupertestLoopback(supertest: typeof import('supertest')) {
  const proto = supertest.Test?.prototype as unknown as TestPrototype | undefined
  if (typeof proto?.serverAddress !== 'function' || typeof proto.end !== 'function') {
    throw new Error('supertest internals changed: update packages/api/vitest.setup.ts')
  }
  if (patched.has(proto)) return
  patched.add(proto)
  const end = proto.end
  const binding = new WeakMap<Server, Promise<unknown>>()

  proto.serverAddress = function (app, path) {
    const protocol = app instanceof TlsServer ? 'https' : 'http'
    const address = app.address() as AddressInfo | null
    if (address) return `${protocol}://127.0.0.1:${address.port}${path}`
    let bound = binding.get(app)
    if (!bound) {
      // Only the Test that starts the server owns (and later closes) it.
      this._server = app.listen(0, '127.0.0.1')
      bound = once(app, 'listening')
      binding.set(app, bound)
      void bound.finally(() => binding.delete(app)).catch(() => {})
    }
    this._loopbackBound = bound
    this._loopbackApp = app
    this._loopbackPath = path
    this._loopbackProtocol = protocol
    return `${protocol}://127.0.0.1:0${path}`
  }

  proto.end = function (fn) {
    const bound = this._loopbackBound
    if (!bound) return end.call(this, fn)
    this._loopbackBound = undefined
    bound.then(() => {
      const { port } = this._loopbackApp!.address() as AddressInfo
      this.url = `${this._loopbackProtocol}://127.0.0.1:${port}${this._loopbackPath}`
      end.call(this, fn)
    }, (error) => fn?.(error))
    return this
  }
}

installSupertestLoopback(createRequire(import.meta.url)('supertest'))
