import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync,symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join,resolve,dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { verificationCommandCatalog,REQUIREMENTS,FAMILIES,safeRunId,sha256,parseMachineResults,verifyReceipt,verifyManifest,importGuardedReceipt,captureSourceSnapshot,importMaintainedBrowserReceipt } from '../verify-local.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),script=join(root,'scripts/application-platform/verify-local.mjs')
function fixture(operation){const temp=mkdtempSync(join(tmpdir(),'application-verifier-negative-'));try{return operation(temp)}finally{rmSync(temp,{recursive:true,force:true})}}
function receipt(temp){mkdirSync(join(temp,'packages/demo/src'),{recursive:true});const source='packages/demo/src/demo.ts';writeFileSync(join(temp,source),'export const boundary = true\n');writeFileSync(join(temp,'command.log'),'safe local command output\n');const result={success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,numTodoTests:0,testResults:[{name:source,assertionResults:[{fullName:'[COMP:tooling/application-platform-verifier] current boundary',status:'passed'}]}]};writeFileSync(join(temp,'results.json'),JSON.stringify(result));return{exitCode:0,timedOut:false,argv:['node','local-test.mjs'],sources:{[source]:sha256(readFileSync(join(temp,source)))},format:'vitest-json',log:{path:'command.log',sha256:sha256(readFileSync(join(temp,'command.log')))},result:{path:'results.json',sha256:sha256(readFileSync(join(temp,'results.json')))}}}
test('[COMP:tooling/application-platform-verifier] unsafe run IDs are rejected before target access',()=>{for(const value of ['../outside','/absolute','.','a/b','a b','a\u0000b',undefined])assert.throws(()=>safeRunId(value));assert.equal(safeRunId('completion_20261024'),'completion_20261024')})
test('empty, failed, skipped and todo machine test results cannot be passes',()=>{for(const report of [{},{success:true,numTotalTests:0,testResults:[]},{success:false,numTotalTests:1,numFailedTests:1,testResults:[]},{success:true,numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:1,numTodoTests:0,testResults:[{assertionResults:[{fullName:'held',status:'pending'}]}]}])assert.throws(()=>parseMachineResults(JSON.stringify(report),'vitest-json'))})
test('TAP parser requires complete zero-skip zero-cancellation concrete cases',()=>{const good='ok 1 - concrete case\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n';assert.equal(parseMachineResults(good,'node-tap')[0].name,'concrete case');for(const bad of [good.replace('ok 1','not ok 1'),good.replace('concrete case','concrete case # SKIP held'),good.replace('# cancelled 0','# cancelled 1'),good.replace('# tests 1','# tests 2')])assert.throws(()=>parseMachineResults(bad,'node-tap'))})
test('source-bound actual command/log/result receipt can validate independently of platform acceptance',()=>fixture(temp=>{
 const value=receipt(temp);mkdirSync(join(temp,'use-brian'),{recursive:true})
 for(const path of ['knip.json','use-brian/knip.json']){writeFileSync(join(temp,path),'{}');value.sources[path]=sha256(readFileSync(join(temp,path)))}
 const snapshot=captureSourceSnapshot({sources:value.sources},{platformRoot:temp,repositories:{}})
 assert.deepEqual(snapshot.sources,value.sources)
 assert.deepEqual(verifyReceipt(value,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv}).errors,[])
 for(const path of ['knip.json','use-brian/knip.json']){writeFileSync(join(temp,path),'{"changed":true}');assert.ok(verifyReceipt(value,{platformRoot:temp,runRoot:temp}).errors.some(error=>error==='Stale command source: '+path))}
 const map='packages/demo/src/demo.js.map';writeFileSync(join(temp,map),'{}');const mapped={sources:{[map]:sha256(readFileSync(join(temp,map)))}}
 assert.throws(()=>captureSourceSnapshot(mapped,{platformRoot:temp,repositories:{}}),/Unsupported source path/)
 assert.ok(verifyReceipt({...value,...mapped},{platformRoot:temp,runRoot:temp}).errors.includes('Unsupported source path'))
}))
test('explicit absent source inputs bind capture and receipts until that exact path exists',()=>fixture(temp=>{
 const value=receipt(temp),missing='packages/demo/src/retired.ts';value.sources[missing]=null
 const snapshot=captureSourceSnapshot({sources:value.sources},{platformRoot:temp,repositories:{}})
 assert.equal(snapshot.sources[missing],null)
 assert.deepEqual(verifyReceipt(value,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv}).errors,[])
 const manifest=verifyManifest({version:1,sourceFrozen:true,sources:value.sources},{platformRoot:temp,runRoot:temp,ledger:{consumers:[]}})
 assert.equal(manifest.errors.some(error=>error.includes('Stale manifest source')),false)
 writeFileSync(join(temp,missing),'restored source')
 assert.throws(()=>captureSourceSnapshot({sources:value.sources},{platformRoot:temp,repositories:{}}),/changed/)
 assert.ok(verifyReceipt(value,{platformRoot:temp,runRoot:temp}).errors.some(error=>error.includes('Stale command source: '+missing)))
 assert.ok(verifyManifest({version:1,sourceFrozen:true,sources:value.sources},{platformRoot:temp,runRoot:temp,ledger:{consumers:[]}}).errors.some(error=>error.includes('Stale manifest source: '+missing)))
}))
test('stale command sources and command substitution reject a receipt',()=>fixture(temp=>{const value=receipt(temp);writeFileSync(join(temp,'packages/demo/src/demo.ts'),'changed');const result=verifyReceipt(value,{platformRoot:temp,runRoot:temp,expectedCommand:['different']});assert.ok(result.errors.some(error=>error.includes('Stale command source')));assert.ok(result.errors.some(error=>error.includes('allowlisted')))}))
test('failed, timed-out, missing and unchecked receipt inputs remain failures',()=>fixture(temp=>{for(const mutate of [value=>{value.exitCode=1},value=>{value.timedOut=true},value=>{value.log.path='missing.log'},value=>{value.sources={}},value=>{value.result.sha256='0'.repeat(64)}]){const value=receipt(temp);mutate(value);assert.ok(verifyReceipt(value,{platformRoot:temp,runRoot:temp}).errors.length>0)}}))
test('checksum-valid skipped result payload is still rejected',()=>fixture(temp=>{const value=receipt(temp);const result=JSON.parse(readFileSync(join(temp,'results.json'),'utf8'));result.numPendingTests=1;result.testResults[0].assertionResults[0].status='pending';writeFileSync(join(temp,'results.json'),JSON.stringify(result));value.result.sha256=sha256(readFileSync(join(temp,'results.json')));assert.ok(verifyReceipt(value,{platformRoot:temp,runRoot:temp}).errors.some(error=>error.includes('skipped')))}))
test('checkbox assertions and removed original consumers cannot produce platform completion',()=>fixture(temp=>{const report=verifyManifest({version:1,assertions:Object.fromEntries(REQUIREMENTS.map(id=>[id,{status:'passed',receipt:'invented',caseName:'claimed'}])),consumers:{}},{platformRoot:temp,runRoot:temp,ledger:{consumers:Array.from({length:503},(_,index)=>({id:'original-'+index,path:'packages/demo/src/demo.ts'}))}});assert.equal(report.complete,false);assert.equal(report.runtimeQualified,false);assert.ok(report.errors.some(error=>error.includes('Original consumer IDs')));assert.ok(report.errors.some(error=>error.includes('Missing actual passing case for A01')));assert.ok(report.errors.some(error=>error.includes('maintained-rig browser')));assert.equal(FAMILIES.length,10)}))
test('CLI rejects unsafe run path and ambient database target with nonzero exit',()=>{const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','LANG','TMPDIR'].includes(key)));const unsafe=spawnSync(process.execPath,[script,'--run','../outside','--collect-only'],{env:environment,encoding:'utf8'});assert.equal(unsafe.status,2);const target=spawnSync(process.execPath,[script,'--run','safe','--collect-only'],{env:{...environment,DATABASE_URL:'postgres://forbidden.invalid/private'},encoding:'utf8'});assert.equal(target.status,2);assert.doesNotMatch(target.stderr,/forbidden\.invalid/)})
test('collect-only writes an incomplete manifest and never starts a test process',()=>{const id='negative-'+randomUUID(),directory=join(root,'output/application-platform',id);mkdirSync(directory,{recursive:true});try{writeFileSync(join(directory,'input.json'),JSON.stringify({version:1,sources:{'use-brian/packages/demo/src/absent-source.ts':null},receipts:{},assertions:{},consumers:{}}));const environment=Object.fromEntries(Object.entries(process.env).filter(([key])=>['PATH','HOME','LANG','TMPDIR'].includes(key)));const result=spawnSync(process.execPath,[script,'--run',id,'--collect-only'],{cwd:root,env:environment,encoding:'utf8',timeout:30000});assert.equal(result.status,1,result.stderr);const report=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));assert.equal(report.complete,false);assert.equal(report.consumerCount,503);assert.equal(report.runtimeQualified,false);assert.equal(report.errors.some(error=>error.includes('Stale execution input')||error.includes('ENOENT')),false);assert.ok(report.errors.some(error=>error.includes('Unproved A01')));assert.equal(readdirSync(directory).some(name=>name.endsWith('.command.json')),false)}finally{rmSync(directory,{recursive:true,force:true})}})

