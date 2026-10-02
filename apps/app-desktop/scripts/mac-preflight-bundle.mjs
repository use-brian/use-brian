// Dependency-free, deterministic source-only tar. Never executes bundled code.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const manifest = Object.freeze([
  'build.sh', 'Helper.swift', 'ProcessIdentity.c', 'ProcessIdentity.h', 'Fixture.swift',
  'smoke.mjs', 'bootstrap-negative.mjs', 'mac-preflight.sh', 'MAC-PREFLIGHT.md',
  'KernelSigningProbe.c', 'KERNEL-SIGNING-PROBE.md',
  'BootstrapApprovalAnchor.c', 'BootstrapApprovalAnchor.h', 'LibraryConstraintPolicy.swift',
  'MachOLibraryConstraint.swift', 'BootstrapApproval.swift', 'BootstrapApprovalReader.swift', 'BootstrapProcessBinding.swift',
  'ElectronFrameworkBinding.swift',
])
const source = fileURLToPath(new URL('../native/computer-control/', import.meta.url))
const repository = fileURLToPath(new URL('../../../', import.meta.url))
function inside(path, root) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
function noSymlinks(path) {
  let current = resolve(path)
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${current}`)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
}
function tarEntry(name, data) {
  const header = Buffer.alloc(512)
  function text(offset, length, value) { header.write(value, offset, length, 'ascii') }
  function octal(offset, length, value) { text(offset, length, value.toString(8).padStart(length - 1, '0') + '\0') }
  text(0, 100, name)
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0)
  octal(124, 12, data.length); octal(136, 12, 0)
  header.fill(32, 148, 156)
  text(156, 1, '0'); text(257, 6, 'ustar\0'); text(263, 2, '00')
  const checksum = header.reduce((total, byte) => total + byte, 0)
  text(148, 8, checksum.toString(8).padStart(6, '0') + '\0 ')
  return [header, data, Buffer.alloc((512 - data.length % 512) % 512)]
}

export function bundle({ output, sourceDir = source, sourceRoot = repository }) {
  if (!output || !isAbsolute(output)) throw new Error('An explicit absolute output .tar path is required')
  const destination = resolve(output), directory = resolve(sourceDir)
  if (!destination.endsWith('.tar')) throw new Error('Output must be a .tar file')
  noSymlinks(directory); noSymlinks(dirname(destination)); noSymlinks(sourceRoot)
  const root = realpathSync(sourceRoot)
  if (inside(destination, root) || inside(destination, directory)) throw new Error('Output must be outside the source tree')
  const parts = [], checksums = []
  for (const name of manifest) {
    const path = resolve(directory, name)
    noSymlinks(path)
    if (!lstatSync(path).isFile()) throw new Error(`Expected bounded regular source file: ${name}`)
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let data
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error(`Expected bounded regular source file: ${name}`)
      data = readFileSync(fd)
      if (data.length !== stat.size) throw new Error(`Source changed while reading: ${name}`)
    } finally { closeSync(fd) }
    checksums.push(`${createHash('sha256').update(data).digest('hex')}  ${name}`)
    parts.push(...tarEntry(name, data))
  }
  parts.push(Buffer.alloc(1024))
  const archive = Buffer.concat(parts)
  // Never overwrite a destination (including symlinks); no automatic parent creation.
  const fd = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, archive) } finally { closeSync(fd) }
  return { checksums, sha256: createHash('sha256').update(archive).digest('hex'), output: destination }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node 20+ required')
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node mac-preflight-bundle.mjs --output /outside/source/mac-preflight.tar')
    const result = bundle({ output: args[1] })
    console.log('Source SHA-256 manifest (exact archived bytes):\n' + result.checksums.join('\n'))
    console.log(`Archive SHA-256: ${result.sha256}\nArchive: ${result.output}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
