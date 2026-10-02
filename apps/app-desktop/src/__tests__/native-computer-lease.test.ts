import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createServer: vi.fn(), userInfo: vi.fn(), mkdir: vi.fn(), lstat: vi.fn(), rmdir: vi.fn() }))
vi.mock('node:net', () => ({ createServer: mocks.createServer }))
vi.mock('node:os', () => ({ userInfo: mocks.userInfo }))
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir, lstat: mocks.lstat, rmdir: mocks.rmdir }))
import { LocalDeviceLease } from '../computer-control/lease.js'

// Deterministic OS model: first-instance binding is atomic, close is deliberately
// deferred. Real Windows/libuv first-instance semantics require Windows smoke CI.
class Slot extends EventEmitter {
  path = ''
  finishListen?: () => void
  finishClose?: (error?: Error) => void
  listen = vi.fn((options: { path: string }, ready: () => void) => {
    this.path = options.path
    if (slots.has(this.path)) queueMicrotask(() => this.emit('error', new Error('EADDRINUSE')))
    else {
      slots.set(this.path, this)
      this.finishListen = ready
      if (!deferListen) queueMicrotask(ready)
    }
    return this
  })
  close = vi.fn((done: (error?: Error) => void) => {
    this.finishClose = error => {
      if (!error) slots.delete(this.path)
      done(error)
    }
    return this
  })
}
const platform = process.platform
const slots = new Map<string, Slot>()
let servers: Slot[] = []
let deferListen = false
beforeEach(() => {
  vi.resetAllMocks(); slots.clear(); servers = []; deferListen = false
  Object.defineProperty(process, 'platform', { value: 'win32' })
  mocks.userInfo.mockReturnValue({ homedir: 'C:\\Users\\Private Person' })
  mocks.createServer.mockImplementation(() => { const server = new Slot(); servers.push(server); return server })
})
afterEach(() => { vi.unstubAllEnvs(); Object.defineProperty(process, 'platform', { value: platform }) })
async function release(lease: LocalDeviceLease, server: Slot) {
  const pending = lease.release(); server.finishClose!(); await pending
}

describe('Windows native computer lease slot', () => {
  it('excludes other instances across roots; a failed acquire cannot release the owner', async () => {
    const owner = new LocalDeviceLease('profile-a'), contender = new LocalDeviceLease('profile-b')
    await owner.acquire()
    await expect(contender.acquire()).rejects.toThrow('EADDRINUSE')
    await contender.release()
    expect(servers[1].close).not.toHaveBeenCalled()
    expect(servers[0].close).not.toHaveBeenCalled()
    await expect(contender.acquire()).rejects.toThrow('EADDRINUSE')
    await release(owner, servers[0])
    await contender.acquire()
    await release(contender, servers[3])
    expect(mocks.mkdir).not.toHaveBeenCalled()
    expect(mocks.lstat).not.toHaveBeenCalled()
    expect(mocks.rmdir).not.toHaveBeenCalled()
  })

  it('ignores HOME and USERPROFILE overrides for the Windows pipe key', async () => {
    vi.stubEnv('HOME', 'C:\\fake-a'); vi.stubEnv('USERPROFILE', 'C:\\fake-a')
    const owner = new LocalDeviceLease(); await owner.acquire()
    vi.stubEnv('HOME', 'C:\\fake-b'); vi.stubEnv('USERPROFILE', 'C:\\fake-b')
    await expect(new LocalDeviceLease().acquire()).rejects.toThrow('EADDRINUSE')
    expect(servers[1].path).toBe(servers[0].path)
    await release(owner, servers[0])
  })

  it('awaits OS closure, coalesces release, and rejects reacquire while closing', async () => {
    const owner = new LocalDeviceLease(), other = new LocalDeviceLease()
    await owner.acquire()
    let released = false
    const first = owner.release().then(() => { released = true })
    const second = owner.release()
    await Promise.resolve()
    expect(released).toBe(false)
    await expect(owner.acquire()).rejects.toThrow('already leased')
    await expect(other.acquire()).rejects.toThrow('EADDRINUSE')
    expect(servers[0].close).toHaveBeenCalledOnce()
    servers[0].finishClose!()
    await Promise.all([first, second])
    expect(released).toBe(true)
    await other.acquire(); await release(other, servers[2])
    await owner.release()
    expect(servers[0].close).toHaveBeenCalledOnce()
  })

  it('waits for an in-flight acquisition before releasing it', async () => {
    deferListen = true
    const lease = new LocalDeviceLease()
    const acquiring = lease.acquire()
    let released = false
    const releasing = lease.release().then(() => { released = true })
    await expect(lease.acquire()).rejects.toThrow('already leased')
    expect(released).toBe(false)
    expect(servers[0].close).not.toHaveBeenCalled()
    servers[0].finishListen!(); await acquiring
    expect(servers[0].close).toHaveBeenCalledOnce()
    expect(released).toBe(false)
    servers[0].finishClose!(); await releasing
    expect(slots.size).toBe(0)
  })

  it('retains ownership when close fails', async () => {
    const lease = new LocalDeviceLease(); await lease.acquire()
    const pending = lease.release()
    servers[0].finishClose!(new Error('close failed'))
    await expect(pending).rejects.toThrow('close failed')
    await expect(lease.acquire()).rejects.toThrow('already leased')
    await expect(new LocalDeviceLease().acquire()).rejects.toThrow('EADDRINUSE')
    await release(lease, servers[0])
  })

  it('fails closed on listen error without closing someone else’s slot', async () => {
    mocks.createServer.mockImplementationOnce(() => {
      const server = new Slot(); servers.push(server)
      server.listen.mockImplementation(() => { throw new Error('denied') })
      return server
    })
    const lease = new LocalDeviceLease()
    await expect(lease.acquire()).rejects.toThrow('denied')
    await lease.release()
    expect(servers[0].close).not.toHaveBeenCalled()
    await lease.acquire(); await release(lease, servers[1])
  })

  it('uses a stable nonraw home hash, not profile paths, case or trailing separators', async () => {
    const first = new LocalDeviceLease('untrusted-profile'); await first.acquire()
    const name = servers[0].path
    expect(name).toMatch(/^\\\\\.\\pipe\\use-brian-native-control-[a-f0-9]{64}$/)
    expect(name).not.toContain('Private Person')
    expect(name).not.toContain('untrusted-profile')
    mocks.userInfo.mockReturnValue({ homedir: 'c:/users/private person/' })
    await expect(new LocalDeviceLease('another-profile').acquire()).rejects.toThrow('EADDRINUSE')
    expect(servers[1].path).toBe(name)
    mocks.userInfo.mockReturnValue({ homedir: 'C:\\Users\\Other' })
    const otherUser = new LocalDeviceLease(); await otherUser.acquire()
    expect(servers[2].path).not.toBe(name)
    await release(first, servers[0]); await release(otherUser, servers[2])
  })

  it('opens no network port or control transport and destroys clients without reading messages', async () => {
    const lease = new LocalDeviceLease(); await lease.acquire()
    expect(mocks.createServer).toHaveBeenCalledWith({ pauseOnConnect: true }, expect.any(Function))
    expect(servers[0].listen).toHaveBeenCalledWith({ path: servers[0].path, exclusive: true,
      readableAll: false, writableAll: false }, expect.any(Function))
    const socket = { destroy: vi.fn(), on: vi.fn(), once: vi.fn(), read: vi.fn(), write: vi.fn(), resume: vi.fn() }
    mocks.createServer.mock.calls[0][1](socket)
    expect(socket.destroy).toHaveBeenCalledOnce()
    for (const method of [socket.on, socket.once, socket.read, socket.write, socket.resume]) expect(method).not.toHaveBeenCalled()
    expect(servers[0].eventNames()).toEqual(['error'])
    await release(lease, servers[0])
  })
})

