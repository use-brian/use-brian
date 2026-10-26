import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pg from 'pg'
import { runtimeRoleSql } from '../runtime-role.mjs'
import { assertLocalFixture, cleanRuntimeEnvironment, runCommand, createLocalFixture } from '../local-fixture.mjs'

test('[COMP:crm/assurance-fixture] Default PostgreSQL clients remain inside the disposable cluster', async () => {
  const marker = await assertLocalFixture()
  const defaults = new pg.Client()
  try {
    await defaults.connect()
    const result = await defaults.query(`SELECT current_database() AS database, current_user AS role,
      host(inet_server_addr()) AS host, inet_server_port() AS port`)
    assert.deepEqual(result.rows, [{ database: 'brian_assurance', role: 'assurance_owner', host: '127.0.0.1', port: marker.port }])
  } finally { await defaults.end() }
  // An explicit database name must still target this server, never an ambient instance.
  const missing = new pg.Client({ database: `fixture_missing_${randomUUID().replaceAll('-', '')}` })
  try { await assert.rejects(missing.connect(), { code: '3D000' }) }
  finally { await missing.end() }
})

test('[COMP:crm/assurance-fixture] Actual migrations and application-role RLS', async () => {
  await assertLocalFixture()
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL })
  const app = new pg.Client({ connectionString: process.env.DATABASE_URL_APP })
  await owner.connect()
  await app.connect()
  try {
    const migrations = await owner.query('SELECT name FROM _migrations ORDER BY name')
    assert(migrations.rows.some((row) => row.name === '000_open_schema_v1.sql'))
    assert(migrations.rows.some((row) => row.name === '460_association_operations.sql'))
    const roles = await app.query('SELECT current_user AS role, rolsuper, rolbypassrls, rolinherit FROM pg_roles WHERE rolname=current_user')
    assert.equal(roles.rows[0].role, 'app_user')
    assert.equal(roles.rows[0].rolinherit, false)
    await assert.rejects(app.query('SELECT * FROM _migrations'), { code: '42501' })
    assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current, true)
    const before = (await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows
    await owner.query(await runtimeRoleSql('verify'))
    await owner.query(await runtimeRoleSql('prepare'))
    await owner.query(await runtimeRoleSql('verify'))
    assert.deepEqual((await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows, before)
    assert.equal(roles.rows[0].rolsuper, false)
    assert.equal(roles.rows[0].rolbypassrls, false)
    const userId = randomUUID()
    const otherUserId = randomUUID()
    const workspaceId = randomUUID()
    const otherWorkspaceId = randomUUID()
    await owner.query(`INSERT INTO users (id, auth_provider_id) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)`, [userId, otherUserId])
    await owner.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Fixture One',$2),($3,'Fixture Two',$4)`, [workspaceId, userId, otherWorkspaceId, otherUserId])
    await owner.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($3,$4,'owner')`, [workspaceId, userId, otherWorkspaceId, otherUserId])
    await owner.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,'annual','Annual','USD',0,'annual'),($2,'annual','Annual','USD',0,'annual')`, [workspaceId, otherWorkspaceId])
    await app.query('BEGIN')
    await app.query(`SELECT set_config('app.current_user_id',$1,true)`, [userId])
    const rows = await app.query('SELECT workspace_id FROM association_membership_plans')
    assert.deepEqual(rows.rows.map((row) => row.workspace_id), [workspaceId])
    const write = await app.query(`UPDATE association_membership_plans SET name='Changed' WHERE workspace_id=$1`, [otherWorkspaceId])
    assert.equal(write.rowCount, 0)
    await assert.rejects(app.query(`INSERT INTO association_membership_plans (workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,'forbidden','Forbidden','USD',0,'annual')`, [otherWorkspaceId]), /row-level security/)
    await app.query('ROLLBACK')
  } finally {
    await app.end()
    await owner.end()
  }
})

test('[COMP:crm/assurance-fixture] Group interruption disposes only the owned PostgreSQL cluster', { timeout: 35_000 }, async t => {
  await assertLocalFixture()
  const directory = await mkdtemp(join(tmpdir(), 'fixture-interruption-test-'))
  const env = { ...cleanRuntimeEnvironment(process.env), TMPDIR: directory }
  const pgBin = (await runCommand('pg_config', ['--bindir'], { env })).trim()
  const child = spawn(process.execPath, ['scripts/crm/local-fixture.mjs', '--pg-bin', pgBin, '--', process.execPath,
    '-e', "console.log('fixture-ready');setInterval(()=>{},1000)"], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  const startedAt = new Date().toISOString()
  t.diagnostic(JSON.stringify({ ownedProcessGroup: child.pid, startedAt, maxSeconds: 25 }))
  const stop = signal => { try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
  const deadline = setTimeout(() => stop('SIGKILL'), 25_000)
  let output = ''
  try {
    await new Promise((accept, reject) => {
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('fixture-ready')) accept() })
      child.stderr.on('data', chunk => { output += chunk })
      child.once('error', reject)
      child.once('close', () => reject(new Error('Disposable child exited before readiness: ' + output)))
    })
    const names = (await readdir(directory)).filter(name => name.startsWith('brian-crm-'))
    assert.equal(names.length, 1)
    const postmaster = Number((await readFile(join(directory, names[0], 'data', 'postmaster.pid'), 'utf8')).split('\n')[0])
    t.diagnostic(JSON.stringify({ ownedPostmaster: postmaster, directory: join(directory, names[0]) }))
    stop('SIGTERM')
    await closed
    assert.equal((await readdir(directory)).filter(name => name.startsWith('brian-crm-')).length, 0)
    assert.throws(() => process.kill(postmaster, 0), { code: 'ESRCH' })
    t.diagnostic(JSON.stringify({ ownedProcessGroup: child.pid, finishedAt: new Date().toISOString(), disposed: true }))
  } finally {
    clearTimeout(deadline)
    stop('SIGKILL')
    await closed
    // Failure cleanup is confined to this test's newly created root and a
    // marker whose owned directory matches; never select an ambient cluster.
    for (const name of (await readdir(directory)).filter(name => name.startsWith('brian-crm-'))) {
      const owned = join(directory, name)
      const marker = JSON.parse(await readFile(join(owned, 'assurance-fixture.json'), 'utf8'))
      assert.equal(marker.directory, owned)
      await runCommand(join(pgBin, 'pg_ctl'), ['-D', join(owned, 'data'), '-m', 'fast', '-w', 'stop'], { env })
    }
    await rm(directory, { recursive: true })
  }
})

