import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import { fileURLToPath } from 'node:url'
import { ADMIN_DATABASE_URL, ADMIN_APP_DATABASE_URL, adminRigEnvironment, adminRuntimeNodeOptions, recordAdminGroups, assertAdminRuntimeComposition, stopOwnedAdminGroups } from '../rig-admin.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
describe('[COMP:platform/local-rig] no-paid administrative fixture', () => {
  it('keeps only OS launch inputs and a dedicated fixture configuration', () => {
    const env = adminRigEnvironment('/fixture/repo', {
      PATH: '/bin', HOME: '/normal-home', GEMINI_API_KEY: 'fictional-secret',
      OPENAI_API_KEY: 'fictional-secret', GOOGLE_APPLICATION_CREDENTIALS: '/real-key.json',
      DATABASE_URL: 'postgres://remote.example/data', NODE_OPTIONS: '--import=/external.mjs',
      HTTPS_PROXY: 'https://proxy.example', USEBRIAN_CONFIG_DIR: '/normal-config',
      USEBRIAN_PREFERRED_PROVIDER: 'openai-codex', BRIAN_MESSAGE_STORE_ENABLED: '1',
    })
    assert.equal(env.PATH, '/bin')
    assert.equal(env.HOME, '/normal-home')
    assert.equal(env.DATABASE_URL, ADMIN_DATABASE_URL)
    assert.equal(env.DATABASE_URL_APP, ADMIN_APP_DATABASE_URL)
    assert.equal(env.USEBRIAN_CONFIG_DIR, '/fixture/repo/.rig/admin/config')
    assert.equal(env.LOCAL_FILES_DIR, '/fixture/repo/.rig/admin/files')
    assert.equal(env.BRIAN_MESSAGE_STORE_ENABLED, '0')
    assert.equal(env.USEBRIAN_API_PORT, '4100')
    for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'NODE_OPTIONS', 'HTTPS_PROXY', 'USEBRIAN_PREFERRED_PROVIDER']) assert.equal(env[key], undefined, key)
  })

  it('seals dotenv keys without carrying their values into a child', () => {
    const env = adminRigEnvironment('/fixture', { GEMINI_API_KEY:'shell-secret' },
      () => 'GEMINI_API_KEY=file-secret\nDATABASE_URL=postgres://remote.example/real\nNODE_OPTIONS=--import=/secret\n');
    assert.equal(env.GEMINI_API_KEY, '');
    assert.equal(env.NODE_OPTIONS, '');
    assert.equal(env.DATABASE_URL, ADMIN_DATABASE_URL);
  })

  it('rejects unsafe mode combinations before creating or stopping a rig', () => {
    for (const [script, flag] of [['rig-up.sh','--full'], ['rig-up.sh','--fresh'], ['rig-down.sh','--wipe']]) {
      const child = spawnSync('bash', [new URL('../' + script, import.meta.url).pathname, '--admin-only', flag], { encoding: 'utf8' });
      assert.equal(child.status, 1);
      assert.match(child.stderr, /--admin-only/);
    }
  })

  it('permits a caller-selected local API port without accepting other ambient configuration', () => {
    assert.equal(adminRigEnvironment('/fixture', { USEBRIAN_API_PORT: '4200' }).USEBRIAN_API_PORT, '4200')
    assert.match(adminRuntimeNodeOptions('/path with spaces'), /path%20with%20spaces/)
  })

  it('selects only a validated loopback administrative database port',()=>{
    const env=adminRigEnvironment('/fixture',{BRIAN_ADMIN_PG_PORT:'55483',DATABASE_URL:'postgres://remote.example/data'})
    assert.equal(new URL(env.DATABASE_URL).hostname,'127.0.0.1')
    assert.equal(new URL(env.DATABASE_URL).port,'55483')
    assert.equal(new URL(env.DATABASE_URL_APP).port,'55483')
    assert.equal(env.BRIAN_ADMIN_PG_PORT,'55483')
    for(const port of ['443','65536','remote.example','54;false'])assert.throws(()=>adminRigEnvironment('/fixture',{BRIAN_ADMIN_PG_PORT:port}),/Invalid/)
  })

  it('allows actual loopback HTTP while refusing TCP, TLS and fetch before external lookup', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import http from 'node:http';
      import net from 'node:net';
      import tls from 'node:tls';
      const server = http.createServer((req, res) => res.end('local-ok'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        assert.equal(await (await fetch('http://127.0.0.1:' + server.address().port)).text(), 'local-ok');
        for (const dial of [() => net.connect(443, 'outside.example'), () => tls.connect({port:443, host:'outside.example'}), () => http.get('http://outside.example')]) {
          assert.throws(dial, {code:'ERR_RIG_EXTERNAL_NETWORK'});
        }
        await assert.rejects(fetch('https://outside.example'), error => error.cause?.code === 'ERR_RIG_EXTERNAL_NETWORK');
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    `], { env: { ...adminRigEnvironment(root, process.env), NODE_OPTIONS: adminRuntimeNodeOptions(root) }, encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 0, child.stderr)
  })

  it('forwards the finite reference choice exactly and rejects nonadmin use before startup',()=>{
    const rig=readFileSync(new URL('../rig-up.sh',import.meta.url),'utf8'),launcher=readFileSync(new URL('../launch.mjs',import.meta.url),'utf8')
    const segment=rig.slice(rig.indexOf('  launch_args=()'),rig.indexOf('  nohup env'))
    for(const [admin,reference,expected] of [[0,0,[]],[1,0,['--admin-only']],[1,1,['--admin-only','--reference-applications']]]){
      const shell=spawnSync('bash',['-c',segment+'\nprintf "%s\\n" "${launch_args[@]}"'],{env:{PATH:process.env.PATH,ADMIN_ONLY:String(admin),REFERENCE_APPLICATIONS:String(reference)},encoding:'utf8'})
      assert.equal(shell.status,0,shell.stderr);assert.deepEqual(shell.stdout.trim()?shell.stdout.trim().split('\n'):[],expected)
      const apiLine=launcher.split('\n').find(line=>line.startsWith("run('api',"));let forwarded
      new Function('run','adminOnly','referenceApplications',apiLine)((...args)=>{forwarded=args},Boolean(admin),Boolean(reference))
      assert.deepEqual(forwarded[2],['--filter','@use-brian/api-open','exec','tsx','src/index.ts',...(admin?['--admin-only','--no-workers']:[]),...(reference?['--reference-applications']:[])])
    }
    for(const [command,args] of [['bash',[new URL('../rig-up.sh',import.meta.url).pathname,'--reference-applications']],[process.execPath,[new URL('../launch.mjs',import.meta.url).pathname,'--reference-applications']]]){
      const result=spawnSync(command,args,{env:{PATH:process.env.PATH},encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/requires --admin-only/)
    }
    expectOrder(launcher,'referenceApplications && !adminOnly','adminRigEnvironment(ROOT, process.env)')
    assert.match(rig,/--verify-composition "\$ROOT" "\$APPLICATION_COMPOSITION" "\$pid"/)
  })

  it('wires the opt-in into the real composition without changing readiness', () => {
    const source = path => readFileSync(new URL(path, import.meta.url), 'utf8')
    const launcher = source('../launch.mjs')
    assert.match(launcher, /adminRigEnvironment\(ROOT, process.env\)/)
    assert.match(launcher, /if \(!adminOnly\) loadDotEnv/)
    assert.match(launcher, /adminRuntimeNodeOptions\(ROOT\)/)
    const api = source('../../apps/api/src/index.ts')
    assert.match(api, /startLocalSubscriptionProvider: !adminOnly/)
    assert.match(api, /if \(!adminOnly\) dotenv.config/)
    const boot = source('../../packages/api/src/boot.ts')
    assert.match(boot, /isSelfHostedOssEnv\(\) && opts.startLocalSubscriptionProvider !== false/)
  })

  it('prepares the canonical role before migration and activates only after success', () => {
    const rig=readFileSync(new URL('../rig-up.sh',import.meta.url),'utf8'),sql=readFileSync(new URL('../rig-admin-role.sql',import.meta.url),'utf8')
    expectOrder(rig,'runtime-role.mjs" prepare','say "applying open migrations')
    expectOrder(rig,'runtime-role.mjs" transition','say "applying open migrations')
    expectOrder(rig,'migrations ok (','runtime-role.mjs" activate')
    expectOrder(rig,'--verify-composition','api_healthy; then')
    assert.match(sql,/CREATE ROLE app_user NOLOGIN NOSUPERUSER/)
    assert.doesNotMatch(sql,/GRANT EXECUTE ON FUNCTION|has_function_privilege|GRANT app_user TO/)
    assert.match(sql,/Migrated administrative fixture lacks canonical role/)
    assert.match(rig,/api_healthy; then\s+verify_admin_role/)
  })

})


describe('[COMP:platform/local-rig] persistent runtime process ownership',()=>{
  it('checks every group member before signaling any group and refuses reused ownership',()=>{
    const directory=mkdtempSync(join(tmpdir(),'admin-group-test-')),runId='a'.repeat(32),signals=[]
    try{
      recordAdminGroups(directory,runId,[100,200])
      const execute=(_cmd,args)=>args[0]==='-axo'?'101 1 100\n201 1 200\n':args[2]==='101'?`node USEBRIAN_ADMIN_RUN_ID=${runId}`:'node USEBRIAN_ADMIN_RUN_ID=another-run'
      assert.throws(()=>stopOwnedAdminGroups(directory,execute,(...args)=>signals.push(args)),/unverified member/)
      assert.deepEqual(signals,[])
      assert.equal(stopOwnedAdminGroups(directory,(_cmd,args)=>args[0]==='-axo'?'101 1 100\n201 1 200\n':`node USEBRIAN_ADMIN_RUN_ID=${runId}`,(...args)=>signals.push(args)),2)
      assert.deepEqual(signals,[[-100,'SIGTERM'],[-200,'SIGTERM']])
      signals.length=0
      assert.equal(stopOwnedAdminGroups(directory,(_cmd,args)=>args[0]==='-axo'?'101 1 100\n102 101 100\n':args[2]==='101'?`node USEBRIAN_ADMIN_RUN_ID=${runId}`:'renamed-node',(...args)=>signals.push(args)),1)
      assert.deepEqual(signals,[[-100,'SIGTERM']])
    }finally{rmSync(directory,{recursive:true,force:true})}
  })
  it('stops a real owned runtime even when no launcher is recorded',{timeout:10000},async()=>{
    const directory=mkdtempSync(join(tmpdir(),'admin-group-test-')),runId='b'.repeat(32)
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{...process.env,USEBRIAN_ADMIN_RUN_ID:runId}})
    const exited=once(child,'exit')
    try{
      await once(child,'spawn');recordAdminGroups(directory,runId,[child.pid])
      assert.doesNotThrow(()=>assertAdminRuntimeComposition(directory,'normal',process.pid))
      assert.throws(()=>assertAdminRuntimeComposition(directory,'reference',process.pid),/--keep-db/)
      assert.equal(stopOwnedAdminGroups(directory),1)
      await exited
      assert.equal(stopOwnedAdminGroups(directory),0)
    }finally{try{process.kill(-child.pid,'SIGKILL')}catch{}rmSync(directory,{recursive:true,force:true})}
  })
})


describe('[COMP:platform/local-rig] canonical runtime verification',()=>{
 function installer(){const rig=readFileSync(new URL('../rig-up.sh',import.meta.url),'utf8');return rig.match(/verify_admin_role\(\) \{([\s\S]*?)\n\}/)[0]+'\nverify_admin_role'}
 it('uses read-only canonical verification for warm administrative passes only',async()=>{
  const {writeFileSync,chmodSync,existsSync}=await import('node:fs'),dir=mkdtempSync(join(tmpdir(),'role-installer-'))
  try{
   const trace=join(dir,'argv'),sql=join(dir,'sql'),docker=join(dir,'docker');writeFileSync(docker,'#!/bin/sh\nprintf "%s\\n" "$@" >"$TRACE"\ncat >"$SQL_TRACE"\n');chmodSync(docker,0o700)
   const env={PATH:`${dir}:${process.env.PATH}`,ROOT:root,TRACE:trace,SQL_TRACE:sql,CONTAINER:'fixture-container',RIG_DB_USER:'fixture-owner',RIG_DB_NAME:'fixture-db'}
   let run=spawnSync('/bin/bash',['-c',installer()],{env:{...env,ADMIN_ONLY:'0'},encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.equal(existsSync(trace),false)
   run=spawnSync('/bin/bash',['-c',installer()],{env:{...env,ADMIN_ONLY:'1'},encoding:'utf8'});assert.equal(run.status,0,run.stderr)
   assert.deepEqual(readFileSync(trace,'utf8').trim().split('\n'),['exec','-i','fixture-container','psql','-U','fixture-owner','-d','fixture-db','-v','ON_ERROR_STOP=1','-q'])
   assert.match(readFileSync(sql,'utf8'),/Canonical runtime LOGIN missing/)
   assert.doesNotMatch(readFileSync(sql,'utf8'),/GRANT|REVOKE|ALTER ROLE/)
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
 it('records canonical composition and refuses old or missing receipts before SQL',async()=>{
  const {writeFileSync}=await import('node:fs'),directory=mkdtempSync(join(tmpdir(),'admin-composition-'))
  try{
   assert.throws(()=>assertAdminRuntimeComposition(directory),/--keep-db/)
   const runId='c'.repeat(32),processes=(_cmd,args)=>args[0]==='-axo'?`100 ${process.pid} 100`:`node USEBRIAN_ADMIN_RUN_ID=${runId}`
   recordAdminGroups(directory,runId,[100])
   assert.doesNotThrow(()=>assertAdminRuntimeComposition(directory,'normal',process.pid,processes))
   const path=join(directory,'.rig','admin','process-groups.json'),record=JSON.parse(readFileSync(path,'utf8'))
   assert.equal(record.runtimeRole,'app_user')
   assert.equal(record.composition,'normal')
   assert.throws(()=>assertAdminRuntimeComposition(directory,'reference',process.pid,processes),/--keep-db/)
   for(const composition of [undefined,'reference','unknown']){record.composition=composition;writeFileSync(path,JSON.stringify(record));assert.throws(()=>assertAdminRuntimeComposition(directory,'normal',process.pid,processes),/--keep-db/)}
   record.composition='normal'
   for(const detail of ['node USEBRIAN_ADMIN_RUN_ID='+ 'd'.repeat(32),'renamed-node'])assert.throws(()=>assertAdminRuntimeComposition(directory,'normal',process.pid,(_cmd,args)=>args[0]==='-axo'?`100 ${process.pid} 100`:detail),/--keep-db/)
   assert.throws(()=>assertAdminRuntimeComposition(directory,'normal',process.pid,()=>''),/--keep-db/)
   assert.throws(()=>assertAdminRuntimeComposition(directory,'normal',process.pid,(_cmd,args)=>args[0]==='-axo'?'100 1 100':`node USEBRIAN_ADMIN_RUN_ID=${runId}`),/--keep-db/)
   recordAdminGroups(directory,runId,[100],'reference');assert.doesNotThrow(()=>assertAdminRuntimeComposition(directory,'reference',process.pid,processes));assert.throws(()=>assertAdminRuntimeComposition(directory,'normal',process.pid,processes),/--keep-db/)
   recordAdminGroups(directory,runId,[100]);
   for(const role of [undefined,'admin_fixture_app','assurance_app']){record.runtimeRole=role;writeFileSync(path,JSON.stringify(record));assert.throws(()=>assertAdminRuntimeComposition(directory),/--keep-db/)}
  }finally{rmSync(directory,{recursive:true,force:true})}
 })
})

function expectOrder(source,before,after){assert.ok(source.indexOf(before)>=0&&source.indexOf(before)<source.indexOf(after))}
