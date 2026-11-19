#!/usr/bin/env node
/** Owned engine-only fixture; never opens application or personal databases. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../../../../packages/api/package.json', import.meta.url))
const pg = require('pg')
const opts = {}
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]
  if (!['--pg-bin', '--collector', '--out', '--source-tar'].includes(a) || !process.argv[i + 1]) throw new Error(`Invalid option ${a}`)
  opts[a.slice(2)] = resolve(process.argv[++i])
}
for (const key of ['pg-bin', 'collector', 'out']) if (!opts[key]) throw new Error(`--${key} required`)
if (existsSync(opts.out)) throw new Error('Choose a fresh calibration output directory')
mkdirSync(opts.out, { recursive: true })
const data = join(opts.out, 'data'), socket = join(opts.out, 'socket')
if (Buffer.byteLength(join(socket, '.s.PGSQL.55418')) > 100) throw new Error('Choose a shorter owned output path')
mkdirSync(socket, { mode: 0o700 })
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const config = spawnSync(join(opts['pg-bin'], 'pg_config'), ['--configure'], { encoding: 'utf8' })
if (config.status !== 0) throw new Error('Cannot bind calibration to the engine configuration')
const record = { startedAt: new Date().toISOString(), scope: 'Fixture-only PG18.7 post-optimization primitive calibration; not product latency or complete chat permission accounting',
  binarySha256: sha(join(opts['pg-bin'], 'postgres')), collectorSha256: sha(opts.collector),
  configure: config.stdout.trim(), sourceArchiveSha256: opts['source-tar'] ? sha(opts['source-tar']) : null,
  recipeSha256: sha(join(dirname(fileURLToPath(import.meta.url)), 'patch.py')), cells: [], disposed: false }
const save = () => writeFileSync(join(opts.out, 'receipt.json'), JSON.stringify(record, null, 2) + '\n')
const command = (name, args) => {
  const result = spawnSync(join(opts['pg-bin'], name), args, { encoding: 'utf8', timeout: 30_000 })
  writeFileSync(join(opts.out, `${name}-${Date.now()}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  if (result.status !== 0) throw new Error(`${name} failed: ${result.error?.message ?? result.stderr}`)
}
let client, started = false
try {
  const user = 'm6_calibration_owner'
  command('initdb', ['-D', data, '--username', user, '--auth=trust', '--no-locale', '--encoding=UTF8'])
  command('pg_ctl', ['-D', data, '-l', join(opts.out, 'postgres.log'), '-o', `-k ${socket} -p 55418 -c listen_addresses='' -c jit=off`, 'start'])
  started = true
  client = new pg.Client({ host: socket, port: 55418, database: 'postgres', user }); await client.connect()
  record.database = (await client.query('SELECT version() AS version, current_setting(\'server_version_num\') AS number')).rows[0]
  if (record.database.number !== '180007') throw new Error('Calibration requires PostgreSQL 18.7')
  const library = opts.collector.replaceAll("'", "''")
  await client.query(`CREATE FUNCTION m6_probe_arm(boolean) RETURNS void AS '${library}','m6_probe_arm' LANGUAGE C STRICT;
    CREATE FUNCTION m6_probe_result() RETURNS jsonb AS '${library}','m6_probe_result' LANGUAGE C STRICT;
    CREATE ROLE m6_calibration_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE m6_calibration_link NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE m6_calibration_child NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE m6_calibration_unrelated NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT m6_calibration_link TO m6_calibration_child, m6_calibration_runtime;
    CREATE TABLE a(id integer PRIMARY KEY, tags integer[] NOT NULL);
    CREATE TABLE b(id integer PRIMARY KEY);
    INSERT INTO a SELECT n,ARRAY[n%7] FROM generate_series(1,256)n;
    INSERT INTO b SELECT n FROM generate_series(1,128)n;
    CREATE INDEX a_tags_gin ON a USING gin(tags);
    CREATE FUNCTION m6_inline_allow(integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1 % 2 = 0';
    CREATE FUNCTION m6_strict_allow(integer) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS 'SELECT $1 > 0';
    CREATE FUNCTION m6_definer_allow() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT true';
    CREATE TABLE r(id integer PRIMARY KEY, allowed boolean NOT NULL);
    INSERT INTO r SELECT n,n%3<>0 FROM generate_series(1,32)n;
    ALTER TABLE r ENABLE ROW LEVEL SECURITY; ALTER TABLE r FORCE ROW LEVEL SECURITY;
    CREATE POLICY r_read ON r FOR SELECT TO m6_calibration_runtime USING(allowed AND id%2=0);
    CREATE FUNCTION m6_definer_rls_active() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
      AS 'SELECT row_security_active(''public.r''::regclass)';
    CREATE TABLE inherited_read(id integer PRIMARY KEY);
    INSERT INTO inherited_read VALUES (1);
    GRANT SELECT ON a,b,r TO m6_calibration_runtime;
    GRANT SELECT ON inherited_read TO m6_calibration_link;`)
  for (const table of ['a', 'b', 'r', 'inherited_read']) await client.query(`VACUUM FREEZE ANALYZE ${table}`)
  await client.query('SET ROLE m6_calibration_runtime')
  const cases = [
    { name: 'inlined-allow', sql: 'SELECT id FROM a WHERE m6_inline_allow(id) AND id<16 ORDER BY id', expected: 'supported',
      preparation: { 'planner:sql-inline': null, 'permission:rls-not-applicable': 1 } },
    { name: 'inlined-deny', sql: 'SELECT id FROM a WHERE m6_inline_allow(id) AND id%2=1 ORDER BY id', expected: 'supported' },
    { name: 'folded-function-allow', sql: 'SELECT m6_inline_allow(2) AS allowed', expected: 'supported',
      preparation: { 'planner:constant-function': null, 'planner:constant-expression-eval': null } },
    { name: 'strict-null-elision', sql: 'SELECT m6_strict_allow(NULL::integer) AS allowed', expected: 'supported',
      preparation: { 'planner:strict-null-elision': 1, 'planner:constant-function': 0 } },
    { name: 'rls-allow', sql: 'SELECT id FROM r ORDER BY id', expected: 'supported',
      counters: { 'permission:acl-direct-entry': null }, preparation: { 'permission:rls-applied': 1 } },
    { name: 'rls-deny', sql: 'SELECT id FROM r WHERE NOT allowed ORDER BY id', expected: 'supported' },
    { name: 'inherited-role-comparison', sql: `SELECT pg_has_role('m6_calibration_child','m6_calibration_link','USAGE') AS member,
        pg_has_role('m6_calibration_unrelated','m6_calibration_link','USAGE') AS unrelated`, expected: 'supported',
      counters: { 'permission:role-membership-grant-visit': 1, 'permission:role-inherited-compare': null } },
    { name: 'inherited-acl-entry', sql: 'SELECT id FROM inherited_read', expected: 'supported',
      counters: { 'permission:acl-inherited-entry': null, 'permission:role-inherited-compare': null } },
    { name: 'definer-body-entry', sql: 'SELECT m6_definer_allow() AS allowed', expected: 'supported',
      counters: { 'permission:definer-body-entry': 1 } },
    { name: 'definer-rls-bypass', sql: 'SELECT m6_definer_rls_active() AS active', expected: 'supported',
      counters: { 'permission:definer-body-entry': 1, 'permission:rls-bypassed': 1 } },
    { name: 'linear-scalar-array', sql: 'SELECT id, id = ANY(ARRAY[1,NULL::integer,3]) AS allowed FROM a WHERE id <= 4 ORDER BY id',
      expected: 'supported', counters: { 'scalar-array:linear-compare': 7 } },
    { name: 'hashed-scalar-array', sql: 'SELECT id, id = ANY(ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,NULL::integer]) AS allowed FROM a WHERE id <= 4 ORDER BY id',
      expected: 'supported', counters: { 'scalar-array:hash-key': null, 'scalar-array:hash-equality': null } },
    { name: 'index-only', settings: 'SET enable_seqscan=off;SET enable_bitmapscan=off', sql: 'SELECT id FROM a WHERE id BETWEEN 10 AND 20 ORDER BY id', expected: 'supported', node: 'IndexOnlyScan' },
    { name: 'hash-join', settings: 'SET enable_nestloop=off;SET enable_mergejoin=off', sql: 'SELECT a.id FROM a JOIN b USING(id) WHERE a.id<33 ORDER BY a.id',
      expected: 'supported', node: 'HashJoin', counters: { 'hash-join-tuple-qualification': 32 } },
    { name: 'merge-join', settings: 'SET enable_nestloop=off;SET enable_hashjoin=off', sql: 'SELECT a.id FROM a JOIN b USING(id) WHERE a.id<33 ORDER BY a.id',
      expected: 'supported', node: 'MergeJoin', counters: { 'merge-join-key-comparator': null } },
    { name: 'hashed-subplan-null-key', sql: 'SELECT id, (id, tags[1]) IN (SELECT id, CASE WHEN id=1 THEN NULL ELSE id%7 END FROM b WHERE id<=6) AS allowed FROM a WHERE id<=4 ORDER BY id',
      expected: 'supported', counters: { 'hashed-subplan-null-key-comparator': null } },
    { name: 'int32-sort', sql: 'SELECT id FROM a ORDER BY (id*11)%17,id', expected: 'supported', node: 'Sort',
      counters: { 'sort-int32-comparison': null } },
    { name: 'signed-sort', sql: 'SELECT id FROM a ORDER BY (id::bigint*11)%17,id', expected: 'supported', node: 'Sort',
      counters: { 'sort-signed-comparison': null } },
    { name: 'abbreviated-sort-tie', sql: `SELECT id,(lpad(((id*11)%251%127)::text,8,'0')||id::text) COLLATE "C" AS label
      FROM a ORDER BY label,id`, expected: 'supported', node: 'Sort',
      counters: { 'sort-abbrev-full-comparator': null, 'sort-unsigned-comparison': null } },
    { name: 'planned-never-executed', sql: 'SELECT id FROM a WHERE (SELECT false OFFSET 0) AND id=1', expected: 'supported', neverExecuted: 'IndexOnlyScan' },
    { name: 'unsupported-gin', settings: 'SET enable_seqscan=off', sql: 'SELECT id FROM a WHERE tags @> ARRAY[3] ORDER BY id', expected: 'unsupported', am: 'gin' },
  ]
  for (const cell of cases) {
    await client.query('RESET enable_seqscan;RESET enable_bitmapscan;RESET enable_nestloop;RESET enable_hashjoin;RESET enable_mergejoin')
    if (cell.settings) await client.query(cell.settings)
    const query = `/* m6-measure */ ${cell.sql}`
    await client.query('SELECT m6_probe_arm(false)')
    const offRows = (await client.query(query)).rows
    const off = (await client.query('SELECT m6_probe_result() AS value')).rows[0].value
    await client.query('SELECT m6_probe_arm(true)')
    const onRows = (await client.query(query)).rows
    const on = (await client.query('SELECT m6_probe_result() AS value')).rows[0].value
    const sameRows = JSON.stringify(offRows) === JSON.stringify(onRows), samePlan = off.chosenPlan === on.chosenPlan
    const executed = on.executedNodes.map((n) => n.node)
    const countersMatch = (expected, enabled, disabled) => Object.entries(expected ?? {}).every(([kind, calls]) => {
      const measured = enabled.filter(counter => counter.kind === kind).reduce((sum, counter) => sum + counter.calls, 0)
      return !disabled.some(counter => counter.kind === kind) && (calls === null ? measured > 0 : measured === calls)
    })
    const valid = sameRows && samePlan && (cell.expected === 'supported' ? on.calibrationCoverageComplete : !on.calibrationCoverageComplete)
      && on.preparationOverflow === false && off.preparationCounters.length === 0
      && countersMatch(cell.counters, on.counters, off.counters)
      && countersMatch(cell.preparation, on.preparationCounters, off.preparationCounters)
      && (!cell.node || executed.includes(cell.node)) && (!cell.am || on.executedNodes.some((n) => n.am === cell.am))
      && (!cell.neverExecuted || (on.chosenPlan.includes(`:${cell.neverExecuted.toLowerCase()}`) || on.chosenPlan.toUpperCase().includes(cell.neverExecuted.toUpperCase())) && !executed.includes(cell.neverExecuted))
    record.cells.push({ ...cell, sameRows, samePlan, rowCount: onRows.length, valid, off, on }); save()
  }
  record.calibrationPassed = record.cells.every((c) => c.valid)
  record.physicalPermissionCoverageComplete = false
  if (!record.calibrationPassed) process.exitCode = 1
} catch (error) { record.failure = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
  await client?.end().catch(() => {})
  if (started) command('pg_ctl', ['-D', data, '-m', 'fast', 'stop'])
  rmSync(data, { recursive: true, force: true }); rmSync(socket, { recursive: true, force: true })
  record.disposed = true; record.finishedAt = new Date().toISOString(); save()
}
console.log(JSON.stringify({ out: opts.out, passed: record.calibrationPassed, failure: record.failure, disposed: record.disposed }))
