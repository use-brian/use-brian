#!/usr/bin/env node
/**
 * [COMP:platform/managed-postgres] Assemble the managed PostgreSQL artifact
 * from a `make install` tree (see build-artifact.sh).
 *
 *   node assemble-artifact.mjs --install DIR --out DIR [--prefix CONFIGURE_PREFIX] [--vector-commit SHA]
 *
 * 1. Copy the install tree (symlinks preserved) and drop the build SDK
 *    (`include/`, `lib/postgresql/pgxs`, static archives, `pg_config`).
 * 2. Rewrite every Mach-O dependency under the configure prefix to
 *    `@loader_path`, ad-hoc re-sign changed files, and refuse any dependency
 *    outside the artifact or the OS.
 * 3. Compile `lifecycle-fence.c` into `bin/usebrian-pg-lifecycle`, ship its
 *    source and the Use Brian license beside the PostgreSQL/pgvector licenses.
 * 4. Write `dynamic-dependencies.json` and the key-sorted `manifest.json`, then
 *    print the manifest SHA-256 for the release pin.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PROFILE = 'managed-postgresql18-posix-fence-v1'
const SOURCES = [
  { url: 'https://ftp.postgresql.org/pub/source/v18.7/postgresql-18.7.tar.bz2', sha256: '441dfae4280cae3e0425e5f876f80559fb0731c140f1aae22b3e5a54d0411bfd' },
  { url: 'https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz', commit: 'f37c13f68b57d2c3472b2214fbcff699d6d34876', sha256: 'cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85' },
]
const CONFIGURE = ['--without-icu', '--without-readline', '--without-zlib', '--disable-nls']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  if (!value) throw new Error(`${name} requires a value`)
  return value
}

function walk(root) {
  const files = []
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const stat = lstatSync(path)
      if (stat.isDirectory()) visit(path)
      else files.push(path)
    }
  }
  visit(root)
  return files
}

const inside = (root, path) => { const name = relative(root, path); return name !== '' && !name.startsWith('..' + sep) && name !== '..' }

/** Key-sorted, two-space JSON with a trailing newline (stable bytes). */
function stableJson(value) {
  const sort = (item) => Array.isArray(item) ? item.map(sort)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])])) : item
  return JSON.stringify(sort(value), null, 2) + '\n'
}

