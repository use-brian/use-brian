import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import { fileURLToPath } from 'node:url'
import { ADMIN_DATABASE_URL, ADMIN_APP_DATABASE_URL, adminRigEnvironment, adminRuntimeNodeOptions, recordAdminGroups, stopOwnedAdminGroups } from '../rig-admin.mjs'

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
      assert.equal(stopOwnedAdminGroups(directory),1)
      await exited
      assert.equal(stopOwnedAdminGroups(directory),0)
    }finally{try{process.kill(-child.pid,'SIGKILL')}catch{}rmSync(directory,{recursive:true,force:true})}
  })
})
