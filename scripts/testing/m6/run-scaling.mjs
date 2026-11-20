#!/usr/bin/env node
/** [COMP:tooling/m6-qualification] The maintained six-axis workload on an
 * explicitly selected source tree. No source copies or product mutations. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, scalingStep, sourceIdentity } from './run-matrix.mjs'
import { fingerprint } from '../import-graph.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const opts = { root: resolve(here, '../../..') }
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i], next = () => { if (!process.argv[i + 1]) throw new Error(`missing value for ${arg}`); return process.argv[++i] }
  if (arg === '--oss-root') opts.root = resolve(next())
  else if (arg === '--pg-bin') opts.pgBin = resolve(next())
  else if (arg === '--out') opts.out = resolve(next())
  else throw new Error(`unknown argument ${arg}`)
}
if (!opts.out || !opts.pgBin) throw new Error('--out and --pg-bin are required')
if (existsSync(join(opts.out, 'run.json'))) throw new Error('scaling run already exists; choose a new output directory')
for (const dir of ['logs', 'raw']) mkdirSync(join(opts.out, dir), { recursive: true })
const paths = ['packages/api/src', 'packages/api/dist', 'packages/core/src', 'packages/core/dist', 'packages/agent-runtime/src', 'packages/agent-runtime/dist', 'packages/api/migrations']
const inputs = () => Object.fromEntries(paths.map(path => [path, fingerprint(join(opts.root, path))]))
const record = { tool: 'scripts/testing/m6/run-scaling.mjs', startedAt: new Date().toISOString(), root: opts.root,
  source: { start: sourceIdentity(opts.root) }, fingerprints: { start: inputs() },
  driverSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  measurement: 'Six independent axes on canonical data; source-bound observed curve, physical accounting and controlled-load qualification remain separate.' }
const ctx = { ossRoot: opts.root, out: opts.out, probes: { pg18: { pgBin: opts.pgBin } }, activeChildren: new Set(), activeFixtures: new Set(),
  rawDir: id => { const dir = join(opts.out, 'raw', id); mkdirSync(dir, { recursive: true }); return dir } }
writeFileSync(join(opts.out, 'run.json'), JSON.stringify(record, null, 2) + '\n')
try {
  const step = { id: 'fixed20-scaling', ...scalingStep() }
  const result = await step.run(ctx, step)
  record.step = { ...classify(result), ...result }
  process.exitCode = record.step.status === 'completed' ? 0 : 1
} catch (error) { record.step = { status: 'error', reason: error.message }; process.exitCode = 1 }
finally {
  record.finishedAt = new Date().toISOString(); record.source.end = sourceIdentity(opts.root); record.fingerprints.end = inputs()
  record.productInputsUnchanged = JSON.stringify(record.fingerprints.start) === JSON.stringify(record.fingerprints.end)
  if (!record.productInputsUnchanged) { record.inputQualification = 'changed source/build/migration inputs'; process.exitCode = 1 }
  writeFileSync(join(opts.out, 'run.json'), JSON.stringify(record, null, 2) + '\n')
}
console.log(JSON.stringify({ status: record.step.status, startedAt: record.startedAt, finishedAt: record.finishedAt,
  productInputsUnchanged: record.productInputsUnchanged, out: opts.out }))
