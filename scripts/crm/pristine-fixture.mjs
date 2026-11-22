// [COMP:ci/execution-topology] Reuse a pristine migrated cluster on compatible runners.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../', import.meta.url))
// Advance this boundary when replay of newer migrations becomes material.
export const pristineThrough = '8338_native_workspace_skill_receipts.sql'
const inputs = [
  'packages/api/migrations', 'packages/api/scripts/migrat*.ts', 'packages/api/src/migrations',
  'scripts/crm/local-fixture.mjs', 'scripts/crm/pristine-fixture.mjs', 'scripts/crm/runtime-role.mjs',
  'scripts/rig-admin-role.sql', 'package.json', 'packages/api/package.json', 'packages/api/tsconfig*.json',
  'tsconfig*.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches', '.npmrc',
]

export async function pristineKey(pgBin) {
  const config = async flag => (await exec(pgBin ? join(pgBin, 'pg_config') : 'pg_config', [flag])).stdout.trim()
  const [bin, lib, share] = await Promise.all(['--bindir', '--pkglibdir', '--sharedir'].map(config))
  const hash = createHash('sha256')
  function add(name, bytes) { hash.update(name).update('\0').update(createHash('sha256').update(bytes).digest()) }
  add('runtime', JSON.stringify([process.platform, process.arch, process.version, process.env.ImageOS ?? '']))
  const ext = process.platform === 'darwin' ? 'dylib' : 'so'
  for (const [name, file] of [
    ['postgres', join(pgBin || bin, 'postgres')],
    ...['pg_trgm', 'vector'].flatMap(name => [
      [name, join(lib, name + '.' + ext)], [name + '.control', join(share, 'extension', name + '.control')],
    ]),
  ]) add(name, await readFile(file))
  const extensionDir = join(share, 'extension')
  for (const name of (await readdir(extensionDir)).filter(name => /^(pg_trgm|vector)--.*\.sql$/.test(name)).sort()) {
    add(name, await readFile(join(extensionDir, name)))
  }
  const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...inputs], { cwd: root })
  for (const path of [...new Set(stdout.split('\0').filter(Boolean))].sort()) {
    if (path.startsWith('packages/api/migrations/') && path.slice('packages/api/migrations/'.length) > pristineThrough) continue
    const bytes = await readFile(join(root, path)).catch(error => { if (error.code !== 'ENOENT') throw error })
    if (bytes) add(path, bytes)
  }
  return 'calendar-pg-' + hash.digest('hex')
}

export async function pristineCache(directory, pgBin, run) {
  if (!isAbsolute(directory)) throw new Error('Pristine fixture cache requires an absolute directory')
  const key = await pristineKey(pgBin)
  const image = join(directory, key)
  const executable = name => pgBin ? join(pgBin, name) : name
  let unusable = false
  return {
    async restore(data, env) {
      try {
        const present = await stat(image).catch(error => {
          if (error.code !== 'ENOENT') throw error
          return null
        })
        if (!present) return false
        // Verify the backup manifest and WAL before starting a private writable copy.
        await run(executable('pg_verifybackup'), [image], { env })
        const label = await readFile(join(image, 'backup_label'), 'utf8')
        if (!label.split('\n').includes('LABEL: ' + key)) throw new Error('Backup was built for different migration inputs')
        await cp(image, data, { recursive: true, errorOnExist: true, force: false })
        return true
      } catch (error) {
        unusable = true
        await rm(data, { recursive: true, force: true })
        console.warn('Unusable pristine fixture backup. Replaying migrations.', error.message)
        return false
      }
    },
    async save(env) {
      if (unusable) return
      let staging
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        staging = await mkdtemp(join(directory, '.preparing-'))
        await run(executable('pg_basebackup'), ['--pgdata', staging, '--label', key, '--checkpoint=fast', '--wal-method=stream', '--manifest-checksums=SHA256'], { env })
        await run(executable('pg_verifybackup'), [staging], { env })
        if (key !== await pristineKey(pgBin)) throw new Error('Migration inputs changed during fixture preparation')
        await rename(staging, image).catch(error => {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
        })
        console.log('Prepared pristine PostgreSQL backup for reuse')
      } catch (error) {
        // A cache write is optional. The newly migrated database still runs the full suite.
        console.warn('Could not save the pristine PostgreSQL backup.', error.message)
      } finally { if (staging) await rm(staging, { recursive: true, force: true }) }
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , option, pgBin] = process.argv
  if (option && (option !== '--pg-bin' || !pgBin)) throw new Error('Expected --pg-bin <directory>')
  const key = await pristineKey(pgBin)
  await appendFile(process.env.GITHUB_OUTPUT, 'key=' + key + '\n')
  // A disposable local workflow replay intentionally exercises cold setup.
  if (process.env.GITHUB_ENV) await appendFile(process.env.GITHUB_ENV, 'BRIAN_CALENDAR_FIXTURE_CACHE=' + join(process.env.RUNNER_TEMP, 'calendar-pristine') + '\n')
}