describe('POSIX lease remains fail closed', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mocks.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40700, uid: process.getuid?.() })
  })
  it.each(['linux', 'darwin'])('ignores environment roots on %s', async platform => {
    Object.defineProperty(process, 'platform', { value: platform })
    mocks.userInfo.mockReturnValue({ homedir: '/os-account' })
    const held = new Set<string>()
    mocks.mkdir.mockImplementation(async (path: string, options: { recursive?: boolean }) => {
      if (options.recursive) return
      if (held.has(path)) throw new Error('EEXIST')
      held.add(path)
    })
    vi.stubEnv('HOME', '/fake-a'); vi.stubEnv('XDG_RUNTIME_DIR', '/runtime-a')
    const owner = new LocalDeviceLease(); await owner.acquire()
    vi.stubEnv('HOME', '/fake-b'); vi.stubEnv('USERPROFILE', '/fake-b')
    vi.stubEnv('XDG_RUNTIME_DIR', '/runtime-b')
    await expect(new LocalDeviceLease().acquire()).rejects.toThrow('EEXIST')
    expect([...held]).toEqual(['/os-account/.use-brian-native-control/native-computer.lease'])
    await owner.release()
  })
  it('keeps private mkdir exclusion and only removes its own lease', async () => {
    const lease = new LocalDeviceLease('/fixed-home')
    await lease.acquire()
    expect(mocks.mkdir.mock.calls).toEqual([
      ['/fixed-home', { recursive: true, mode: 0o700 }],
      ['/fixed-home/native-computer.lease', { mode: 0o700 }],
    ])
    await expect(lease.acquire()).rejects.toThrow('already leased')
    await lease.release(); await lease.release()
    expect(mocks.rmdir).toHaveBeenCalledExactlyOnceWith('/fixed-home/native-computer.lease')
    expect(mocks.createServer).not.toHaveBeenCalled()
  })
  it('never steals an existing directory', async () => {
    mocks.mkdir.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('EEXIST'))
    const lease = new LocalDeviceLease('/fixed-home')
    await expect(lease.acquire()).rejects.toThrow('EEXIST'); await lease.release()
    expect(mocks.rmdir).not.toHaveBeenCalled()
  })
  it('still rejects fabricated/broad permission bits on POSIX', async () => {
    mocks.lstat.mockResolvedValue({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o40777, uid: process.getuid?.() })
    await expect(new LocalDeviceLease('/fixed-home').acquire()).rejects.toThrow('Unsafe lease directory')
    expect(mocks.mkdir).toHaveBeenCalledOnce()
  })
})