test('an OSS-root command cannot stand in for the platform-root gate',()=>fixture(temp=>{const value=receipt(temp);value.cwd=join(temp,'oss');const result=verifyReceipt(value,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp});assert.ok(result.errors.some(error=>error.includes('working directory')))}))

test('path escape and symlink evidence cannot be read as trusted logs',()=>fixture(temp=>{const value=receipt(temp);value.log.path='../outside.log';assert.ok(verifyReceipt(value,{platformRoot:temp,runRoot:temp}).errors.some(error=>error.includes('escapes')));value.log.path='command.log';rmSync(join(temp,'command.log'));writeFileSync(join(temp,'other.log'),'safe local command output\n');symlinkSync(join(temp,'other.log'),join(temp,'command.log'));assert.ok(verifyReceipt(value,{platformRoot:temp,runRoot:temp}).errors.some(error=>error.includes('Symlink')))}))

function guardedFixture(temp) {
 const value=receipt(temp), snapshot=captureSourceSnapshot({sources:value.sources},{platformRoot:temp,repositories:{oss:{head:'frozen'}},now:new Date('2026-10-24T09:00:00Z')})
 writeFileSync(join(temp,'snapshot.json'),JSON.stringify(snapshot))
 writeFileSync(join(temp,'guard.log'),readFileSync(join(temp,'command.log')));value.log={path:'guard.log',sha256:sha256(readFileSync(join(temp,'guard.log')))}
 writeFileSync(join(temp,'guard.json'),JSON.stringify({argv:value.argv,cwd:temp,started:true,pid:123,pgid:123,start:'2026-10-24T09:00:01Z',end:'2026-10-24T09:00:02Z',exitCode:0,timedOut:false}))
 const bound=path=>({path,sha256:sha256(readFileSync(join(temp,path)))})
 return {value,input:{kind:'guarded-command-import',guard:bound('guard.json'),snapshot:bound('snapshot.json'),log:value.log,result:value.result,format:value.format},bound}
}
test('actual guard argv and prelaunch snapshot import without rewritten command metadata',()=>fixture(temp=>{
 const {input,value}=guardedFixture(temp), imported=importGuardedReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp})
 assert.deepEqual(imported.argv,value.argv);assert.equal(imported.pid,123);assert.equal(imported.sources['packages/demo/src/demo.ts'],value.sources['packages/demo/src/demo.ts'])
}))
test('posthoc snapshot, changed wrapper argv, failed or unstarted guard cannot certify a command',()=>fixture(temp=>{
 for(const mutate of [raw=>raw.started=false,raw=>raw.exitCode=1,raw=>raw.timedOut=true,raw=>raw.start='2026-10-24T08:59:59Z',raw=>raw.argv=['sh','-c','claimed passing command'],raw=>raw.pgid=124]) {
  const {input,value,bound}=guardedFixture(temp),raw=JSON.parse(readFileSync(join(temp,'guard.json'),'utf8'));mutate(raw);writeFileSync(join(temp,'guard.json'),JSON.stringify(raw));input.guard=bound('guard.json')
  assert.throws(()=>importGuardedReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}))
 }
}))
test('guard snapshots refuse changed inputs before capture and stale source after launch',()=>fixture(temp=>{
 const {input,value}=guardedFixture(temp);writeFileSync(join(temp,'packages/demo/src/demo.ts'),'new implementation')
 assert.throws(()=>captureSourceSnapshot({sources:value.sources},{platformRoot:temp,repositories:{}}),/changed/)
 assert.throws(()=>importGuardedReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}),/Stale/)
}))