test('[COMP:crm/assurance-fixture] Fixed stopped alias transition restores exact pins and suffix ACLs atomically', async () => {
  await assertLocalFixture()
  const owner = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await owner.connect()
  const transition=await runtimeRoleSql('transition')
  const signatures=[...transition.matchAll(/\('([^']+)','(?:memories|workspace_scope_reviews|application_source_setup_reviews)'/g)].map(match=>match[1])
  assert.equal(signatures.length,16)
  const metadata=async()=> (await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows
  const guard=async()=> (await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current
  const grantAliases=async()=>{for(const signature of signatures)await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO assurance_app,admin_fixture_app`)}
  try {
    for(const alias of ['assurance_app','admin_fixture_app']) await owner.query(`CREATE ROLE ${alias} NOLOGIN ${alias==='admin_fixture_app'?'INHERIT':'NOINHERIT'} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
    const pristine=await metadata()
    await grantAliases()
    assert.equal(await guard(),false)
    const mirrored=await metadata()
    const historicalRoles=(await owner.query("SELECT rolname,rolinherit,rolcanlogin FROM pg_roles WHERE rolname IN('assurance_app','admin_fixture_app') ORDER BY rolname")).rows
    assert.deepEqual(historicalRoles,[{rolname:'admin_fixture_app',rolinherit:true,rolcanlogin:false},{rolname:'assurance_app',rolinherit:false,rolcanlogin:false}])
    await owner.query('CREATE ROLE fixture_membership_probe NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS')
    for(const membership of ['fixture_membership_probe TO admin_fixture_app','admin_fixture_app TO fixture_membership_probe']){
      await owner.query('GRANT '+membership)
      await assert.rejects(owner.query(transition),/unsafe privileges, membership or object ownership/)
      await owner.query('ROLLBACK')
      assert.deepEqual(await metadata(),mirrored)
      await owner.query('REVOKE '+membership.replace(' TO ',' FROM '))
    }
    await owner.query('DROP ROLE fixture_membership_probe')
    // Private ports were never legitimate mirror targets. Refuse rather than clean them.
    await owner.query('GRANT EXECUTE ON FUNCTION application_scoped_grant_allowed_before_records(uuid,jsonb) TO assurance_app')
    const unknown=await metadata()
    await assert.rejects(owner.query(transition),/Unknown private suffix ACL/)
    await owner.query('ROLLBACK')
    assert.deepEqual(await metadata(),unknown)
    await owner.query('REVOKE EXECUTE ON FUNCTION application_scoped_grant_allowed_before_records(uuid,jsonb) FROM assurance_app')
    assert.deepEqual(await metadata(),mirrored)
    await owner.query(`GRANT EXECUTE ON FUNCTION public.${signatures[0]} TO assurance_app WITH GRANT OPTION`)
    const grantOption=await metadata()
    await assert.rejects(owner.query(transition),/Unknown fixture function ACL/)
    await owner.query('ROLLBACK')
    assert.deepEqual(await metadata(),grantOption)
    await owner.query(`REVOKE GRANT OPTION FOR EXECUTE ON FUNCTION public.${signatures[0]} FROM assurance_app`)
    // A mismatch late in the complete pin set rolls back earlier recognized removals.
    await owner.query("ALTER FUNCTION application_field_digest(jsonb) SET search_path=public")
    const drift=await metadata()
    await assert.rejects(owner.query(transition),/Original Memory helper guard not restored/)
    await owner.query('ROLLBACK')
    assert.deepEqual(await metadata(),drift)
    await owner.query('ALTER FUNCTION application_field_digest(jsonb) SET search_path=pg_catalog,public,pg_temp')
    assert.deepEqual(await metadata(),mirrored)
    await owner.query(transition)
    assert.equal(await guard(),true)
    assert.deepEqual(await metadata(),pristine)
    assert.deepEqual((await owner.query("SELECT rolname,rolinherit,rolcanlogin FROM pg_roles WHERE rolname IN('assurance_app','admin_fixture_app') ORDER BY rolname")).rows,historicalRoles)
    await owner.query(transition)
    assert.deepEqual(await metadata(),pristine)
    // No body, owner, OID or canonical ACL is refreshed on successful repeat.
    await owner.query(await runtimeRoleSql('activate',{password:'a'.repeat(64)}))
    await owner.query(await runtimeRoleSql('verify'))
    assert.deepEqual(await metadata(),pristine)
  } catch(error) {
    console.error('Fixed transition assertion failed:',error.actual ?? error)
    throw error
  } finally {
    try {
      await owner.query('ROLLBACK')
      await owner.query('REVOKE ALL ON FUNCTION application_scoped_grant_allowed_before_records(uuid,jsonb) FROM assurance_app,admin_fixture_app')
      for(const signature of signatures)await owner.query(`REVOKE ALL ON FUNCTION public.${signature} FROM assurance_app,admin_fixture_app`)
      await owner.query('DROP ROLE assurance_app,admin_fixture_app')
    } finally { await owner.end() }
  }
})

test('[COMP:crm/assurance-fixture] Pre8111 narrowing commits separately and the unchanged gate remains authoritative', {timeout:45_000}, async t => {
  await assertLocalFixture()
  const env=cleanRuntimeEnvironment(process.env)
  const pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
  const transition=await runtimeRoleSql('transition')
  const signatures=[...transition.matchAll(/\('([^']+)','(?:memories|workspace_scope_reviews|application_source_setup_reviews)'/g)].map(match=>match[1])
  const control=new pg.Client({connectionString:process.env.DATABASE_URL});await control.connect()
  let controlHelper
  try{controlHelper=(await control.query("SELECT 'public.application_memory_statement_state(uuid,uuid,text[],jsonb)'::regprocedure::oid AS oid")).rows[0].oid}finally{await control.end()}
  for(const unknownBody of [false,true]) {
    let calls=0,ownedMarker,narrowed=false
    const create=()=>createLocalFixture({pgBin,env,beforeApplyFile:'8111_native_memory_statement_visitor.sql',beforeApply:async({adminUrl,appUrl,env:owned})=>{
      calls++;ownedMarker=owned.BRIAN_ASSURANCE_FIXTURE
      const owner=new pg.Client({connectionString:adminUrl}),app=new pg.Client({connectionString:appUrl})
      await owner.connect();await app.connect()
      try {
        assert.equal((await app.query('SELECT current_user AS role')).rows[0].role,'app_user')
        for(const alias of ['assurance_app','admin_fixture_app'])await owner.query(`CREATE ROLE ${alias} NOLOGIN ${alias==='admin_fixture_app'?'INHERIT':'NOINHERIT'} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
        for(const signature of signatures)await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO assurance_app,admin_fixture_app`)
        const migration=await readFile(new URL('../../../packages/api/migrations/8111_native_memory_statement_visitor.sql',import.meta.url),'utf8')
        await assert.rejects(owner.query(migration),/Memory statement prerequisite changed/)
        await owner.query('ROLLBACK')
        assert.equal((await owner.query("SELECT count(*)::int AS count FROM _migrations WHERE name='8111_native_memory_statement_visitor.sql'")).rows[0].count,0)
        if(unknownBody){
          const definition=(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',['read_entity_derivation_source(uuid,text,uuid)'])).rows[0].definition
          assert.match(definition,/AS \$function\$/)
          await owner.query(definition.replace('AS $function$','AS $function$\n-- Unknown fixture-only definition drift.'))
        }
        const before=(await owner.query("SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p ORDER BY oid")).rows
        const ledger=(await owner.query('SELECT * FROM _migrations ORDER BY name')).rows
        await owner.query(transition)
        narrowed=true
        assert.deepEqual((await owner.query("SELECT oid,to_jsonb(p)-'proacl' AS metadata FROM pg_proc p ORDER BY oid")).rows,before)
        assert.deepEqual((await owner.query('SELECT * FROM _migrations ORDER BY name')).rows,ledger)
        for(const signature of signatures)assert.equal((await owner.query(`SELECT count(*)::int AS count FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a JOIN pg_roles r ON r.oid=a.grantee WHERE p.oid=$1::regprocedure AND r.rolname IN('assurance_app','admin_fixture_app')`,[signature])).rows[0].count,0)
        if(!unknownBody)for(let i=0;i<8;i++)await owner.query(`CREATE FUNCTION fixture_oid_padding_${i}() RETURNS integer LANGUAGE sql AS 'SELECT 1'`)
        t.diagnostic(JSON.stringify({phase:'pre8111',unknownBody,committedPermissionNarrowing:true,ledgerUnchanged:true}))
      }finally{await app.end();await owner.end()}
    }})
    if(unknownBody){
      await assert.rejects(create(),/Memory statement prerequisite changed/)
      assert.equal(narrowed,true)
      await assert.rejects(readFile(ownedMarker),{code:'ENOENT'})
    }else{
      const fixture=await create()
      try{
        assert.equal(narrowed,true)
        const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
        try{
          assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,true)
          const varied=(await owner.query("SELECT 'public.application_memory_statement_state(uuid,uuid,text[],jsonb)'::regprocedure::oid AS oid")).rows[0].oid
          assert.notEqual(varied,controlHelper)
          t.diagnostic(JSON.stringify({localStatementHelperOidsDiffer:true,closedGuardRecognized:true}))
        }finally{await owner.end()}
      }finally{await fixture.dispose()}
      await assert.rejects(readFile(ownedMarker),{code:'ENOENT'})
    }
    assert.equal(calls,1)
  }
})

test('[COMP:crm/assurance-fixture] Known suffix ACL restoration preserves the unchanged 8121 and 8124 gates', {timeout:45_000}, async t => {
  await assertLocalFixture()
  const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
  const transition=await runtimeRoleSql('transition')
  const signatures=[...transition.matchAll(/\('([^']+)','(?:memories|workspace_scope_reviews|application_source_setup_reviews)'/g)].map(match=>match[1])
  for(const boundary of ['8121_application_legacy_authoring_retirement.sql','8124_application_source_host_retirement.sql']) {
    let calls=0
    const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:boundary,beforeApply:async({adminUrl})=>{
      calls++
      const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
      try{
        const pristine=(await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows
        for(const alias of ['assurance_app','admin_fixture_app'])await owner.query(`CREATE ROLE ${alias} LOGIN ${alias==='admin_fixture_app'?'INHERIT':'NOINHERIT'} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`)
        // Includes legitimate stale authoring grants carried over from before8121.
        for(const signature of signatures)await owner.query(`GRANT EXECUTE ON FUNCTION public.${signature} TO assurance_app,admin_fixture_app`)
        assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,false)
        await owner.query(transition)
        assert.deepEqual((await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows,pristine)
        assert.equal((await owner.query("SELECT bool_and(rolcanlogin) AS active FROM pg_roles WHERE rolname IN('assurance_app','admin_fixture_app')")).rows[0].active,true)
      }finally{await owner.end()}
    }})
    try{
      const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
      try{
        await owner.query(await runtimeRoleSql('verify'))
        assert.equal((await owner.query("SELECT has_function_privilege('app_user','application_legacy_inventory(uuid,uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed,false)
        t.diagnostic(JSON.stringify({boundary,restored16:true,originalSuffixPassed:true,aliasesRetiredAfterSuccess:true}))
      }finally{await owner.end()}
    }finally{await fixture.dispose()}
    assert.equal(calls,1)
  }
})

test('[COMP:crm/assurance-fixture] Actual120-only and8112-only prefixes refuse before invoking old traffic', {timeout:30_000},async()=>{
  await assertLocalFixture()
  const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
  for(const [beforeApplyFile,error] of [
    ['8112_native_feedback_outcome_projection.sql',/Unsupported 120-only fixture phase/],
    ['8113_native_memory_statement_helper_projection_guard.sql',/Unsupported 8112-only fixture phase/],
  ]){
    let calls=0
    await assert.rejects(createLocalFixture({pgBin,env,beforeApplyFile,beforeApply:async()=>{calls++}}),error)
    assert.equal(calls,0)
  }
})

async function assertClosedGuardRefusals(t,adminUrl,pinCount) {
  const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  const signature='public.application_memory_statement_helpers_current()'
  const original=(await owner.query('SELECT p.*,pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE oid=$1::regprocedure',[signature])).rows[0]
  const replaceBody=body=>owner.query(`CREATE OR REPLACE FUNCTION ${signature} RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $fixture_guard$${body}$fixture_guard$`)
  const restore=async()=>{
    await owner.query('ROLLBACK')
    await owner.query(original.definition)
    await owner.query(`ALTER FUNCTION ${signature} COST 100`)
    await owner.query(`REVOKE ALL ON FUNCTION ${signature} FROM app_user`)
  }
  try {
    const pins=[...original.prosrc.matchAll(/\(([0-9]+)::oid,'([0-9a-f]{64})'::text\)/g)]
    assert.equal(pins.length,pinCount)
    const first=pins[0][0],last=pins[pinCount-1][0]
    const unknownOid=(await owner.query("SELECT 'pg_catalog.now()'::regprocedure::oid AS oid")).rows[0].oid
    const cases=[
      ['marker',()=>replaceBody(" SELECT set_config('app.fixture_guard_invoked','1',false) IS NOT NULL ")],
      ['constant true',()=>replaceBody(' SELECT true ')],
      ['constant false',()=>replaceBody(' SELECT false ')],
      ['oversized body',()=>replaceBody(original.prosrc+'\n--'+ 'x'.repeat(24001))],
      ['trailing text',()=>replaceBody(original.prosrc+'\n-- Unknown fixture-only guard text.')],
      ['duplicate pin',()=>replaceBody(original.prosrc.replace(last,first))],
      ['missing pin',()=>replaceBody(original.prosrc.replace(','+last,''))],
      ['extra pin',()=>replaceBody(original.prosrc.replace(last,last+','+last))],
      ['unknown identity',()=>replaceBody(original.prosrc.replace(first,first.replace(pins[0][1],String(unknownOid))))],
      ['noncanonical pin',()=>replaceBody(original.prosrc.replace(first,first.replace(pins[0][1],'0'+pins[0][1])))],
      ['changed template operator',()=>replaceBody(original.prosrc.replace(`SELECT count(*)=${pinCount}`,`SELECT count(*)>=${pinCount}`))],
      ['changed source literal',()=>replaceBody(original.prosrc.replace('Byte-identical current Memory retirement','Unknown current Memory retirement'))],
      ['changed metadata',()=>owner.query(`ALTER FUNCTION ${signature} COST 101`)],
      ['changed search path',()=>owner.query(`ALTER FUNCTION ${signature} SET search_path=public`)],
      ['nonprivate ACL',()=>owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)],
    ]
    for(const [label,mutate] of cases)for(const phase of ['verify','prepare','transition','activate']){
      await restore();await owner.query("SELECT set_config('app.fixture_guard_invoked','',false)")
      await mutate()
      const before=(await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows
      const roles=(await owner.query("SELECT rolname,rolcanlogin,rolinherit,rolconfig FROM pg_roles WHERE rolname='app_user'")).rows
      const sql=await runtimeRoleSql(phase,{password:phase==='activate'?'a'.repeat(64):undefined})
      try{await assert.rejects(owner.query(sql),/Unknown fixture Memory guard/)}
      catch(error){await owner.query('ROLLBACK');t.diagnostic(JSON.stringify({label,phase,guardInvoked:(await owner.query("SELECT current_setting('app.fixture_guard_invoked',true) AS marker")).rows[0].marker}));throw error}
      await owner.query('ROLLBACK')
      assert.notEqual((await owner.query("SELECT current_setting('app.fixture_guard_invoked',true) AS marker")).rows[0].marker,'1',label+':'+phase)
      assert.deepEqual((await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows,before,label+':'+phase)
      assert.deepEqual((await owner.query("SELECT rolname,rolcanlogin,rolinherit,rolconfig FROM pg_roles WHERE rolname='app_user'")).rows,roles,label+':'+phase)
    }
  }finally{await restore();await owner.end()}
}

test('[COMP:crm/assurance-fixture] Every fixture phase retains closed121 and ledger-qualified122 guard recognition', {timeout:300_000}, async t=>{
  await assertLocalFixture()
  await assertClosedGuardRefusals(t,process.env.DATABASE_URL,122)
  const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
  let calls=0
  const prefix=await createLocalFixture({pgBin,env,beforeApplyFile:'8128_native_memory_history_admission.sql',beforeApply:async({adminUrl})=>{
    calls++
    await assertClosedGuardRefusals(t,adminUrl,121)
    const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
    try{
      const migration=await readFile(new URL('../../../packages/api/migrations/8128_native_memory_history_admission.sql',import.meta.url),'utf8')
      const ledger=(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
      const catalog=(await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows
      for(const [signature,before,after] of [
        ['application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','DEFAULT false','DEFAULT true'],
        ['application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)','DEFAULT NULL::jsonb',"DEFAULT '{}'::jsonb"],
      ]){
        const original=(await owner.query('SELECT to_jsonb(p) AS metadata,pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE oid=$1::regprocedure',[signature])).rows[0]
        assert.equal(original.definition.split(before).length,2)
        await owner.query('BEGIN')
        try{
          await owner.query(original.definition.replace(before,after))
          assert.equal((await owner.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].prosrc,original.metadata.prosrc)
          await assert.rejects(owner.query(migration),/Memory history/)
        }finally{await owner.query('ROLLBACK')}
        assert.deepEqual((await owner.query('SELECT to_jsonb(p) AS metadata FROM pg_proc p WHERE oid=$1::regprocedure',[signature])).rows[0].metadata,original.metadata)
        assert.deepEqual((await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows,ledger)
        assert.deepEqual((await owner.query('SELECT oid,to_jsonb(p) AS metadata FROM pg_proc p ORDER BY oid')).rows,catalog)
        assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current,true)
      }
    }finally{await owner.end()}
  }})
  try{assert.equal(calls,1);await assertClosedGuardRefusals(t,prefix.adminUrl,122)}finally{await prefix.dispose()}
})

test('[COMP:crm/assurance-fixture] History guard identity, private metadata and missing guard refuse before invocation', async()=>{
 await assertLocalFixture()
 const owner=new pg.Client({connectionString:process.env.DATABASE_URL});await owner.connect()
 try{
  for(const phase of ['prepare','transition','activate','verify'])for(const change of ['helper identity','helper ACL','helper metadata','missing guard']){
   await owner.query('BEGIN')
   try{
    if(change==='helper identity')await owner.query('ALTER FUNCTION application_memory_history_status(uuid,uuid,text) RENAME TO fixture_unknown_history_status')
    if(change==='helper ACL')await owner.query('GRANT EXECUTE ON FUNCTION application_memory_history_status(uuid,uuid,text) TO app_user')
    if(change==='helper metadata')await owner.query('ALTER FUNCTION application_memory_history_status(uuid,uuid,text) COST 101')
    if(change==='missing guard')await owner.query('DROP FUNCTION application_memory_statement_helpers_current()')
    await assert.rejects(owner.query(await runtimeRoleSql(phase,{password:phase==='activate'?'a'.repeat(64):undefined})),/Unknown fixture Memory guard/)
   }finally{await owner.query('ROLLBACK')}
  }
 }finally{await owner.end()}
})


test('[COMP:crm/assurance-fixture] Native history title migration preserves599 state and rejects prerequisite drift', {timeout:180_000}, async t=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 const migration=await readFile(new URL('../../../packages/api/migrations/8129_native_history_title_dependencies.sql',import.meta.url),'utf8')
 const inventory=(await readdir(new URL('../../../packages/api/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()
 const signatures=['validate_application_field_dependencies()','publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)',
  'read_native_session_field_dependencies(uuid,text[],uuid[],text[])','read_native_attended_memory_evidence(uuid,text[],uuid[],text[])','application_memory_history_status(uuid,uuid,text)','application_memory_statement_helpers_current()','session_context_revision_allowed(uuid,uuid)']
 const metadata=async owner=>(await owner.query('SELECT p.oid::text AS oid,to_jsonb(p) AS value FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY p.oid',[signatures])).rows
 const guard=async owner=>(await owner.query('SELECT application_memory_statement_helpers_current() AS current,(SELECT count(*)::int FROM _migrations) AS ledger')).rows[0]
 let before,ledger,seed,calls=0
 const ids=[randomUUID(),randomUUID(),randomUUID()]
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:'8129_native_history_title_dependencies.sql',beforeApply:async({adminUrl})=>{
  calls++;const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:599})
   before=await metadata(owner);ledger=(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
   await owner.query("INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)",[ids[0]])
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional preserved title installer',$2)",[ids[1],ids[0]])
   await owner.query("INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources) VALUES($1,$2,'native','fictional_prior','fictional_prior',$3,'fictional_prior',$4,'[]')",[ids[2],ids[1],ids[0],'a'.repeat(64)])
   seed=(await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows
   const changes=[
    ['validator body',()=>owner.query("CREATE OR REPLACE FUNCTION validate_application_field_dependencies() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $$BEGIN RETURN NULL;END$$")],
    ['publisher settings',()=>owner.query('ALTER FUNCTION '+signatures[1]+' COST 101')],
    ['private ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[0]+' TO app_user')],
    ['dependency body',async()=>{const row=before.find(r=>r.value.proname==='read_native_session_field_dependencies');const definition=(await owner.query('SELECT pg_get_functiondef($1::oid) AS value',[row.oid])).rows[0].value;await owner.query(definition.replace(row.value.prosrc,row.value.prosrc+'\n-- fictional prerequisite drift'))}],
    ['C admission body',async()=>{const row=before.find(r=>r.value.proname==='session_context_revision_allowed');const definition=(await owner.query('SELECT pg_get_functiondef($1::oid) AS value',[row.oid])).rows[0].value;await owner.query(definition.replace(row.value.prosrc,row.value.prosrc+'\n-- fictional prerequisite drift'))}],
    ['C admission search path',()=>owner.query('ALTER FUNCTION '+signatures[6]+' SET search_path=public')],
    ['C admission owner',()=>owner.query('ALTER FUNCTION '+signatures[6]+' OWNER TO app_user')],
    ['C admission ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[6]+' TO PUBLIC')],
    ['deferred trigger',()=>owner.query('ALTER TABLE scope_derivation_sources DISABLE TRIGGER application_field_derivation_dependencies')],
   ]
   for(const[label,change]of changes){
    await owner.query('BEGIN')
    try{await change();await assert.rejects(owner.query(migration),/Native history title/)}finally{await owner.query('ROLLBACK')}
    assert.deepEqual(await metadata(owner),before,label);assert.deepEqual((await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows,ledger,label)
    assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed,label)
    assert.deepEqual(await guard(owner),{current:true,ledger:599},label)
   }
  }finally{await owner.end()}
 }})
 try{
  assert.equal(calls,1);const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:inventory.length})
   const after=await metadata(owner)
   assert.equal(after.length,before.length)
   for(let n=0;n<after.length;n++){
    const previous=before[n],current=after[n];assert.equal(current.oid,previous.oid)
    if(['validate_application_field_dependencies','publish_native_session_context_revision','session_context_revision_allowed','read_native_session_field_dependencies'].includes(current.value.proname)){
     const{prosrc:oldBody,...oldProperties}=previous.value,{prosrc:newBody,...newProperties}=current.value
     assert.deepEqual(newProperties,oldProperties);assert.notEqual(newBody,oldBody)
    }else assert.deepEqual(current,previous)
   }
   const completeLedger=(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
   const oldNames=new Set(ledger.map(row=>row.name))
   assert.deepEqual(completeLedger.filter(row=>oldNames.has(row.name)),ledger)
   const expectedNewNames=inventory.filter(name=>!oldNames.has(name))
   assert.deepEqual(completeLedger.filter(row=>!oldNames.has(row.name)).map(row=>row.name),expectedNewNames)
   assert.equal(completeLedger.filter(row=>row.name==='8129_native_history_title_dependencies.sql').length,1)
   assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed)
   assert.deepEqual((await owner.query("SELECT tgenabled,tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='application_field_derivation_dependencies'")).rows,[{tgenabled:'O',tgdeferrable:true,tginitdeferred:true}])
   const{tsImport}=await import('tsx/esm/api'),{runMigrations}=await tsImport('../../../packages/api/scripts/migrate.ts',import.meta.url)
   assert.equal((await runMigrations({databaseUrl:fixture.adminUrl})).appliedCount,0)
   const fresh=new pg.Client({connectionString:process.env.DATABASE_URL});await fresh.connect()
   try{const freshMetadata=await metadata(fresh);for(const row of after){const other=freshMetadata.find(r=>r.value.proname===row.value.proname);assert.equal(row.value.prosrc,other.value.prosrc)}}finally{await fresh.end()}
   if(process.env.F_E05_MIGRATION_ARTIFACT)await writeFile(process.env.F_E05_MIGRATION_ARTIFACT,JSON.stringify({before,after,ledger,completeLedger,expectedNewNames,seed,guard:await guard(owner),driftRefusals:9,replay:0},null,2)+'\n')
   t.diagnostic(JSON.stringify({ledgerBefore:599,ledgerAfter:inventory.length,guardCurrent:true,changedBodies:4,preservedHelpers:3,driftRefusals:9,replay:0,priorReceiptUnchanged:true}))
  }finally{await owner.end()}
 }finally{await fixture.dispose()}
})

test('[COMP:crm/assurance-fixture] Native governance audit lock migration preserves600 state and rejects prerequisite drift', {timeout:180_000}, async t=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 const migration=await readFile(new URL('../../../packages/api/migrations/8130_application_governance_audit_lock.sql',import.meta.url),'utf8')
 const inventory=(await readdir(new URL('../../../packages/api/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()
 const signature='application_apply_native_governance_review(uuid,uuid,uuid)'
 const catalog=async owner=>(await owner.query("SELECT p.oid::text AS oid,to_jsonb(p) AS value FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid")).rows
 const ledgerRows=async owner=>(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
 const guard=async owner=>(await owner.query('SELECT application_memory_statement_helpers_current() AS current,(SELECT count(*)::int FROM _migrations) AS ledger')).rows[0]
 let before,transition,ledger,seed,calls=0
 const ids=[randomUUID(),randomUUID(),randomUUID()]
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:'8130_application_governance_audit_lock.sql',beforeApply:async({adminUrl})=>{
  calls++;const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:600})
   await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[ids[0]])
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional preserved governance installer',$2)",[ids[1],ids[0]])
   await owner.query("INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources) VALUES($1,$2,'native','fictional_prior_lock','fictional_prior_lock',$3,'fictional_prior_lock',$4,'[]')",[ids[2],ids[1],ids[0],'b'.repeat(64)])
   before=await catalog(owner);ledger=await ledgerRows(owner)
   seed=(await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows
   const predecessor=before.find(row=>row.value.proname==='application_apply_native_governance_review')
   const definition=(await owner.query('SELECT pg_get_functiondef($1::oid) AS value',[predecessor.oid])).rows[0].value
   // Isolate this exact single-body transition before later selected migrations.
   // Keep it inside a rollback transaction; the normal migrator applies8130 next.
   assert.match(migration,/^BEGIN;\n/);assert.match(migration,/COMMIT;\n?$/)
   const bodyOnly=migration.replace(/^BEGIN;\n/,'').replace(/COMMIT;\n?$/,'')
   await owner.query('BEGIN')
   try{
    await owner.query(bodyOnly);transition=await catalog(owner)
    assert.equal(transition.length,before.length)
    for(let n=0;n<transition.length;n++){
     const previous=before[n],current=transition[n];assert.equal(current.oid,previous.oid)
     if(current.value.proname==='application_apply_native_governance_review'){
      const{prosrc:oldBody,...oldProperties}=previous.value,{prosrc:newBody,...newProperties}=current.value
      assert.deepEqual(newProperties,oldProperties)
      assert.equal(newBody,oldBody.replace('PERFORM 1 FROM public.workspaces WHERE id=w FOR UPDATE;','PERFORM 1 FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;')
       .replace('-- The existing workspace UPDATE precedes this service-target module SHARE.','-- Workspace NO KEY UPDATE precedes module SHARE and permits audit FK references.'))
     }else assert.deepEqual(current,previous)
    }
    assert.deepEqual(await ledgerRows(owner),ledger);assert.deepEqual(await guard(owner),{current:true,ledger:600})
   }finally{await owner.query('ROLLBACK')}
   assert.deepEqual(await catalog(owner),before)
   const changes=[
    ['unknown body',()=>owner.query(definition.replace(predecessor.value.prosrc,predecessor.value.prosrc+'\n-- fictional prerequisite drift'))],
    ['security mode',()=>owner.query('ALTER FUNCTION '+signature+' SECURITY INVOKER')],
    ['cost setting',()=>owner.query('ALTER FUNCTION '+signature+' COST 101')],
    ['search path',()=>owner.query('ALTER FUNCTION '+signature+' SET search_path=public')],
    ['owner',()=>owner.query('ALTER FUNCTION '+signature+' OWNER TO app_user')],
    ['PUBLIC ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signature+' TO PUBLIC')],
    ['runtime grant option',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signature+' TO app_user WITH GRANT OPTION')],
   ]
   for(const[label,change]of changes){
    await owner.query('BEGIN')
    try{await change();await assert.rejects(owner.query(migration),/Native governance lock/)}finally{await owner.query('ROLLBACK')}
    assert.deepEqual(await catalog(owner),before,label);assert.deepEqual(await ledgerRows(owner),ledger,label)
    assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed,label)
    assert.deepEqual(await guard(owner),{current:true,ledger:600},label)
   }
  }finally{await owner.end()}
 }})
 try{
  assert.equal(calls,1);const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:inventory.length})
   const after=await catalog(owner)
   assert.deepEqual(after.find(row=>row.value.proname==='application_apply_native_governance_review'),
    transition.find(row=>row.value.proname==='application_apply_native_governance_review'))
   const completeLedger=await ledgerRows(owner),oldNames=new Set(ledger.map(row=>row.name)),expectedNewNames=inventory.filter(name=>!oldNames.has(name))
   assert.deepEqual(completeLedger.filter(row=>oldNames.has(row.name)),ledger)
   assert.deepEqual(completeLedger.filter(row=>!oldNames.has(row.name)).map(row=>row.name),expectedNewNames)
   assert.equal(completeLedger.filter(row=>row.name==='8130_application_governance_audit_lock.sql').length,1)
   assert.equal(completeLedger.filter(row=>row.name==='8129_native_history_title_dependencies.sql').length,1)
   assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed)
   const{tsImport}=await import('tsx/esm/api'),{runMigrations}=await tsImport('../../../packages/api/scripts/migrate.ts',import.meta.url)
   assert.equal((await runMigrations({databaseUrl:fixture.adminUrl})).appliedCount,0)
   const fresh=new pg.Client({connectionString:process.env.DATABASE_URL});await fresh.connect()
   try{assert.equal((await fresh.query('SELECT prosrc FROM pg_proc WHERE oid=$1::regprocedure',[signature])).rows[0].prosrc,after.find(row=>row.value.proname==='application_apply_native_governance_review').value.prosrc)}finally{await fresh.end()}
   if(process.env.F_E07_MIGRATION_ARTIFACT)await writeFile(process.env.F_E07_MIGRATION_ARTIFACT,JSON.stringify({before,transition,after,ledger,completeLedger,expectedNewNames,seed,guard:await guard(owner),driftRefusals:7,replay:0},null,2)+'\n')
   t.diagnostic(JSON.stringify({ledgerBefore:600,ledgerAfter:inventory.length,changedBodies:1,preservedPublicFunctionsAt8130:transition.length-1,guardCurrent:true,driftRefusals:7,replay:0,originalLedgerAndReceiptUnchanged:true}))
  }finally{await owner.end()}
 }finally{await fixture.dispose()}
})

test('[COMP:crm/assurance-fixture] Generic relationship migration preserves601 state and rejects prerequisite drift', {timeout:180_000}, async t=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 const migration=await readFile(new URL('../../../packages/api/migrations/8131_application_generic_relationship_admission.sql',import.meta.url),'utf8')
 const inventory=(await readdir(new URL('../../../packages/api/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()
 const signatures=['application_scoped_grant_allowed_before_modules(uuid,jsonb)','application_path_fields(jsonb,jsonb,uuid,jsonb,text,text,uuid,text,text[],uuid[],uuid,text,jsonb)','application_query_catalog_path(jsonb,jsonb,jsonb,uuid,jsonb,text,jsonb)']
 const names=signatures.map(value=>value.split('(')[0]),expected=['72f08cfdd818faddddbe6aafa341a968a3447c2f1d347b6b7d3e915b22f8baa2','c2f13210a38827f48b8615419b511d842cc701be24c3c6ae222f5a0d117eabcf','b892fbcf62d6527a40babb08c32cba5b1da8b0801621e4408ae2120bdfb68459']
 const catalog=async owner=>(await owner.query("SELECT p.oid::text AS oid,to_jsonb(p) AS value FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid")).rows
 const ledgerRows=async owner=>(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
 const guard=async owner=>(await owner.query('SELECT application_memory_statement_helpers_current() AS current,(SELECT count(*)::int FROM _migrations) AS ledger')).rows[0]
 let before,transition,ledger,seed,calls=0
 const ids=[randomUUID(),randomUUID(),randomUUID()]
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:'8131_application_generic_relationship_admission.sql',beforeApply:async({adminUrl})=>{
  calls++;const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:601})
   await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[ids[0]])
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional preserved relationship installer',$2)",[ids[1],ids[0]])
   await owner.query("INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources) VALUES($1,$2,'native','fictional_prior_relationship','fictional_prior_relationship',$3,'fictional_prior_relationship',$4,'[]')",[ids[2],ids[1],ids[0],'c'.repeat(64)])
   before=await catalog(owner);ledger=await ledgerRows(owner);seed=(await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows
   const helper=before.find(row=>row.value.proname==='application_memory_statement_helpers_current').value
   assert.match(helper.prosrc,/SELECT count\(\*\)=122/);assert.equal([...helper.prosrc.matchAll(/::oid,'[0-9a-f]{64}'::text/g)].length,122)
   const definitions=await Promise.all(signatures.map(async signature=>(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS value',[signature])).rows[0].value))
   assert.match(migration,/^BEGIN;\n/);assert.match(migration,/COMMIT;\n?$/)
   await owner.query('BEGIN')
   try{
    await owner.query(migration.replace(/^BEGIN;\n/,'').replace(/COMMIT;\n?$/,''));transition=await catalog(owner);assert.equal(transition.length,before.length)
    for(let n=0;n<transition.length;n++){
     const previous=before[n],current=transition[n];assert.equal(current.oid,previous.oid)
     const index=names.indexOf(current.value.proname)
     if(index>=0){const{prosrc:oldBody,...oldProperties}=previous.value,{prosrc:newBody,...newProperties}=current.value;assert.deepEqual(newProperties,oldProperties);assert.notEqual(newBody,oldBody)
      assert.equal((await owner.query("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS hash",[newBody])).rows[0].hash,expected[index])
     }else assert.deepEqual(current,previous)
    }
    assert.deepEqual(await ledgerRows(owner),ledger);assert.deepEqual(await guard(owner),{current:true,ledger:601})
   }finally{await owner.query('ROLLBACK')}
   assert.deepEqual(await catalog(owner),before)
   const changes=signatures.map((signature,n)=>['unknown body '+names[n],()=>owner.query(definitions[n].replace(before.find(row=>row.value.proname===names[n]).value.prosrc,before.find(row=>row.value.proname===names[n]).value.prosrc+'\n-- fictional prerequisite drift'))])
   changes.push(['path volatility',()=>owner.query('ALTER FUNCTION '+signatures[1]+' STABLE')],
    ['path default',()=>{assert.match(definitions[1],/DEFAULT NULL::jsonb/);return owner.query(definitions[1].replace('DEFAULT NULL::jsonb',"DEFAULT '{}'::jsonb"))}],
    ['search path',()=>owner.query('ALTER FUNCTION '+signatures[0]+' SET search_path=public')],
    ['owner',()=>owner.query('ALTER FUNCTION '+signatures[2]+' OWNER TO app_user')],
    ['PUBLIC ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[0]+' TO PUBLIC')],
    ['runtime ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[1]+' TO app_user')])
   for(const[label,change]of changes){
    await owner.query('BEGIN');try{await change();await assert.rejects(owner.query(migration),/Generic relationship/)}finally{await owner.query('ROLLBACK')}
    assert.deepEqual(await catalog(owner),before,label);assert.deepEqual(await ledgerRows(owner),ledger,label)
    assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed,label)
    assert.deepEqual(await guard(owner),{current:true,ledger:601},label)
   }
  }finally{await owner.end()}
 }})
 try{
  assert.equal(calls,1);const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:inventory.length});const after=await catalog(owner)
   for(const name of names)assert.deepEqual(after.find(row=>row.value.proname===name),transition.find(row=>row.value.proname===name))
   const completeLedger=await ledgerRows(owner),oldNames=new Set(ledger.map(row=>row.name)),expectedNewNames=inventory.filter(name=>!oldNames.has(name))
   assert.deepEqual(completeLedger.filter(row=>oldNames.has(row.name)),ledger);assert.deepEqual(completeLedger.filter(row=>!oldNames.has(row.name)).map(row=>row.name),expectedNewNames)
   assert.equal(completeLedger.filter(row=>row.name==='8131_application_generic_relationship_admission.sql').length,1)
   assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed)
   const{tsImport}=await import('tsx/esm/api'),{runMigrations}=await tsImport('../../../packages/api/scripts/migrate.ts',import.meta.url);assert.equal((await runMigrations({databaseUrl:fixture.adminUrl})).appliedCount,0)
   const fresh=new pg.Client({connectionString:process.env.DATABASE_URL});await fresh.connect()
   try{for(const name of names)assert.equal((await fresh.query("SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1",[name])).rows[0].prosrc,after.find(row=>row.value.proname===name).value.prosrc)}finally{await fresh.end()}
   if(process.env.F_E08_MIGRATION_ARTIFACT)await writeFile(process.env.F_E08_MIGRATION_ARTIFACT,JSON.stringify({before,transition,after,ledger,completeLedger,expectedNewNames,seed,guard:await guard(owner),driftRefusals:9,replay:0},null,2)+'\n')
   t.diagnostic(JSON.stringify({ledgerBefore:601,ledgerAfter:inventory.length,changedBodies:3,preservedFunctionsAt8131:transition.length-3,guardCurrent:true,driftRefusals:9,replay:0}))
  }finally{await owner.end()}
 }finally{await fixture.dispose()}
})

