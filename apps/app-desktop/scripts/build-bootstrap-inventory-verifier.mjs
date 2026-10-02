// Explicit separate developer build ONLY. Not imported by build.sh, signing,
// packaging or the helper. Never signs or runs the produced tool/candidate.
// Opt in: node build-bootstrap-inventory-verifier.mjs --build-read-only-verifier
// No input/output/compiler/team path overrides. Existing output is NOT replaced.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const base = fileURLToPath(new URL('../native/computer-control/', import.meta.url));
const env = { PATH: '/usr/bin:/bin', HOME: '/var/empty', LANG: 'C', LC_ALL: 'C' };
const fail = () => { throw new Error('Read-only inventory verifier build refused'); };
function trusted(path, file = false) {
  const uid = process.getuid(); let first = true;
  while (true) {
    const s = fs.lstatSync(path);
    if (s.isSymbolicLink() || (s.mode & 0o022) || ![0, uid].includes(s.uid) || (first && file ? !s.isFile() || s.nlink !== 1 : !s.isDirectory())) fail();
    const parent = dirname(path); if (parent === path) break; path = parent; first = false;
  }
}
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false, exited = false, bad = false, stopped = false, size = 0, timer, grace; const out = [];
    const finish = (code, signal, closed) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(grace);
      if (!closed) { child.stdout.destroy(); child.stderr.destroy(); child.unref(); }
      if (!closed || bad || code !== 0 || signal !== null) reject(new Error('Compiler refused')); else resolve(Buffer.concat(out).toString('utf8'));
    };
    const stop = () => {
      bad = true; if (done || stopped) return; stopped = true;
      if (!exited && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not close evidence */ } }
      grace = setTimeout(() => finish(null, null, false), 2000);
    };
    child.once('exit', () => { exited = true; }); child.once('close', (c, s) => finish(c, s, true)); child.on('error', stop);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', stop); stream.on('data', b => { size += b.length; if (size > 65536) stop(); else if (stream === child.stdout) out.push(Buffer.from(b)); });
    }
    timer = setTimeout(stop, 60000);
  });
}
let temporary;
try {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function' || process.getuid() === 0 ||
      process.getuid() !== process.geteuid() || process.getgid() !== process.getegid() || process.argv.length !== 3 || process.argv[2] !== '--build-read-only-verifier') fail();
  const native = base.replace(/\/$/, ''), source = join(native, 'BootstrapInventoryVerifier.c'), build = join(native, 'build');
  trusted(native); trusted(source, true);
  // Query existing tools only; no --install and no automatic developer-tools UI.
  const developer = (await run('/usr/bin/xcode-select', ['-p'])).trim();
  if (!isAbsolute(developer) || !fs.statSync(developer).isDirectory()) fail();
  const sdk = (await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'])).trim();
  const clang = (await run('/usr/bin/xcrun', ['--sdk', 'macosx', '--find', 'clang'])).trim();
  if (!isAbsolute(sdk) || !isAbsolute(clang) || !fs.statSync(sdk).isDirectory() || !fs.statSync(clang).isFile()) fail();
  if (!fs.existsSync(build)) fs.mkdirSync(build, { mode: 0o700 }); trusted(build);
  const output = join(build, 'brian-bootstrap-inventory-verifier'); if (fs.existsSync(output)) fail();
  temporary = fs.mkdtempSync(join(build, '.inventory-verifier-')); fs.chmodSync(temporary, 0o700);
  const binary = join(temporary, 'verifier');
  await run(clang, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-deprecated-declarations',
    '-mmacosx-version-min=14.0', '-isysroot', sdk, source, '-framework', 'Security', '-framework', 'CoreFoundation', '-o', binary]);
  trusted(binary, true); fs.chmodSync(binary, 0o700);
  // link is no-clobber even if output appears after existsSync; then drop temp link.
  fs.linkSync(binary, output); fs.unlinkSync(binary);
  process.stdout.write('Read-only inventory verifier built; native acceptance still required.\n');
} catch { process.stderr.write('Read-only inventory verifier build refused.\n'); process.exitCode = 1; }
finally { if (temporary) { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { process.exitCode = 1; } } }
