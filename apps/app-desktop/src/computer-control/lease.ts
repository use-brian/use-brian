import { mkdir, rmdir, lstat } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { userInfo } from 'node:os'

export interface DeviceLease { acquire(): Promise<void>; release(): Promise<void> }
/** POSIX crashes leave the private directory locked; never steal a stale lease.
 * The default uses the OS account database, never HOME/USERPROFILE.
 * Explicit root injection is test-only; production must share the default across profiles.
 * Windows ignores root and uses a fixed OS-home-keyed exclusive pipe slot instead.
 * A main crash closes that slot: safety REQUIRES the Windows helper's independent
 * per-session mutex before grant activation and its parent-death watchdog. Normal
 * callers must await helper death before release() on every platform.
 */
export class LocalDeviceLease implements DeviceLease {
  private owned = false
  private readonly path: string
  private readonly windows = process.platform === 'win32'
  private server?: Server
  private acquiring?: Promise<void>
  private closing?: Promise<void>

  private async acquireWindows(): Promise<void> {
    if (this.server || this.acquiring || this.closing) throw new Error('Device already leased')
    // No profile/deployment root, raw user path, PID or random suffix in the name.
    const home = win32.normalize(userInfo().homedir).replace(/[\\/]+$/, '').toLowerCase()
    const key = createHash('sha256').update(home).digest('hex')
    // OS object only, NOT a control/input transport. Never read or write a client.
    const server = createServer({ pauseOnConnect: true }, socket => socket.destroy())
    this.acquiring = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // libuv src/win/pipe.c uv_pipe_bind2 -> pipe_alloc_accept(TRUE) uses
      // FILE_FLAG_FIRST_PIPE_INSTANCE (EADDRINUSE on collision). exclusive also
      // prevents Node cluster handle sharing; it is not the Windows guarantee.
      // Keep the Windows default pipe security descriptor; do not broaden its
      // ACL with uv_pipe_chmod. This is not a claim of owner-only read access.
      server.listen({ path: `\\\\.\\pipe\\use-brian-native-control-${key}`, exclusive: true,
        readableAll: false, writableAll: false }, () => {
        this.server = server
        resolve()
      })
    })
    try { await this.acquiring } finally { this.acquiring = undefined }
  }
  constructor(private readonly root: string = join(userInfo().homedir, '.use-brian-native-control')) { this.path = join(root, 'native-computer.lease') }
  async acquire(): Promise<void> {
    if (this.windows) return this.acquireWindows()
    if (this.owned) throw new Error('Device already leased')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe lease directory')
    await mkdir(this.path, { mode: 0o700 })
    this.owned = true
  }
  async release(): Promise<void> {
    if (this.windows) {
      // A release racing listen must not return while a new slot is still opening.
      if (this.acquiring) { try { await this.acquiring } catch { return } }
      if (this.closing) return this.closing
      const server = this.server
      if (!server) return
      this.closing = new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error) { reject(error); return }
          this.server = undefined
          resolve()
        })
      })
      try { await this.closing } finally { this.closing = undefined }
      return
    }
    if (!this.owned) return
    await rmdir(this.path)
    this.owned = false
  }
}