test('a passing guard cannot borrow a different command log',()=>fixture(temp=>{
 const {input,value}=guardedFixture(temp);writeFileSync(join(temp,'borrowed.log'),readFileSync(join(temp,'guard.log')));input.log={path:'borrowed.log',sha256:sha256(readFileSync(join(temp,'borrowed.log')))}
 assert.throws(()=>importGuardedReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}),/recorded command output/)
}))

test('browser importer refuses a declared browser without an actual bounded maintained boot and artifacts',()=>fixture(temp=>{
 const {input,value,bound}=guardedFixture(temp)
 assert.throws(()=>importMaintainedBrowserReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}))
 const boot={started:true,pid:124,pgid:124,exitCode:0,timedOut:false,cwd:temp,start:'2026-10-24T09:00:00Z',end:'2026-10-24T09:00:01Z',argv:['env','BRIAN_ADMIN_PG_PORT=55444','BRIAN_ADMIN_DEADLINE_UTC=2026-10-24T09:20:00Z','bash','scripts/rig-up.sh','--admin-only','--timeout=300']}
 writeFileSync(join(temp,'boot.json'),JSON.stringify(boot));writeFileSync(join(temp,'boot.log'),'maintained boot output')
 input.rig={guard:bound('boot.json'),log:bound('boot.log'),snapshot:input.snapshot}
 assert.throws(()=>importMaintainedBrowserReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}),/machine results or observation artifacts/)
}))

