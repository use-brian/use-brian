import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { tmpdir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import { createAcceptanceReport, mergeAcceptanceReports, parseShard, suitesForShard } from './testing/department-isolation-report.mjs'
import {
  DEPARTMENT_ISOLATION_BOUNDARIES,
  DEPARTMENT_ISOLATION_CASES,
  DEPARTMENT_ISOLATION_SUITES,
  departmentIsolationManifestCoverage,
} from '../packages/shared/src/department-isolation-coverage.ts'
import { createLocalFixture, runCommand, cleanRuntimeEnvironment, validateAmbientDatabase } from './crm/local-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
let pgBin = process.env.BRIAN_TEST_PG_BIN
let foundation = false
let reportPath
let shard = null
let profile = 'full'
let mergeDirectory
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--profile' && args[i + 1]) profile = args[++i]
  else if (args[i] === '--foundation') foundation = true
  else if (args[i] === '--shard' && args[i + 1]) shard = parseShard(args[++i])
  else if (args[i] === '--merge' && args[i + 1]) mergeDirectory = args[++i]
  else if (args[i] === '--pg-bin' && args[i + 1]) pgBin = args[++i]
  else if (args[i] === '--report' && args[i + 1]) reportPath = args[++i]
  else throw new Error(`Unknown or incomplete option: ${args[i]}`)
}
suitesForShard(shard, profile)
if ((foundation && (shard || mergeDirectory)) || (shard && mergeDirectory)) throw new Error('--foundation, --shard and --merge are mutually exclusive')
if (reportPath && !isAbsolute(reportPath)) throw new Error('--report must be an absolute JSON path')
if (!foundation && !reportPath) throw new Error('Full mode requires --report <absolute-json-path>')

const sha256 = value => createHash('sha256').update(value).digest('hex')
const relTest = (suite, testFile) => join(suite.packageDir, testFile)
const relevantPaths = new Set([
  'scripts/test-department-isolation.mjs',
  'scripts/testing/department-isolation-report.mjs',
  'scripts/crm/local-fixture.mjs',
  'apps/api/src/__tests__/prepared-pglite.ts',
  'apps/api/src/__tests__/context-scope-migration-upgrade.ts',
  'apps/api/src/migrate-pglite.ts',
  'packages/api/src/migrations/execution-sql.ts',
  'packages/api/src/migrations/pglite-sql.ts',
  'packages/api/scripts/migrate.ts',
  'packages/api/scripts/migration-diagnostics.ts',
  'scripts/__tests__/migration-diagnostics.integration.test.mjs',
  'packages/shared/src/department-isolation-coverage.ts',
  ...DEPARTMENT_ISOLATION_BOUNDARIES.flatMap(boundary => boundary.sourcePaths),
  ...DEPARTMENT_ISOLATION_SUITES.flatMap(suite => suite.testFiles.map(file => relTest(suite,file))),
])

async function hashes(paths) {
  const result = {}
  for (const path of [...paths].sort()) {
    const absolute = join(root,path)
    if (!(await stat(absolute).catch(()=>null))?.isFile()) continue
    result[path] = sha256(await readFile(absolute))
  }
  return result
}

async function dirtySourceHashes(env) {
  const output = await runCommand('git',['status','--porcelain=v1','--untracked-files=all'],{cwd:root,env})
  const dirty = new Set(output.split('\n').filter(Boolean).map(line=>{
    const path=line.slice(3).trim()
    const renamed=path.includes(' -> ')?path.slice(path.lastIndexOf(' -> ')+4):path
    return renamed.replace(/^"|"$/g,'')
  }).filter(path=>relevantPaths.has(path)))
  return hashes(dirty)
}

function flattenAssertions(report,suite) {
  return (report?.testResults??[]).flatMap(result=>(result.assertionResults??[]).map(assertion=>({
    suiteId:suite.id,
    testFile:relative(join(root,suite.packageDir),result.name).replaceAll('\\','/'),
    fullName:assertion.fullName,
    title:assertion.title,
    status:assertion.status,
    durationMs:assertion.duration??null,
    failures:(assertion.failureMessages??[]).map(value=>String(value).slice(0,2_000)),
  })))
}

