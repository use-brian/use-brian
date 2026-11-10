// [COMP:tooling/push-preflight] Disposable verification never changes the source checkout.
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, rm, symlink, copyFile, writeFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve, relative, delimiter } from 'node:path'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const localNodeHeapMb = 8192
export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { maxBuffer: 128 * 1024 * 1024 })
}
export async function identity(root) {
  root = resolve(root)
  const head = git(root, ['rev-parse', 'HEAD']).toString().trim()
  const branch = git(root, ['branch', '--show-current']).toString().trim()
  if (!branch) throw new Error(`Detached publication checkout: ${root}`)
  const origin = git(root, ['remote', 'get-url', 'origin']).toString().trim()
  let base = null
  try { base = git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]).toString().trim() } catch { /* unknown comparison selects full coverage */ }
  let reviewBase = null
  if (!['develop', 'main'].includes(branch)) {
    try { reviewBase = git(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/develop']).toString().trim() } catch { /* missing review history selects full coverage */ }
  }
  const files = git(root, ['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean)
    .map(line => { const at = line.indexOf('\t'), meta = line.slice(0, at), path = line.slice(at + 1); if (meta.split(' ')[2] !== '0') throw new Error('Unmerged source cannot be verified'); return { path, mode: meta.split(' ')[0] } })
  if (files.some(file => file.mode !== '160000' && !['100644', '100755', '120000'].includes(file.mode))) throw new Error('Unmerged source cannot be verified')
  const submodules = new Set(files.filter(file => file.mode === '160000').map(file => file.path))
  const paths = [...new Set([...files.map(file => file.path), ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)])].sort()
  const hash = createHash('sha256')
  hash.update(git(root, ['ls-files', '--stage', '-z']))
  for (const path of paths.filter(path => !submodules.has(path))) {
    if (/(^|\/)\.env(?:$|\.|rc$)/.test(path) && !path.endsWith('.example')) throw new Error(`Refusing credential-shaped source file: ${path}`)
    const absolute = join(root, path)
    const info = await lstat(absolute).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    hash.update(path).update('\0')
    if (!info) hash.update('deleted')
    else if (info.isSymbolicLink()) hash.update('link:').update(await readlink(absolute))
    else if (info.isFile()) hash.update(String(info.mode & 0o777)).update(await readFile(absolute))
    else throw new Error(`Unsupported source entry: ${path}`)
    hash.update('\0')
  }
  return { root, head, branch, originHash: digest(origin), base, reviewBase, fingerprint: hash.digest('hex') }
}
export function sameIdentity(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

export async function snapshot(source, destination, env) {
  const before = await identity(source)
  const excluded = git(source, ['ls-files', '--stage', '-z']).toString().split('\0').filter(line => line.startsWith('160000 '))
    .map(line => `:(exclude)${line.slice(line.indexOf('\t') + 1)}`)
  await command('git', ['clone', '--shared', '--quiet', '--no-checkout', source, destination], { env })
  await command('git', ['checkout', '--quiet', '--detach', before.head], { cwd: destination, env })
  const patch = git(source, ['diff', '--binary', 'HEAD', '--', '.', ...excluded])
  if (patch.length) {
    const path = join(destination, '.git', 'preflight.patch')
    await writeFile(path, patch, { mode: 0o600 })
    await command('git', ['apply', '--binary', path], { cwd: destination, env })
  }
  for (const path of git(source, ['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean)) {
    const from = join(source, path), to = join(destination, path)
    await mkdir(dirname(to), { recursive: true })
    const info = await lstat(from)
    if (info.isSymbolicLink()) {
      const target = await readlink(from)
      if (relative(source, resolve(dirname(from), target)).startsWith('..')) throw new Error(`External untracked symlink: ${path}`)
      await symlink(target, to)
    } else if (info.isFile()) await copyFile(from, to)
    else throw new Error(`Unsupported untracked entry: ${path}`)
  }
  if (!sameIdentity(before, await identity(source))) throw new Error('Source changed while taking the verification snapshot')
  await command('git', ['add', '-A', '--', '.', ...excluded], { cwd: destination, env })
  if (git(destination, ['diff', '--cached', '--name-only', '-z']).length) {
    await command('git', ['-c', 'user.name=Local Preflight', '-c', 'user.email=preflight@example.invalid', 'commit', '--quiet', '-m', 'chore: disposable verification snapshot'], { cwd: destination, env })
  }
  await writeFile(join(destination, '.git', 'preflight-owned.json'), JSON.stringify({ root: resolve(destination), head: git(destination, ['rev-parse', 'HEAD']).toString().trim(), nonce: randomUUID() }), { mode: 0o600 })
  return before
}

export async function resetSnapshot(root, options) {
  const owned = JSON.parse(await readFile(join(root, '.git', 'preflight-owned.json'), 'utf8'))
  if (owned.root !== resolve(root) || !owned.nonce || !/^[a-f0-9]{40,64}$/.test(owned.head)) throw new Error('Refusing to reset an unowned verification checkout')
  await command('git', ['reset', '--hard', owned.head], { ...options, cwd: root })
  await command('git', ['clean', '-ffdx'], { ...options, cwd: root })
}

export function environment(directory, store) {
  return { ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SystemRoot'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`, HOME: join(directory, 'home'), TMPDIR: join(directory, 'tmp'),
    CI: 'true', BRIAN_TEST_NO_PAID: '1', TURBO_FORCE: 'true',
    NODE_OPTIONS: `--max-old-space-size=${localNodeHeapMb}`,
    npm_config_store_dir: store, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
}

export async function command(file, args, { cwd, env, timeoutMs = 600_000, log, signal } = {}) {
  if (signal?.aborted) throw new Error('Preflight interrupted')
  const started = performance.now()
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', failed, escalation
    const stop = reason => {
      if (failed) return
      failed = new Error(reason)
      const kill = value => { try { process.platform === 'win32' ? child.kill(value) : process.kill(-child.pid, value) } catch (error) { if (error.code !== 'ESRCH') failed = error } }
      kill('SIGTERM'); escalation = setTimeout(() => kill('SIGKILL'), 2_000)
    }
    const abort = () => stop('Preflight interrupted')
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => stop('Preflight command exceeded the remaining job budget'), Math.max(1, timeoutMs))
    const capture = chunk => { output = (output + chunk.toString()).slice(-16_000_000) }
    child.stdout.on('data', capture); child.stderr.on('data', capture)
    child.once('error', error => { failed = error })
    child.once('close', async (code, termination) => {
      clearTimeout(timer); clearTimeout(escalation); signal?.removeEventListener('abort', abort)
      try {
        if (log) { await mkdir(dirname(log), { recursive: true }); await writeFile(log, output, { mode: 0o600 }) }
        if (failed || code !== 0) throw failed ?? new Error(`Command failed (${termination ?? code}); see ${log ?? 'captured output'}`)
        accept({ output, durationMs: Math.round(performance.now() - started) })
      } catch (error) { reject(error) }
    })
  })
}

export async function cleanOutputs(root, { dependencies = false } = {}) {
  const directories = ['.turbo', 'out']
  if (dependencies) directories.push('node_modules')
  for (const group of ['apps', 'packages']) {
    for (const name of await readdir(join(root, group)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      for (const output of ['dist', '.next', '.turbo']) directories.push(join(group, name, output))
      if (dependencies) directories.push(join(group, name, 'node_modules'))
    }
  }
  for (const path of directories) {
    if (git(root, ['ls-files', '--', path]).length) throw new Error(`Build output contains tracked source: ${path}`)
    await rm(join(root, path), { force: true, recursive: true })
  }
  // Incremental compiler state can otherwise claim a deleted dist is up to date.
  for (const path of git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '*.tsbuildinfo']).toString().split('\0').filter(Boolean)) {
    await rm(join(root, path), { force: true })
  }
}

export async function cleanupDatabases(directory, pgBin, env) {
  for (const name of await readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!name.startsWith('brian-crm-')) continue
    const owned = join(directory, name)
    const marker = JSON.parse(await readFile(join(owned, 'assurance-fixture.json'), 'utf8'))
    if (marker.directory !== owned || !marker.token) throw new Error('Fixture cleanup ownership mismatch')
    const pid = await lstat(join(owned, 'data', 'postmaster.pid')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (pid) await command(pgBin ? join(pgBin, 'pg_ctl') : 'pg_ctl', ['-D', join(owned, 'data'), '-m', 'fast', '-w', 'stop'], { env })
  }
}

export async function saveReceipt(path, report) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}`
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  const { rename } = await import('node:fs/promises'); await rename(temporary, path)
}
