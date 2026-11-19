#!/usr/bin/env node
/** Diagnostic-only SQL copies on a newly owned8267 predecessor, always rolled back. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const opts = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = { '--oss-root': 'root', '--pg-bin': 'pgBin', '--out': 'out' }[process.argv[i]]
  if (!key || !process.argv[i + 1]) throw new Error('Supply --oss-root, --pg-bin and --out')
  opts[key] = resolve(process.argv[++i])
}
if (!opts.root || !opts.pgBin || !opts.out || existsSync(opts.out)) throw new Error('Explicit paths and new output required')
mkdirSync(opts.out, { recursive: true })
const pg = createRequire(join(opts.root, 'packages/api/package.json'))('pg')
const file = join(opts.root, 'packages/api/migrations/8268_private_transcript_preparation_eligibility.sql')
const original = readFileSync(file, 'utf8'), sha = (s) => createHash('sha256').update(s).digest('hex')
const target = "RAISE EXCEPTION 'private_transcript_preparation_successor_contract_changed: %',saved.name;"
if (original.split(target).length !== 2 || !original.endsWith('COMMIT;\n')) throw new Error('Exact8268 diagnostic seam changed')
const diagnostic = original.replace(target, target.slice(0, -1) + " USING DETAIL=jsonb_build_object('name',saved.name,'before',saved.catalog,'after',catalog,'rowsEqual',registry_rows IS NOT DISTINCT FROM saved.rows)::text;").replace(/COMMIT;\n$/, 'ROLLBACK;\n')
const record = { startedAt: new Date().toISOString(), root: opts.root, sourceSha256: sha(original), runs: [],
  scope: 'Diagnostic copies only, no applied migration edits; controlled ANALYZE demonstrates susceptibility separately from the unknown original incident cause' }
const save = () => writeFileSync(join(opts.out, 'receipt.json'), JSON.stringify(record, null, 2) + '\n')
function differences(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return [{ path, before, after }]
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => differences(before[key], after[key], path ? `${path}.${key}` : key))
}
const { createLocalFixture } = await import(pathToFileURL(join(opts.root, 'scripts/crm/local-fixture.mjs')).href)
try {
  await createLocalFixture({ pgBin: opts.pgBin, ordinaryOwner: true,
    beforeApplyFile: '8268_private_transcript_preparation_eligibility.sql', beforeApply: async ({ adminUrl }) => {
      const client = new pg.Client({ connectionString: adminUrl }), other = new pg.Client({ connectionString: adminUrl })
      await client.connect(); await other.connect()
      try {
        const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
        for (const controlled of [false, true]) {
          const run = { controlledAnalyze: controlled, startedAt: new Date().toISOString() }; record.runs.push(run); save()
          const key = 837501
          if (controlled) await other.query('SELECT pg_advisory_lock($1)', [key])
          const sql = controlled ? diagnostic.replace('DO $successor$', `SELECT pg_advisory_lock(${key});SELECT pg_advisory_unlock(${key});\nDO $successor$`) : diagnostic
          const work = client.query(sql).then(() => ({ success: true }), (error) => ({ error }))
          if (controlled) {
            let waiting = false
            for (let n = 0; n < 100; n++) { if ((await other.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting) { waiting = true; break } await delay(20) }
            if (!waiting) throw new Error('Controlled probe did not reach its exact successor barrier')
            run.beforeAnalyze = (await other.query("SELECT to_jsonb(c) AS value FROM pg_class c WHERE oid='public.native_turn_contract_helpers'::regclass")).rows[0].value
            await other.query('ANALYZE public.native_turn_contract_helpers')
            run.afterAnalyze = (await other.query("SELECT to_jsonb(c) AS value FROM pg_class c WHERE oid='public.native_turn_contract_helpers'::regclass")).rows[0].value
            await other.query('SELECT pg_advisory_unlock($1)', [key])
          }
          const outcome = await work
          if (outcome.error) {
            run.error = { code: outcome.error.code, message: outcome.error.message, where: outcome.error.where }
            if (outcome.error.detail) { const detail = JSON.parse(outcome.error.detail); run.catalogDifferences = differences(detail.before, detail.after); run.registryRowsEqual = detail.rowsEqual }
          } else run.success = true
          await client.query('ROLLBACK'); run.finishedAt = new Date().toISOString(); save()
        }
      } finally { await client.query('ROLLBACK').catch(() => {}); await other.query('SELECT pg_advisory_unlock_all()').catch(() => {}); await client.end(); await other.end() }
      throw new Error('M6_DIAGNOSTIC_COMPLETE_EXPECTED_STOP')
    } })
} catch (error) { record.fixtureOutcome = error.message; record.expectedDiagnosticStop = error.message.includes('M6_DIAGNOSTIC_COMPLETE_EXPECTED_STOP') }
finally { record.finishedAt = new Date().toISOString(); record.sourceUnchanged = sha(readFileSync(file)) === record.sourceSha256; save() }
console.log(JSON.stringify({ out: opts.out, expectedStop: record.expectedDiagnosticStop, runs: record.runs.map((r) => ({ controlled: r.controlledAnalyze, success: r.success, error: r.error, differences: r.catalogDifferences })) }))
if (!record.expectedDiagnosticStop) process.exitCode = 1