test('[COMP:crm/assurance-fixture] Native transcript dependency migration preserves602 state and rejects prerequisite drift', {timeout:180_000}, async()=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 const name='8132_native_history_transcript_dependencies.sql',migration=await readFile(new URL('../../../packages/api/migrations/'+name,import.meta.url),'utf8')
 const inventory=(await readdir(new URL('../../../packages/api/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()
 const signatures=['prepare_native_session_message_batch(uuid,uuid,text,jsonb,jsonb)','validate_application_field_dependencies()']
 const expected=['56495fea6eade9f397d21dc725501159dc3f928c2786dcb005dedc4513e0f30d','6f86fbd4c0cc5c77e69a91c6c0c211b0b70c69f49dfd89b3ec85eddff39d9091']
 const names=signatures.map(value=>value.split('(')[0]),helper='read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'
 const catalog=async owner=>(await owner.query("SELECT p.oid::text AS oid,to_jsonb(p) AS value FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid")).rows
 const trigger=async owner=>(await owner.query("SELECT to_jsonb(t) AS value FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies'")).rows
 const ledgerRows=async owner=>(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
 const guard=async owner=>(await owner.query('SELECT application_memory_statement_helpers_current() AS current,(SELECT count(*)::int FROM _migrations) AS ledger')).rows[0]
 let before,transition,ledger,seed,triggers,calls=0
 const ids=[randomUUID(),randomUUID(),randomUUID()]
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:name,beforeApply:async({adminUrl})=>{
  calls++;const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:602})
   await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[ids[0]])
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional preserved transcript installer',$2)",[ids[1],ids[0]])
   await owner.query("INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources) VALUES($1,$2,'native','fictional_prior_transcript','fictional_prior_transcript',$3,'fictional_prior_transcript',$4,'[]')",[ids[2],ids[1],ids[0],'d'.repeat(64)])
   before=await catalog(owner);triggers=await trigger(owner);ledger=await ledgerRows(owner)
   seed=(await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows
   const pin=before.find(row=>row.value.proname==='application_memory_statement_helpers_current').value
   assert.match(pin.prosrc,/SELECT count\(\*\)=122/);assert.equal([...pin.prosrc.matchAll(/::oid,'[0-9a-f]{64}'::text/g)].length,122)
   const definitions=await Promise.all([...signatures,helper].map(async signature=>(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS value',[signature])).rows[0].value))
   assert.match(migration,/^BEGIN;\n/);assert.match(migration,/COMMIT;\n?$/)
   await owner.query('BEGIN')
   try{
    await owner.query(migration.replace(/^BEGIN;\n/,'').replace(/COMMIT;\n?$/,''));transition=await catalog(owner);assert.equal(transition.length,before.length)
    for(let n=0;n<transition.length;n++){
     const previous=before[n],current=transition[n];assert.equal(current.oid,previous.oid);const index=names.indexOf(current.value.proname)
     if(index>=0){const{prosrc:oldBody,...oldProperties}=previous.value,{prosrc:newBody,...newProperties}=current.value;assert.deepEqual(newProperties,oldProperties);assert.notEqual(newBody,oldBody)
      assert.equal((await owner.query("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS hash",[newBody])).rows[0].hash,expected[index])
     }else assert.deepEqual(current,previous)
    }
    assert.deepEqual(await trigger(owner),triggers);assert.deepEqual(await ledgerRows(owner),ledger);assert.deepEqual(await guard(owner),{current:true,ledger:602})
   }finally{await owner.query('ROLLBACK')}
   assert.deepEqual(await catalog(owner),before);assert.deepEqual(await trigger(owner),triggers)
   const changes=signatures.map((signature,n)=>['unknown body '+names[n],()=>owner.query(definitions[n].replace(before.find(row=>row.value.proname===names[n]).value.prosrc,before.find(row=>row.value.proname===names[n]).value.prosrc+'\n-- fictional transcript prerequisite drift'))])
   const helperBefore=before.find(row=>row.value.proname==='read_native_attended_memory_evidence').value
   changes.push(['target security',()=>owner.query('ALTER FUNCTION '+signatures[0]+' SECURITY INVOKER')],
    ['target setting',()=>owner.query('ALTER FUNCTION '+signatures[1]+' SET plan_cache_mode=force_custom_plan')],
    ['target owner',()=>owner.query('ALTER FUNCTION '+signatures[0]+' OWNER TO app_user')],
    ['target PUBLIC ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[0]+' TO PUBLIC')],
    ['target runtime ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[1]+' TO app_user')],
    ['reused helper body',()=>owner.query(definitions[2].replace(helperBefore.prosrc,helperBefore.prosrc+'\n-- fictional reused-helper prerequisite drift'))],
    ['reused helper ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+helper+' TO PUBLIC')],
    ['deferred trigger disabled',()=>owner.query('ALTER TABLE scope_derivation_sources DISABLE TRIGGER application_field_derivation_dependencies')])
   for(const[label,change]of changes){
    await owner.query('BEGIN');try{await change();await assert.rejects(owner.query(migration),/Native history transcript/)}finally{await owner.query('ROLLBACK')}
    assert.deepEqual(await catalog(owner),before,label);assert.deepEqual(await trigger(owner),triggers,label);assert.deepEqual(await ledgerRows(owner),ledger,label)
    assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed,label)
    assert.deepEqual(await guard(owner),{current:true,ledger:602},label)
   }
  }finally{await owner.end()}
 }})
 try{
  assert.equal(calls,1);const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:inventory.length});const after=await catalog(owner),completeLedger=await ledgerRows(owner)
   for(const name of names)assert.deepEqual(after.find(row=>row.value.proname===name),transition.find(row=>row.value.proname===name))
   assert.deepEqual(await trigger(owner),triggers)
   assert.deepEqual(completeLedger.filter(row=>ledger.some(old=>old.name===row.name)),ledger)
   const expectedNewNames=inventory.filter(name=>!ledger.some(old=>old.name===name));assert.deepEqual(completeLedger.filter(row=>!ledger.some(old=>old.name===row.name)).map(row=>row.name),expectedNewNames)
   assert.equal(completeLedger.filter(row=>row.name===name).length,1)
   assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed)
   const{tsImport}=await import('tsx/esm/api'),{runMigrations}=await tsImport('../../../packages/api/scripts/migrate.ts',import.meta.url);assert.equal((await runMigrations({databaseUrl:fixture.adminUrl})).appliedCount,0)
   const fresh=new pg.Client({connectionString:process.env.DATABASE_URL});await fresh.connect()
   try{for(let n=0;n<signatures.length;n++)assert.equal((await fresh.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash FROM pg_proc WHERE oid=$1::regprocedure",[signatures[n]])).rows[0].hash,expected[n])}finally{await fresh.end()}
   if(process.env.F_E09A_MIGRATION_ARTIFACT)await writeFile(process.env.F_E09A_MIGRATION_ARTIFACT,JSON.stringify({before,transition,after,triggers,ledger,completeLedger,expectedNewNames,seed,guard:await guard(owner),driftRefusals:10,replay:0},null,2)+'\n')
   console.log(JSON.stringify({ledgerBefore:602,ledgerAfter:inventory.length,changedBodies:2,preservedFunctionsAt8132:before.length-2,guardCurrent:true,driftRefusals:10,replay:0}))
  }finally{await owner.end()}
 }finally{await fixture.dispose()}
})

test('[COMP:crm/assurance-fixture] Native transcript read migration preserves603 state and rejects prerequisite drift', {timeout:180_000}, async()=>{
 await assertLocalFixture()
 const env=cleanRuntimeEnvironment(process.env),pgBin=(await runCommand('pg_config',['--bindir'],{env})).trim()
 const name='8133_native_history_transcript_read.sql',migration=await readFile(new URL('../../../packages/api/migrations/'+name,import.meta.url),'utf8')
 const inventory=(await readdir(new URL('../../../packages/api/migrations/',import.meta.url))).filter(name=>name.endsWith('.sql')).sort()
 const signatures=['application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','application_field_envelope_ancestry_allowed(uuid,jsonb)','read_native_session_field_dependencies(uuid,text[],uuid[],text[])']
 const expected=[] // Derived from the isolated reviewed migration, including later bounded body corrections.
 const names=signatures.map(value=>value.split('(')[0]),helper='read_native_attended_memory_evidence(uuid,text[],uuid[],text[])'
 const catalog=async owner=>(await owner.query("SELECT p.oid::text AS oid,to_jsonb(p) AS value FROM pg_proc p WHERE p.pronamespace='public'::regnamespace ORDER BY p.oid")).rows
 const trigger=async owner=>(await owner.query("SELECT to_jsonb(t) AS value FROM pg_trigger t WHERE tgrelid='public.scope_derivation_sources'::regclass AND tgname='application_field_derivation_dependencies'")).rows
 const ledgerRows=async owner=>(await owner.query('SELECT name,applied_at::text FROM _migrations ORDER BY name')).rows
 const guard=async owner=>(await owner.query('SELECT application_memory_statement_helpers_current() AS current,(SELECT count(*)::int FROM _migrations) AS ledger')).rows[0]
 let before,transition,ledger,seed,triggers,calls=0
 const ids=[randomUUID(),randomUUID(),randomUUID()]
 const fixture=await createLocalFixture({pgBin,env,beforeApplyFile:name,beforeApply:async({adminUrl})=>{
  calls++;const owner=new pg.Client({connectionString:adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:603})
   await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[ids[0]])
   await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional preserved transcript read installer',$2)",[ids[1],ids[0]])
   await owner.query("INSERT INTO application_operation_receipts(id,workspace_id,module_key,operation_key,actor_key,actor_user_id,idempotency_key,request_hash,resources) VALUES($1,$2,'native','fictional_prior_transcript_read','fictional_prior_transcript_read',$3,'fictional_prior_transcript_read',$4,'[]')",[ids[2],ids[1],ids[0],'d'.repeat(64)])
   before=await catalog(owner);triggers=await trigger(owner);ledger=await ledgerRows(owner);assert.equal(before.length,1289)
   seed=(await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows
   const pin=before.find(row=>row.value.proname==='application_memory_statement_helpers_current').value
   assert.match(pin.prosrc,/SELECT count\(\*\)=122/);assert.equal([...pin.prosrc.matchAll(/::oid,'[0-9a-f]{64}'::text/g)].length,122)
   const definitions=await Promise.all([...signatures,helper].map(async signature=>(await owner.query('SELECT pg_get_functiondef($1::regprocedure) AS value',[signature])).rows[0].value))
   assert.match(migration,/^BEGIN;\n/);assert.match(migration,/COMMIT;\n?$/)
   await owner.query('BEGIN')
   try{
    await owner.query(migration.replace(/^BEGIN;\n/,'').replace(/COMMIT;\n?$/,''));transition=await catalog(owner);assert.equal(transition.length,before.length)
    for(let n=0;n<transition.length;n++){
     const previous=before[n],current=transition[n];assert.equal(current.oid,previous.oid);const index=names.indexOf(current.value.proname)
     if(index>=0){const{prosrc:oldBody,...oldProperties}=previous.value,{prosrc:newBody,...newProperties}=current.value;assert.deepEqual(newProperties,oldProperties);assert.notEqual(newBody,oldBody)
      expected[index]=(await owner.query("SELECT encode(sha256(convert_to($1,'UTF8')),'hex') AS hash",[newBody])).rows[0].hash
     }else assert.deepEqual(current,previous)
    }
    assert.equal(transition.filter((row,n)=>row.value.prosrc!==before[n].value.prosrc).length,3);assert.equal(transition.length-3,1286)
    assert.equal(expected.length,3);assert.ok(expected.every(hash=>/^[a-f0-9]{64}$/.test(hash)))
    assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed)
    assert.deepEqual(await trigger(owner),triggers);assert.deepEqual(await ledgerRows(owner),ledger);assert.deepEqual(await guard(owner),{current:true,ledger:603})
   }finally{await owner.query('ROLLBACK')}
   assert.deepEqual(await catalog(owner),before);assert.deepEqual(await trigger(owner),triggers)
   const changes=signatures.map((signature,n)=>['unknown body '+names[n],()=>owner.query(definitions[n].replace(before.find(row=>row.value.proname===names[n]).value.prosrc,before.find(row=>row.value.proname===names[n]).value.prosrc+'\n-- fictional transcript prerequisite drift'))])
   const helperBefore=before.find(row=>row.value.proname==='read_native_attended_memory_evidence').value
   changes.push(['target security',()=>owner.query('ALTER FUNCTION '+signatures[0]+' SECURITY INVOKER')],
    ['target setting',()=>owner.query('ALTER FUNCTION '+signatures[1]+' SET search_path=public')],
    ['target owner',()=>owner.query('ALTER FUNCTION '+signatures[0]+' OWNER TO app_user')],
    ['target PUBLIC ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[0]+' TO PUBLIC')],
    ['target runtime ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+signatures[1]+' TO app_user')],
    ['reused helper body',()=>owner.query(definitions[3].replace(helperBefore.prosrc,helperBefore.prosrc+'\n-- fictional reused-helper prerequisite drift'))],
    ['reused helper ACL',()=>owner.query('GRANT EXECUTE ON FUNCTION '+helper+' TO PUBLIC')],
    ['deferred trigger disabled',()=>owner.query('ALTER TABLE scope_derivation_sources DISABLE TRIGGER application_field_derivation_dependencies')])
   for(const[label,change]of changes){
    await owner.query('BEGIN');try{await change();await assert.rejects(owner.query(migration),/Native history transcript/)}finally{await owner.query('ROLLBACK')}
    assert.deepEqual(await catalog(owner),before,label);assert.deepEqual(await trigger(owner),triggers,label);assert.deepEqual(await ledgerRows(owner),ledger,label)
    assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed,label)
    assert.deepEqual(await guard(owner),{current:true,ledger:603},label)
   }
  }finally{await owner.end()}
 }})
 try{
  assert.equal(calls,1);const owner=new pg.Client({connectionString:fixture.adminUrl});await owner.connect()
  try{
   assert.deepEqual(await guard(owner),{current:true,ledger:inventory.length});const after=await catalog(owner),completeLedger=await ledgerRows(owner)
   for(const name of names)assert.deepEqual(after.find(row=>row.value.proname===name),transition.find(row=>row.value.proname===name))
   assert.deepEqual(await trigger(owner),triggers)
   assert.deepEqual(completeLedger.filter(row=>ledger.some(old=>old.name===row.name)),ledger)
   const expectedNewNames=inventory.filter(name=>!ledger.some(old=>old.name===name));assert.deepEqual(completeLedger.filter(row=>!ledger.some(old=>old.name===row.name)).map(row=>row.name),expectedNewNames)
   assert.equal(completeLedger.filter(row=>row.name===name).length,1)
   assert.deepEqual((await owner.query('SELECT to_jsonb(r) AS value FROM application_operation_receipts r WHERE id=$1',[ids[2]])).rows,seed)
   const{tsImport}=await import('tsx/esm/api'),{runMigrations}=await tsImport('../../../packages/api/scripts/migrate.ts',import.meta.url);assert.equal((await runMigrations({databaseUrl:fixture.adminUrl})).appliedCount,0)
   const fresh=new pg.Client({connectionString:process.env.DATABASE_URL});await fresh.connect()
   try{for(let n=0;n<signatures.length;n++)assert.equal((await fresh.query("SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') AS hash FROM pg_proc WHERE oid=$1::regprocedure",[signatures[n]])).rows[0].hash,expected[n])}finally{await fresh.end()}
   if(process.env.F_E10A_MIGRATION_ARTIFACT)await writeFile(process.env.F_E10A_MIGRATION_ARTIFACT,JSON.stringify({before,transition,after,triggers,ledger,completeLedger,expectedNewNames,seed,guard:await guard(owner),driftRefusals:11,replay:0},null,2)+'\n')
   console.log(JSON.stringify({ledgerBefore:603,ledgerAfter:inventory.length,changedBodies:3,preservedFunctionsAt8133:before.length-3,guardCurrent:true,driftRefusals:11,replay:0}))
  }finally{await owner.end()}
 }finally{await fixture.dispose()}
})


test('[COMP:api/migration-owner-role] Historical function defaults upgrade through the actual PostgreSQL runner', async () => {
  const env = cleanRuntimeEnvironment(process.env)
  const pgBin = (await runCommand('pg_config', ['--bindir'], { env })).trim()
  let calls = 0
  const fixture = await createLocalFixture({ pgBin, env,
    beforeApplyFile: '279_workflow_cross_run_state.sql',
    beforeApply: async ({ adminUrl }) => {
      calls++
      const owner = new pg.Client({ connectionString: adminUrl })
      await owner.connect()
      try {
        // Historical migration 269's provisioning survives the baseline squash.
        // This is confined to a new disposable database, before later revocations.
        await owner.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_user;
          ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO app_user`)
      } finally { await owner.end() }
    },
  })
  const owner = new pg.Client({ connectionString: fixture.adminUrl })
  try {
    await owner.connect()
    assert.equal(calls, 1)
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM _migrations WHERE name IN (
      '81110_legacy_function_execute_privileges.sql','8111_native_memory_statement_visitor.sql',
      '8133_native_history_transcript_read.sql')`)).rows[0].count, 3)
    assert.equal((await owner.query('SELECT application_memory_statement_helpers_current() AS current')).rows[0].current, true)
    assert.deepEqual((await owner.query(`SELECT has_function_privilege('app_user',
      'public.application_memory_statement_state(uuid,uuid,text[],jsonb)','EXECUTE') AS private,
      has_function_privilege('app_user','public.read_admitted_native_scope_snapshot(uuid,text,uuid)','EXECUTE') AS facade`)).rows,
    [{ private: false, facade: true }])
    assert.equal((await owner.query(`SELECT count(*)::int AS count FROM pg_default_acl d,
      LATERAL aclexplode(d.defaclacl) a JOIN pg_roles r ON r.oid=a.grantee
      WHERE d.defaclobjtype='f' AND r.rolname='app_user'`)).rows[0].count, 0)
  } finally { await owner.end(); await fixture.dispose() }
})