test('Vitest result counts and concrete case identity must match the actual machine list',()=>fixture(temp=>{
 const value=receipt(temp),good=JSON.parse(readFileSync(join(temp,value.result.path),'utf8'))
 for(const mutate of [report=>report.numPassedTests=2,report=>delete report.testResults[0].assertionResults[0].fullName,report=>report.testResults[0].name='',report=>{report.testResults[0].assertionResults.push(report.testResults[0].assertionResults[0]);report.numTotalTests=2;report.numPassedTests=2}]){const report=structuredClone(good);mutate(report);assert.throws(()=>parseMachineResults(JSON.stringify(report),'vitest-json'))}
 assert.throws(()=>parseMachineResults('[COMP:claimed] everything passed','vitest-json'))
}))

test('source-bound real-format browser receipt imports only within the reviewed maintained rig deadline',()=>fixture(temp=>{
 const {input,value,bound}=guardedFixture(temp)
 const tap='ok 1 - actual browser assertion\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n# todo 0\n'
 writeFileSync(join(temp,'guard.log'),tap);input.log=bound('guard.log');input.format='node-tap';delete input.result
 writeFileSync(join(temp,'boot.log'),'maintained boot output')
 const boot={started:true,pid:124,pgid:124,cwd:temp,exitCode:0,timedOut:false,start:'2026-10-24T09:00:00Z',end:'2026-10-24T09:00:01Z',argv:['env','BRIAN_ADMIN_PG_PORT=55444','BRIAN_ADMIN_DEADLINE_UTC=2026-10-24T09:20:00Z','bash','scripts/rig-up.sh','--admin-only','--timeout=300']}
 writeFileSync(join(temp,'boot.json'),JSON.stringify(boot));input.rig={guard:bound('boot.json'),log:bound('boot.log'),snapshot:input.snapshot}
 writeFileSync(join(temp,'view.png'),'fixture-image-bytes');writeFileSync(join(temp,'view.json'),'{}');input.artifacts=[bound('view.png'),bound('view.json')]
 assert.equal(importMaintainedBrowserReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}).kind,'maintained-rig-browser')
 boot.argv[2]='BRIAN_ADMIN_DEADLINE_UTC=2026-10-24T09:00:01Z';writeFileSync(join(temp,'boot.json'),JSON.stringify(boot));input.rig.guard=bound('boot.json')
 assert.throws(()=>importMaintainedBrowserReceipt(input,{platformRoot:temp,runRoot:temp,expectedCommand:value.argv,expectedCwd:temp}),/outside/)
}))