const xmlValue = value => value.replaceAll('&quot;','"').replaceAll('&apos;',"'").replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&amp;','&')
function flattenNodeAssertions(report,suite) {
  const assertions=[]
  for(const match of report.matchAll(/<testcase\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)){
    const attributes=Object.fromEntries([...match[1].matchAll(/([a-z]+)="([^"]*)"/g)].map(item=>[item[1],xmlValue(item[2])]))
    const body=match[2]??''
    const testFile=attributes.file
      ? relative(join(root,suite.packageDir),attributes.file).replaceAll('\\','/')
      : suite.testFiles.length===1?suite.testFiles[0]:''
    assertions.push({suiteId:suite.id,testFile,
      fullName:attributes.name??'',title:attributes.name??'',status:body.includes('<failure')||body.includes('<error')?'failed':body.includes('<skipped')?'skipped':'passed',
      durationMs:Number.isFinite(Number(attributes.time))?Number(attributes.time)*1_000:null,
      failures:body.includes('<failure')||body.includes('<error')?[body.replace(/<[^>]+>/g,' ').trim().slice(0,2_000)]:[]})
  }
  return assertions
}


async function migrationRevision(url) {
  if (!url) {
    const rows = (await readdir(join(root, 'packages/api/migrations'))).filter(name => name.endsWith('.sql')).sort()
    return { latest: rows.at(-1), count: rows.length, ledgerHash: sha256(rows.join('\n')) }
  }
  const client=new pg.Client({connectionString:url})
  await client.connect()
  try {
    const rows=(await client.query('SELECT name FROM public._migrations ORDER BY name')).rows.map(row=>row.name)
    return {latest:rows.at(-1)??null,count:rows.length,ledgerHash:sha256(rows.join('\n'))}
  } finally {await client.end()}
}

async function currentMetadata(env) {
  const migrations = (await readdir(join(root, 'packages/api/migrations')))
    .filter(name => name.endsWith('.sql')).map(name => `packages/api/migrations/${name}`)
  return {
    revision: (await runCommand('git', ['rev-parse', 'HEAD'], { cwd: root, env })).trim(),
    sourceHashes: await hashes(new Set([...relevantPaths, ...migrations])), dirtySourceHashes: await dirtySourceHashes(env),
  }
}

async function saveReport(report) {
  if (report.mode === 'full' && report.cases.length !== DEPARTMENT_ISOLATION_CASES.length) {
    throw new Error('Full acceptance report is missing registered cases')
  }
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  console.log(JSON.stringify({ mode: report.mode, profile: report.profile, profileAccepted: report.profileAccepted, revision: report.revision, report: reportPath ?? null,
    ...report.counts, fullMatrixAccepted: report.fullMatrixAccepted }))
}

async function run() {
  validateAmbientDatabase(process.env)
  const manifestCoverage=departmentIsolationManifestCoverage()
  if(!manifestCoverage.complete)throw new Error(`Department isolation manifest is incomplete: ${JSON.stringify(manifestCoverage)}`)
  const metadata = await currentMetadata(cleanRuntimeEnvironment(process.env))
  if (mergeDirectory) {
    const paths = (await readdir(mergeDirectory)).filter(path => /^department-isolation-\d+\.json$/.test(path)).sort()
    const reports = await Promise.all(paths.map(async path => JSON.parse(await readFile(join(mergeDirectory, path), 'utf8'))))
    const report = mergeAcceptanceReports(reports, metadata, profile)
    await saveReport(report)
    if (!report.profileAccepted) throw new Error(`Department isolation acceptance failed; report: ${reportPath}`)
    return
  }
  const selectedSuites=foundation
    ? DEPARTMENT_ISOLATION_SUITES.filter(suite=>!['review-lifecycle','ui','compatibility'].includes(suite.id))
    : suitesForShard(shard, profile)
  const native = selectedSuites.some(suite => suite.packageDir !== 'apps/api')
  const preparationStarted = Date.now()
  console.log(`Preparing ${native ? 'native PostgreSQL' : 'embedded acceptance'} fixture`)
  const fixture = native ? await createLocalFixture({ pgBin, prepareTemplate: true, migrationProgress: true }) : {
    directory: await mkdtemp(join(tmpdir(), 'brian-isolation-report-')), env: {},
    async dispose() { await rm(this.directory, { recursive: true, force: true }) },
  }
  console.log(`Prepared fixture in ${Math.round((Date.now() - preparationStarted) / 1000)}s`)
  try {
    if(reportPath&&resolve(reportPath).startsWith(`${resolve(fixture.directory)}/`))throw new Error('--report must be outside the disposable fixture')
    const reports = join(fixture.directory, 'reports')
    await mkdir(reports)
    const runtime=cleanRuntimeEnvironment(process.env)
    const env = {
      ...runtime,...fixture.env,...(fixture.adminUrl ? { CONTEXT_SCOPE_TEST_DATABASE_URL:fixture.adminUrl } : {}),
      CI:'true',GEMINI_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',BRIAN_TEST_NO_PAID:'1',
    }
    if (native) await runCommand('node', ['--test', 'scripts/__tests__/prepared-fixture.integration.test.mjs',
      'scripts/__tests__/migration-diagnostics.integration.test.mjs'], { cwd: root, env, inherit: true })
    const suiteResults=[]
    const assertions=[]
    for (const suite of selectedSuites) {
      const startedAt = Date.now()
      console.log(`Starting acceptance suite ${suite.id} (${suite.testFiles.length} files)`)
      const nodeSuite=suite.packageDir==='apps/api'
      const outputFile = join(reports, suite.id+(nodeSuite?'.xml':'.json'))
      const executionErrors=[]
      let actual=[]
      if(nodeSuite){
        try {
          await runCommand('node',[
            '--import','tsx','--test','--test-concurrency=1','--test-reporter=junit',
            `--test-reporter-destination=${outputFile}`,...suite.testFiles,
          ],{
            cwd:join(root,suite.packageDir),env,
            // Keep diagnostics separate from the machine-readable reporter. The
            // shared command helper intentionally merges stdout and stderr; a
            // warning interleaved into JUnit XML would make a passing assertion
            // impossible to bind to its A01-A18 evidence selector.
            logPath:join(reports,`${suite.id}.log`),
          })
        } catch(error) {executionErrors.push(error instanceof Error?error.message:String(error))}
        const raw=await readFile(outputFile,'utf8').catch(()=>'')
        actual=flattenNodeAssertions(raw,suite)
      } else {
        // Integration files share one disposable database and deliberately
        // exercise DDL/transaction locks. Run them sequentially in fresh
        // processes so sibling files cannot deadlock or leak module mocks.
        // Route tests also open many short-lived Supertest listeners and some
        // legacy files install process-level mocks, so the manifest may request
        // the same isolation. The runner still aggregates every assertion into
        // one acceptance receipt.
        const isolateFiles=suite.integration||suite.processIsolation==='file'
        const groups=isolateFiles?suite.testFiles.map(file=>[file]):[[...suite.testFiles]]
        for(const [index,testFiles] of groups.entries()){
          const resultFile=groups.length===1?outputFile:join(reports,`${suite.id}-${index}.json`)
          const integrationGroup=testFiles.every(file=>file.endsWith('.integration.test.ts'))
          try {
            await runCommand('pnpm', ['exec', 'vitest', 'run',
                ...(integrationGroup?['--config','vitest.integration.config.ts']:[]),
                ...testFiles,'--reporter=default','--reporter=json',`--outputFile=${resultFile}`],
              { cwd:join(root,suite.packageDir), env, inherit:true })
          } catch(error) {executionErrors.push(error instanceof Error?error.message:String(error))}
          const raw=await readFile(resultFile,'utf8').catch(()=>JSON.stringify({testResults:[]}))
          actual.push(...flattenAssertions(JSON.parse(raw),suite))
        }
      }
      const executionError=executionErrors.length?executionErrors.join('; '):null
      console.log(`Finished acceptance suite ${suite.id} in ${Math.round((Date.now() - startedAt) / 1000)}s`)
      assertions.push(...actual)
      const passed=actual.filter(assertion=>assertion.status==='passed').length
      const failed=actual.filter(assertion=>assertion.status==='failed').length
      const skipped=actual.length-passed-failed
      suiteResults.push({id:suite.id,durationMs:Date.now()-startedAt,testFiles:[...suite.testFiles],actual:actual.length,passed,failed,skipped,
        failures:actual.filter(assertion=>assertion.status!=='passed').map(assertion=>({testFile:assertion.testFile,fullName:assertion.fullName,status:assertion.status,failures:assertion.failures})),executionError})
    }
    if (!isDeepStrictEqual(metadata, await currentMetadata(env))) throw new Error('Source changed during acceptance execution')
    const finalReport = createAcceptanceReport({
      metadata: { ...metadata, migration: await migrationRevision(fixture.adminUrl) },
      suites: suiteResults, assertions, foundation, shard, profile,
    })
    await saveReport(finalReport)
    if (!finalReport.suitesPassed || (!foundation && !shard && !finalReport.profileAccepted)) {
      throw new Error(`Department isolation acceptance failed; report: ${reportPath}`)
    }
  } finally { await fixture.dispose() }
}
run().catch(error => { console.error(error.message); process.exitCode = 1 })