function machO(path) {
  const kind = execFileSync('/usr/bin/file', ['-b', path], { encoding: 'utf8' }).trim()
  return kind.includes('Mach-O') ? kind : null
}
function dependencies(path) {
  return execFileSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' }).split('\n').slice(1).map((line) => line.trim().split(' (')[0]).filter(Boolean)
}
function installId(path) {
  const lines = spawnSync('/usr/bin/otool', ['-D', path], { encoding: 'utf8' }).stdout.split('\n').slice(1).filter(Boolean)
  return lines[0]?.trim() ?? null
}

export function assembleArtifact({ install, out, prefix = install, vectorCommit = SOURCES[1].commit }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Only darwin-arm64 artifacts are qualified')
  if (existsSync(out)) throw new Error(`Output already exists: ${out}`)
  if (vectorCommit !== SOURCES[1].commit) throw new Error('pgvector commit differs from the pinned source')
  for (const license of ['share/licenses/postgresql/COPYRIGHT', 'share/licenses/pgvector/LICENSE']) {
    if (!existsSync(join(install, license))) throw new Error(`Install tree lacks ${license}`)
  }
  mkdirSync(dirname(out), { recursive: true })
  cpSync(install, out, { recursive: true, verbatimSymlinks: true })
  const root = realpathSync(out)

  // Runtime artifact: database tools, libraries, data and licenses; no build SDK.
  rmSync(join(root, 'include'), { recursive: true, force: true })
  rmSync(join(root, 'lib/postgresql/pgxs'), { recursive: true, force: true })
  for (const name of readdirSync(join(root, 'lib'))) if (name.endsWith('.a')) unlinkSync(join(root, 'lib', name))
  rmSync(join(root, 'bin/pg_config'), { force: true })

  // Lifecycle executor, its source and the Use Brian license.
  const fenceSource = join(HERE, 'lifecycle-fence.c')
  execFileSync('/usr/bin/clang', ['-O2', '-mmacosx-version-min=13.0', '-Wall', '-o', join(root, 'bin/usebrian-pg-lifecycle'), fenceSource], { stdio: 'inherit', env: { PATH: '/usr/bin:/bin' } })
  chmodSync(join(root, 'bin/usebrian-pg-lifecycle'), 0o755)
  mkdirSync(join(root, 'share/usebrian-source'), { recursive: true })
  copyFileSync(fenceSource, join(root, 'share/usebrian-source/lifecycle-fence.c'))
  chmodSync(join(root, 'share/usebrian-source/lifecycle-fence.c'), 0o644)
  mkdirSync(join(root, 'share/licenses/usebrian'), { recursive: true })
  copyFileSync(join(REPO, 'LICENSE'), join(root, 'share/licenses/usebrian/LICENSE'))
  chmodSync(join(root, 'share/licenses/usebrian/LICENSE'), 0o644)

  const audit = []
  for (const path of walk(root)) {
    if (lstatSync(path).isSymbolicLink()) continue
    const kind = machO(path)
    if (!kind) continue
    if (!kind.includes('arm64')) throw new Error(`Unexpected artifact architecture ${path}`)
    const oldId = installId(path)
    let modified = false
    if (oldId && oldId.startsWith(prefix)) {
      execFileSync('/usr/bin/install_name_tool', ['-id', '@rpath/' + path.split('/').pop(), path]); modified = true
    }
    for (const dependency of dependencies(path)) {
      if (dependency === oldId || !dependency.startsWith(prefix + '/')) continue
      const destination = join(root, relative(prefix, dependency))
      execFileSync('/usr/bin/install_name_tool', ['-change', dependency, '@loader_path/' + relative(dirname(path), destination), path]); modified = true
    }
    if (modified) execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', path])
    const currentId = installId(path)
    const current = dependencies(path)
    for (const dependency of current) {
      if (dependency === currentId || dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) continue
      if (dependency.startsWith('@loader_path/')) {
        const actual = resolve(dirname(path), dependency.slice('@loader_path/'.length))
        if (!inside(root, actual) || !statSync(actual).isFile()) throw new Error(`Escaping or missing dependency ${dependency} in ${path}`)
        continue
      }
      throw new Error(`Unbundled dependency ${dependency} in ${path}`)
    }
    audit.push({ file: relative(root, path), kind, dependencies: current })
  }
  writeFileSync(join(root, 'dynamic-dependencies.json'), JSON.stringify(audit, null, 2) + '\n')
  chmodSync(join(root, 'dynamic-dependencies.json'), 0o644)

  const files = {}
  for (const path of walk(root)) {
    const name = relative(root, path)
    if (name === 'manifest.json') continue
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      if (!inside(root, realpathSync(path))) throw new Error(`Unsafe artifact symlink ${name}`)
      files[name] = { link: readlinkSync(path) }
    } else files[name] = { sha256: sha256(readFileSync(path)), mode: '0o' + (stat.mode & 0o777).toString(8) }
  }
  const manifest = {
    format: 1,
    profile: PROFILE,
    platform: 'darwin',
    arch: 'arm64',
    minimumOS: '13.0',
    postgresql: '18.7',
    pgvector: '0.8.7',
    sources: SOURCES,
    configure: CONFIGURE,
    lifecycleFenceSourceSha256: sha256(readFileSync(fenceSource)),
    files,
  }
  writeFileSync(join(root, 'manifest.json'), stableJson(manifest))
  chmodSync(join(root, 'manifest.json'), 0o644)
  const manifestSha256 = sha256(readFileSync(join(root, 'manifest.json')))
  return { root, machOFiles: audit.length, files: Object.keys(files).length, manifestSha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const install = argument('--install'), out = argument('--out')
  if (!install || !out) { console.error('usage: assemble-artifact.mjs --install DIR --out DIR [--prefix PREFIX] [--vector-commit SHA]'); process.exit(64) }
  const result = assembleArtifact({ install: resolve(install), out: resolve(out), prefix: argument('--prefix', resolve(install)), vectorCommit: argument('--vector-commit', SOURCES[1].commit) })
  console.log(JSON.stringify(result))
}
