// Deterministic source-only ustar; never runs compiler, signer, bundled tests/code.
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const manifest = Object.freeze([
  'apps/app-desktop/scripts/mac-library-constraint-fixture.mjs',
  'apps/app-desktop/scripts/mac-library-constraints.mjs',
  'apps/app-desktop/native/computer-control/MAC-LIBRARY-CONSTRAINT-FIXTURE.md',
]);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
function inside(path, root) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
function noSymlinks(path) {
  let current = resolve(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Symlinks are not allowed');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function entry(name, bytes) {
  if (Buffer.byteLength(name) > 100) throw new Error('Tar name too long');
  const header = Buffer.alloc(512);
  const text = (at, size, value) => header.write(value, at, size, 'ascii');
  const octal = (at, size, value) => text(at, size, value.toString(8).padStart(size - 1, '0') + '\0');
  text(0, 100, name); octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, bytes.length); octal(136, 12, 0); header.fill(32, 148, 156);
  text(156, 1, '0'); text(257, 6, 'ustar\0'); text(263, 2, '00');
  text(148, 8, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
  return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
}
export function bundleFormatFixture({ output, sourceRoot = repository }) {
  if (!output || !isAbsolute(output) || !output.endsWith('.tar')) throw new Error('Explicit absolute outside-repo .tar output required');
  const destination = resolve(output);
  noSymlinks(sourceRoot); noSymlinks(dirname(destination));
  const root = realpathSync(sourceRoot);
  if (inside(destination, root) || inside(destination, realpathSync(repository))) throw new Error('Output must be outside repository');
  const parts = [], checksums = [];
  for (const name of manifest) {
    const path = resolve(root, name); noSymlinks(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size < 1 || st.size > 1024 * 1024) throw new Error('Expected bounded regular source file');
      bytes = Buffer.alloc(st.size + 1);
      let at = 0, n;
      while (at < bytes.length && (n = readSync(fd, bytes, at, bytes.length - at, null)) > 0) at += n;
      const after = fstatSync(fd);
      if (at !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs) throw new Error('Source changed while reading');
      bytes = bytes.subarray(0, at);
      if (bytes.includes(0) || !isUtf8(bytes)) throw new Error('Expected UTF-8 source text, not binary content');
    } finally { closeSync(fd); }
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${name}`);
    parts.push(...entry(name, bytes));
  }
  parts.push(Buffer.alloc(1024));
  const archive = Buffer.concat(parts);
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, archive); } finally { closeSync(fd); }
  return { output: destination, checksums, sha256: createHash('sha256').update(archive).digest('hex') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required');
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node mac-library-constraint-fixture-bundle.mjs --output /outside/repo/format-source.tar');
    const result = bundleFormatFixture({ output: args[1] });
    console.log('Source-only SHA-256 manifest:\n' + result.checksums.join('\n'));
    console.log(`Archive SHA-256: ${result.sha256}\nArchive: ${result.output}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
