#!/usr/bin/env node
/** Task-owned workload handshake. This does not assert machine-wide idleness. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const now = () => new Date().toISOString()
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const valid = (name) => /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(name)
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })

export function processInventory() {
  const result = spawnSync('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Process inventory unavailable: ${result.error?.message ?? result.stderr.trim()}`)
  return result.stdout.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.+)$/)
    return m ? [{ pid: Number(m[1]), parentPid: Number(m[2]), launchedAt: m[3].replace(/\s+/g, ' '), executable: m[4] }] : []
  })
}
const identity = (p) => `${p.pid}:${p.launchedAt}:${p.executable}`
const validProcess = (p) => Number.isInteger(p.pid) && p.pid > 0 && typeof p.launchedAt === 'string' && p.launchedAt.length > 0 && typeof p.executable === 'string' && p.executable.length > 0
const files = (dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : []

export async function runOwned({ dir, freezeId, owner, fixtures = [], command }) {
  if (!valid(freezeId) || !valid(owner) || !command.length) throw new Error('Valid freeze ID, owner and command required')
  const root = join(dir, freezeId, 'workloads'); mkdirSync(root, { recursive: true })
  const record = { freezeId, owner, startedAt: now(), finishedAt: null, exitCode: null,
    fixtures: fixtures.map((p) => resolve(p)), processes: [], processQuiet: false, fixturesDisposed: false }
  const path = join(root, `${owner}-${Date.now()}-${process.pid}.json`)
  processInventory() // Fail before launching any owned work if inventory is unavailable.
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env })
  record.child = { pid: child.pid, spawnedAt: now() }
  const known = new Map()
  const observe = () => {
    const inventory = processInventory()
    const family = new Set([child.pid])
    let changed = true
    while (changed) { changed = false; for (const p of inventory) if (family.has(p.parentPid) && !family.has(p.pid)) { family.add(p.pid); changed = true } }
    for (const p of inventory) if (family.has(p.pid)) known.set(identity(p), p)
    record.processes = [...known.values()]; save(path, record)
  }
  observe()
  const timer = setInterval(() => {
    try { observe() } catch (error) { record.inventoryError = error.message; child.kill('SIGTERM') }
  }, 500)
  try {
    const outcome = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })) })
    record.finishedAt = now(); record.exitCode = outcome.code; record.signal = outcome.signal
  } finally {
    clearInterval(timer)
    const active = new Set(processInventory().map(identity))
    record.processQuiet = !record.inventoryError && record.processes.every((p) => !active.has(identity(p)))
    record.fixturesDisposed = record.fixtures.every((p) => !existsSync(p))
    record.checkedAt = now(); save(path, record)
  }
  return { path, ...record }
}

export function acknowledge({ dir, freezeId, owner, noWorkloads = false, fixtures = [] }) {
  if (!valid(freezeId) || !valid(owner)) throw new Error('Valid freeze ID and owner required')
  const root = join(dir, freezeId), workloadDir = join(root, 'workloads')
  const owned = files(workloadDir).filter((f) => JSON.parse(readFileSync(join(workloadDir, f), 'utf8')).owner === owner)
  if (!owned.length && !noWorkloads) throw new Error('No workload receipts; explicitly declare --no-workloads for an owner with no task workloads')
  const inventory = processInventory(), active = new Set(inventory.map(identity))
  const workloads = owned.map((file) => {
    const bytes = readFileSync(join(workloadDir, file)), r = JSON.parse(bytes)
    if (!r.finishedAt || r.processQuiet !== true || r.fixturesDisposed !== true || r.processes.some((p) => !validProcess(p) || active.has(identity(p)))) throw new Error(`Workload is not disposed: ${file}`)
    return { file, sha256: digest(bytes), finishedAt: r.finishedAt }
  })
  const fixturePaths = fixtures.map((p) => resolve(p))
  if (fixturePaths.some(existsSync)) throw new Error('A declared fixture path still exists')
  const ack = { freezeId, owner, checkedAt: now(), noWorkloads, workloads, fixturePaths,
    scope: 'Declared task-owned processes exited and fixtures disposed; owner holds new test/browser/fixture/build/typecheck work until release. Background machine load is not controlled.', inventory }
  mkdirSync(join(root, 'acks'), { recursive: true }); save(join(root, 'acks', `${owner}.json`), ack)
  return ack
}

export function checkQuiescence({ dir, freezeId, owners, maxAgeMs = 15 * 60_000 }) {
  if (!valid(freezeId) || !Array.isArray(owners) || !owners.length || owners.some((owner) => !valid(owner)) || new Set(owners).size !== owners.length) throw new Error('A valid freeze ID and nonempty unique owner set are required')
  const root = join(dir, freezeId), errors = [], acknowledgements = [], inventory = processInventory()
  const allFiles = files(join(root, 'workloads'))
  const current = new Set(inventory.map(identity))
  for (const owner of owners) {
    const path = join(root, 'acks', `${owner}.json`)
    if (!existsSync(path)) { errors.push(`Missing owner acknowledgement: ${owner}`); continue }
    const bytes = readFileSync(path), ack = JSON.parse(bytes)
    acknowledgements.push({ owner, sha256: digest(bytes), checkedAt: ack.checkedAt })
    if (ack.freezeId !== freezeId || ack.owner !== owner || !Number.isFinite(Date.parse(ack.checkedAt)) || Date.now() - Date.parse(ack.checkedAt) > maxAgeMs || Date.parse(ack.checkedAt) > Date.now()) errors.push(`Stale or mismatched acknowledgement: ${owner}`)
    if (!ack.workloads.length && ack.noWorkloads !== true) errors.push(`No explicit no-workload declaration: ${owner}`)
    const owned = allFiles.filter((f) => JSON.parse(readFileSync(join(root, 'workloads', f), 'utf8')).owner === owner)
    if (JSON.stringify(owned) !== JSON.stringify(ack.workloads.map((r) => r.file))) errors.push(`Workload set changed after acknowledgement: ${owner}`)
    for (const proof of ack.workloads) {
      const path = join(root, 'workloads', proof.file)
      if (!existsSync(path)) { errors.push(`Missing workload: ${proof.file}`); continue }
      const bytes = readFileSync(path), workload = JSON.parse(bytes)
      if (digest(bytes) !== proof.sha256 || workload.processQuiet !== true || !workload.finishedAt || workload.fixturesDisposed !== true) errors.push(`Changed or unfinished workload: ${proof.file}`)
      if (workload.processes.some((p) => !validProcess(p) || current.has(identity(p)))) errors.push(`Owned process remains active or lacks launch identity: ${proof.file}`)
      if (workload.fixtures.some(existsSync)) errors.push(`Owned fixture remains: ${proof.file}`)
    }
    if (ack.fixturePaths.some(existsSync)) errors.push(`Declared fixture remains: ${owner}`)
  }
  return { checkedAt: now(), freezeId, owners, controlledTaskWorkload: errors.length === 0, errors, acknowledgements, inventory,
    limitation: 'Read-only inventory and owner-declared task workload hold; unrelated machine/background load is recorded, not excluded.' }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mode = process.argv[2], opts = { fixtures: [] }, args = process.argv.slice(3)
  for (let i = 0; i < args.length; i++) {
    const a = args[i], next = () => { if (!args[i + 1]) throw new Error(`Missing value: ${a}`); return args[++i] }
    if (a === '--') { opts.command = args.slice(i + 1); break }
    if (a === '--dir') opts.dir = resolve(next())
    else if (a === '--freeze-id') opts.freezeId = next()
    else if (a === '--owner') opts.owner = next()
    else if (a === '--owners') opts.owners = next().split(',')
    else if (a === '--fixture') opts.fixtures.push(next())
    else if (a === '--no-workloads') opts.noWorkloads = true
    else throw new Error(`Unknown option: ${a}`)
  }
  if (!opts.dir || !opts.freezeId) throw new Error('--dir and --freeze-id required')
  const result = mode === 'run' ? await runOwned(opts) : mode === 'ack' ? acknowledge(opts) : mode === 'check' ? checkQuiescence(opts) : (() => { throw new Error('Use run, ack or check') })()
  console.log(JSON.stringify(result))
  if (mode === 'run') process.exitCode = result.exitCode ?? 1
  if (mode === 'check' && !result.controlledTaskWorkload) process.exitCode = 1
}
