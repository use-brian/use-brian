import { constants, openSync, closeSync, fstatSync, lstatSync, statSync, realpathSync, fsyncSync } from 'node:fs';
import { dirname, isAbsolute, resolve, join } from 'node:path';
const failure = () => new Error('Incomplete attended collection');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

/** Node has no portable openat/renameat. On Linux, use a verified procfs dirfd
 * anchor. Else use protected absolute paths, never pretend /proc exists on Mac.
 * Both paths require the ENTIRE ancestor chain to exclude other-user rename
 * attacks. Root/current-UID ownership and sticky-parent protection are required.
 * Hostile root or same-UID code remains outside this boundary.
 */
export function openProtectedDirectory(path) {
  let fd;
  try {
    if (typeof process.getuid !== 'function' || !isAbsolute(path) || resolve(path) !== path) throw failure();
    const uid = process.getuid();
    const inspect = () => {
      const chain = [];
      for (let p = path; ; p = dirname(p)) {
        const s = lstatSync(p);
        if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && s.uid !== uid)) throw failure();
        // A sticky root/current-owned ancestor prevents other users replacing
        // the next root/current-owned child. Non-sticky group-write is unsafe
        // even if the immediate output directory happens to be private.
        if ((s.mode & 0o022) && !(s.mode & 0o1000)) throw failure();
        if (p === path && (s.uid !== uid || (s.mode & 0o077))) throw failure();
        chain.push({ path: p, stat: s });
        if (dirname(p) === p) break;
      }
      if (realpathSync(path) !== path) throw failure();
      return chain;
    };
    const original = inspect();
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    if (!same(fstatSync(fd), original[0].stat)) throw failure();
    let anchor = path;
    if (process.platform === 'linux') {
      const proc = `/proc/self/fd/${fd}`;
      try { if (same(statSync(proc), fstatSync(fd))) anchor = proc; } catch { /* protected-path fallback if procfs is unavailable */ }
    }
    let closed = false;
    const revalidate = () => {
      try {
        if (closed) throw failure();
        const current = inspect();
        if (current.length !== original.length || current.some((x, i) => x.path !== original[i].path || !same(x.stat, original[i].stat)) || !same(fstatSync(fd), original[0].stat) || !same(statSync(anchor), original[0].stat)) throw failure();
      } catch { throw failure(); }
    };
    revalidate();
    return Object.freeze({
      revalidate,
      entry(name) {
        if (closed || typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) throw failure();
        return join(anchor, name);
      },
      sync() { revalidate(); fsyncSync(fd); },
      close() { if (!closed) { closed = true; closeSync(fd); } },
    });
  } catch { if (fd !== undefined) { try { closeSync(fd); } catch {} } throw failure(); }
}