test('final recipes preserve actual SQL scope, separate upgrade witnesses and maintained app-build isolation',()=>fixture(temp=>{
 const pgBin=join(temp,'pg-bin');mkdirSync(pgBin)
 const catalog=verificationCommandCatalog(pgBin,'/tmp/proof-run')
 const sql=catalog['sql-matrix'];assert.equal(sql.limit,1500);assert.equal(sql.format,'vitest-json')
 assert.ok(sql.argv.includes('src/application-platform/__tests__/'))
 assert.ok(sql.argv.includes('src/db/__tests__/knowledge-mode-admission.integration.test.ts'))
 assert.ok(sql.argv.includes('src/db/__tests__/goal-source-admission.integration.test.ts'))
 assert.equal(sql.argv[sql.argv.indexOf('--runtime-role')+1],'app_user')
 assert.equal(sql.argv[sql.argv.indexOf('--exclude')+1],'src/application-platform/__tests__/upgrade.integration.test.ts')
 for(const id of ['fresh-oss','fresh-oss-overlay','legacy-upgrade-oss','legacy-upgrade-overlay'])assert.equal(catalog[id].argv[1],'scripts/application-platform/upgrade-rehearsal.mjs')
 for(const id of ['browser-management','browser-reconciliation','browser-management-review','browser-credential-display'])assert.equal(catalog[id].format,'node-tap');assert.equal(catalog['public-docs'].format,'vitest-json')
 const build=catalog['app-build'];assert.equal(build.argv[1],'--input-type=module');assert.ok(build.argv[3].includes('adminRigEnvironment'));assert.ok(build.argv[3].includes('adminRuntimeNodeOptions'))
}))

test('future catalogs pin a selected PostgreSQL directory alias before generating exact argv',()=>fixture(temp=>{
 const directory=join(temp,'postgres-bin'),alias=join(temp,'selected-postgres');mkdirSync(directory);symlinkSync(directory,alias,'dir')
 const direct=verificationCommandCatalog(directory,'/tmp/future-proof'),selected=verificationCommandCatalog(alias,'/tmp/future-proof')
 for(const id of ['sql-matrix','fresh-oss','fresh-oss-overlay','legacy-upgrade-oss','legacy-upgrade-overlay'])assert.deepEqual(selected[id].argv,direct[id].argv)
 assert.equal(selected['sql-matrix'].argv[selected['sql-matrix'].argv.indexOf('--pg-bin')+1],directory)
 assert.equal(verificationCommandCatalog('','/tmp/collect-only')['fresh-oss'].argv.at(-1),'')
 assert.throws(()=>verificationCommandCatalog(join(temp,'missing-installation'),'/tmp/future-proof'))
}))
