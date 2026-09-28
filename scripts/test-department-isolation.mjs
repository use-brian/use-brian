import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import {
  DEPARTMENT_ISOLATION_BOUNDARIES,
  DEPARTMENT_ISOLATION_CASES,
  DEPARTMENT_ISOLATION_CASE_IDS,
  DEPARTMENT_ISOLATION_MANIFEST_REVISION,
  DEPARTMENT_ISOLATION_SUITES,
  departmentIsolationManifestCoverage,
} from '../packages/shared/src/department-isolation-coverage.ts'
import { createLocalFixture, runCommand, cleanRuntimeEnvironment, validateAmbientDatabase } from './crm/local-fixture.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
let pgBin = process.env.BRIAN_TEST_PG_BIN
let foundation = false
let reportPath
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--foundation') foundation = true
  else if (args[i] === '--pg-bin' && args[i + 1]) pgBin = args[++i]
  else if (args[i] === '--report' && args[i + 1]) reportPath = args[++i]
  else throw new Error(`Unknown or incomplete option: ${args[i]}`)
}
if (reportPath && !isAbsolute(reportPath)) throw new Error('--report must be an absolute JSON path')
if (!foundation && !reportPath) throw new Error('Full mode requires --report <absolute-json-path>')

const sha256 = value => createHash('sha256').update(value).digest('hex')
const relTest = (suite, testFile) => join(suite.packageDir, testFile)
const relevantPaths = new Set([
  'scripts/test-department-isolation.mjs',
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

function evidenceFor(selectors,assertions) {
  return selectors.map(selector=>{
    const suiteAssertions=assertions.filter(assertion=>assertion.suiteId===selector.suiteId)
    const fileAssertions=suiteAssertions.filter(assertion=>assertion.testFile.endsWith(selector.testFile))
    const matches=fileAssertions.filter(assertion=>assertion.fullName.includes(selector.titleIncludes))
    return {
      ...selector,
      actual:matches.map(match=>({testFile:match.testFile,fullName:match.fullName,status:match.status,durationMs:match.durationMs})),
      passed:matches.length>0&&matches.every(match=>match.status==='passed'),
      ...(matches.length===0?{candidates:(fileAssertions.length?fileAssertions:suiteAssertions).map(match=>({
        testFile:match.testFile,fullName:match.fullName,status:match.status,
      }))}:{}),
    }
  })
}

async function migrationRevision(url) {
  const client=new pg.Client({connectionString:url})
  await client.connect()
  try {
    const rows=(await client.query('SELECT name FROM public._migrations ORDER BY name')).rows.map(row=>row.name)
    return {latest:rows.at(-1)??null,count:rows.length,ledgerHash:sha256(rows.join('\n'))}
  } finally {await client.end()}
}

async function run() {
  validateAmbientDatabase(process.env)
  const manifestCoverage=departmentIsolationManifestCoverage()
  if(!manifestCoverage.complete)throw new Error(`Department isolation manifest is incomplete: ${JSON.stringify(manifestCoverage)}`)
  const fixture = await createLocalFixture({ pgBin })
  try {
    if(reportPath&&resolve(reportPath).startsWith(`${resolve(fixture.directory)}/`))throw new Error('--report must be outside the disposable fixture')
    const reports = join(fixture.directory, 'reports')
    await mkdir(reports)
    const runtime=cleanRuntimeEnvironment(process.env)
    const env = {
      ...runtime,...fixture.env,CONTEXT_SCOPE_TEST_DATABASE_URL:fixture.adminUrl,
      CI:'true',GEMINI_API_KEY:'',OPENAI_API_KEY:'',ANTHROPIC_API_KEY:'',BRIAN_TEST_NO_PAID:'1',
    }
    const selectedSuites=foundation
      ? DEPARTMENT_ISOLATION_SUITES.filter(suite=>!['review-lifecycle','ui','compatibility'].includes(suite.id))
      : DEPARTMENT_ISOLATION_SUITES
    const suiteResults=[]
    const assertions=[]
    for (const suite of selectedSuites) {
      const nodeSuite=suite.packageDir==='apps/api'
      const outputFile = join(reports, suite.id+(nodeSuite?'.xml':'.json'))
      const executionErrors=[]
      let actual=[]
      if(nodeSuite){
        try {
          await runCommand('node',[
            '--import','tsx','--test','--test-reporter=junit',
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
        // Route tests open many short-lived Supertest listeners and several
        // legacy files install module mocks. A one-worker multi-file process
        // can leak that process state as a false 404 in a different file. The
        // manifest can require one process per file while this runner still
        // aggregates every assertion into one acceptance receipt.
        const groups=suite.processIsolation==='file'?suite.testFiles.map(file=>[file]):[[...suite.testFiles]]
        for(const [index,testFiles] of groups.entries()){
          const resultFile=groups.length===1?outputFile:join(reports,`${suite.id}-${index}.json`)
          try {
            await runCommand('pnpm', ['exec', 'vitest', 'run',
                ...(suite.integration?['--config','vitest.integration.config.ts']:[]),
                ...testFiles,'--reporter=default','--reporter=json',`--outputFile=${resultFile}`],
              { cwd:join(root,suite.packageDir), env, inherit:true })
          } catch(error) {executionErrors.push(error instanceof Error?error.message:String(error))}
          const raw=await readFile(resultFile,'utf8').catch(()=>JSON.stringify({testResults:[]}))
          actual.push(...flattenAssertions(JSON.parse(raw),suite))
        }
      }
      const executionError=executionErrors.length?executionErrors.join('; '):null
      assertions.push(...actual)
      const passed=actual.filter(assertion=>assertion.status==='passed').length
      const failed=actual.filter(assertion=>assertion.status==='failed').length
      const skipped=actual.length-passed-failed
      suiteResults.push({id:suite.id,testFiles:[...suite.testFiles],actual:actual.length,passed,failed,skipped,
        failures:actual.filter(assertion=>assertion.status!=='passed').map(assertion=>({testFile:assertion.testFile,fullName:assertion.fullName,status:assertion.status,failures:assertion.failures})),executionError})
    }
    const cases=foundation?[]:DEPARTMENT_ISOLATION_CASES.map(entry=>{
      const evidence=evidenceFor(entry.assertions,assertions)
      return{id:entry.id,passed:evidence.length>0&&evidence.every(item=>item.passed),evidence}
    })
    const boundaries=foundation?[]:DEPARTMENT_ISOLATION_BOUNDARIES.map(entry=>{
      const evidence=evidenceFor(entry.tests,assertions)
      return{id:entry.id,family:entry.family,cases:[...entry.cases],passed:evidence.length>0&&evidence.every(item=>item.passed),evidence}
    })
    const suiteFailures=suiteResults.some(suite=>suite.executionError||suite.actual===0||suite.failed>0||suite.skipped>0)
    const caseCoverage=new Set(cases.map(entry=>entry.id))
    const manifestCasesComplete=DEPARTMENT_ISOLATION_CASE_IDS.every(id=>caseCoverage.has(id))
    const fullMatrixAccepted=!foundation&&manifestCoverage.complete&&manifestCasesComplete&&!suiteFailures
      &&cases.length===DEPARTMENT_ISOLATION_CASE_IDS.length&&cases.every(entry=>entry.passed)
      &&boundaries.length===DEPARTMENT_ISOLATION_BOUNDARIES.length&&boundaries.every(entry=>entry.passed)
    const revision=(await runCommand('git',['rev-parse','HEAD'],{cwd:root,env})).trim()
    const finalReport={
      formatVersion:1,mode:foundation?'foundation':'full',createdAt:new Date().toISOString(),
      revision,manifestRevision:DEPARTMENT_ISOLATION_MANIFEST_REVISION,
      migration:await migrationRevision(fixture.adminUrl),
      manifestCoverage:{...manifestCoverage,caseIds:[...DEPARTMENT_ISOLATION_CASE_IDS],boundaryIds:DEPARTMENT_ISOLATION_BOUNDARIES.map(entry=>entry.id)},
      sourceHashes:await hashes(relevantPaths),dirtySourceHashes:await dirtySourceHashes(env),
      suites:suiteResults,cases,boundaries,
      counts:{suites:suiteResults.length,assertions:assertions.length,passed:assertions.filter(item=>item.status==='passed').length,failed:assertions.filter(item=>item.status==='failed').length,skipped:assertions.filter(item=>!['passed','failed'].includes(item.status)).length},
      fullMatrixAccepted,
    }
    if(reportPath){await mkdir(dirname(reportPath),{recursive:true});await writeFile(reportPath,`${JSON.stringify(finalReport,null,2)}\n`,{mode:0o600})}
    console.log(JSON.stringify({mode:finalReport.mode,revision,report:reportPath??null,...finalReport.counts,fullMatrixAccepted}))
    if(!foundation&&!fullMatrixAccepted)throw new Error(`Department isolation acceptance failed; report: ${reportPath}`)
    if(foundation&&suiteFailures)throw new Error('Department isolation foundation suite failed')
  } finally { await fixture.dispose() }
}
run().catch(error => { console.error(error.message); process.exitCode = 1 })
