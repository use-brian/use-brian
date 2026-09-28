// [COMP:platform/local-rig] Runtime guard for an explicitly isolated administrative fixture.
// Loaded only by that launcher's Node children; this is not production authorization.
import net from 'node:net'

const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  // Node's TLS and HTTP clients sometimes pass the normalized argument array.
  const values = Array.isArray(args[0]) ? args[0] : args
  const options = typeof values[0] === 'object' && values[0] !== null ? values[0] : null
  // Local IPC is used by tsx/Next. A string first argument is a Unix socket path.
  const localPath = options?.path || (typeof values[0] === 'string' && !/^\d+$/.test(values[0]))
  if (!localPath) {
    const host = options?.host ?? (typeof values[1] === 'string' ? values[1] : 'localhost')
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
      const error = new Error('Administrative fixture refuses non-loopback network access')
      error.code = 'ERR_RIG_EXTERNAL_NETWORK'
      throw error
    }
  }
  return Reflect.apply(connect, this, args)
}
