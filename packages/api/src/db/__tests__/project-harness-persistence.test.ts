import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { harnessDefinitionSchema, harnessTextUnits } from '../../project-harness/contracts.js'
import { readHarnessProjectSnapshot } from '../project-harness-store.js'

// Exercise the real snapshot helper against this file's PGlite restricted role.
// Only the pool transport is adapted; SQL predicates and RLS are unchanged.
vi.mock('../client.js', () => ({
  getAppPool: () => ({ connect: async () => snapshotClient }),
  applyRLSGucs: async (client: typeof snapshotClient, actor: string) => {
    await client.query('SET LOCAL ROLE app_user')
    await client.query("SELECT set_config('app.current_user_id',$1,true)", [actor])
  },
  rollbackAndRelease: async (client: typeof snapshotClient) => { await client.query('ROLLBACK') },
}))
const snapshotClient = { query: (sql: string, params?: unknown[]) => db.query(sql, params) }

// Actual 8269 migration, real restricted app_user. Minimal FK prerequisites;
// canonical shared-Project/department predicate SQL is loaded, not stubbed true.
let db: PGlite
const owner = randomUUID(), participant = randomUUID(), oversight = randomUUID(), outsider = randomUUID()
const expired = randomUUID(), assistant = randomUUID(), otherAssistant = randomUUID()
const w = randomUUID(), p = randomUUID(), legacy = randomUUID(), second = randomUUID()
const body = { schemaVersion: 1, rules: [], codeChecks: [], acceptanceScenarios: [] }
const migration = (name: string) => readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8')
const query = async <T = Record<string, unknown>>(actor: string, sql: string, params: unknown[] = [], gucs: Record<string, string> = {}) =>
  db.transaction(async tx => {
    await tx.exec('SET LOCAL ROLE app_user')
    await tx.query("SELECT set_config('app.current_user_id',$1,true)", [actor])
    for (const [key, value] of Object.entries(gucs)) await tx.query('SELECT set_config($1,$2,true)', [key, value])
    return tx.query<T>(sql, params)
  })
const create = async (actor = owner, product: string | null = null) =>
  (await query<{ result: { id: string; revision: number } }>(actor,
    'SELECT project_harness_write_node($1,$2,$3,NULL,$4,0) result', [w, p, product, { name: 'Surface' }])).rows[0].result
const read = async (actor = owner, product: string | null = null, component: string | null = null, mode = 'lineage', project = p, gucs = {}) =>
  (await query<{ result: Array<{ revision: number; product_id: string | null; component_id: string | null }> }>(actor,
    'SELECT project_harness_read($1,$2,$3,$4,$5) result', [w, project, product, component, mode], gucs)).rows[0].result
const put = (product: string | null, component: string | null, revision: number | null, definition: unknown = body, actor = owner) =>
  query(actor, 'SELECT project_harness_put($1,$2,$3,$4,$5,$6)', [w, p, product, component, revision, definition])

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE harness_migration_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE,CREATE ON SCHEMA public TO harness_migration_owner;
    SET ROLE harness_migration_owner;
    -- Simulate production's broad defaults; migration must explicitly revoke DML.
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO app_user;
    CREATE TABLE workspaces(id uuid PRIMARY KEY, department_read_v2 boolean DEFAULT true, project_shared_spaces boolean DEFAULT true);
    CREATE TABLE workspace_members(workspace_id uuid, user_id uuid, role text, clearance text DEFAULT 'internal');
    CREATE TABLE assistants(id uuid PRIMARY KEY, workspace_id uuid, clearance text DEFAULT 'internal');
    CREATE TABLE workspace_projects(id uuid PRIMARY KEY,workspace_id uuid,status text DEFAULT 'active', UNIQUE(workspace_id,id));
    CREATE TABLE project_shared_scopes(project_id uuid PRIMARY KEY,workspace_id uuid,status text DEFAULT 'active');
    CREATE TABLE project_shared_members(project_id uuid,user_id uuid,assistant_id uuid,expires_at timestamptz);
    CREATE TABLE project_shared_owners(workspace_id uuid,project_id uuid,user_id uuid);
    CREATE TABLE department_edges(workspace_id uuid,department_id uuid,user_id uuid,assistant_id uuid,clearance text,expires_at timestamptz);
    CREATE FUNCTION sensitivity_rank(s text) RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT CASE s WHEN 'public' THEN 1 WHEN 'internal' THEN 2 WHEN 'confidential' THEN 3 END $$;
    CREATE FUNCTION effective_member_team_compartments(a uuid,w uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT NULL::text[] $$;
    CREATE FUNCTION effective_member_read_compartments(a uuid,w uuid) RETURNS text[] LANGUAGE sql AS $$ SELECT NULL::text[] $$;
    CREATE FUNCTION department_read_grants() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;
  `)
  const source = migration('749_project_shared_spaces.sql')
  await db.exec(source.slice(source.indexOf('CREATE FUNCTION public.project_member_live'), source.indexOf('-- ── Label integrity')))
  await db.exec(`CREATE OR REPLACE FUNCTION department_read_grants() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT department_read_grants_for(nullif(current_setting('app.current_user_id',true),'')::uuid) $$;`)
  await db.exec(migration('8269_project_harnesses.sql'))
  await db.query('INSERT INTO workspaces(id) VALUES($1)', [w])
  for (const [id, role] of [[owner, 'member'], [participant, 'member'], [oversight, 'owner'], [outsider, 'member'], [expired, 'member']]) {
    await db.query('INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,$3)', [w, id, role])
  }
  for (const id of [p, legacy, second]) await db.query('INSERT INTO workspace_projects(id,workspace_id) VALUES($1,$2)', [id, w])
  for (const id of [p, second]) await db.query('INSERT INTO project_shared_scopes(project_id,workspace_id) VALUES($1,$2)', [id, w])
  for (const id of [owner, participant]) await db.query('INSERT INTO project_shared_members(project_id,user_id) VALUES($1,$2)', [p, id])
  await db.query("INSERT INTO project_shared_members(project_id,user_id,expires_at) VALUES($1,$2,now()-interval '1 day')", [p, expired])
  await db.query('INSERT INTO project_shared_owners VALUES($1,$2,$3)', [w, p, owner])
  for (const id of [assistant, otherAssistant]) await db.query('INSERT INTO assistants(id,workspace_id) VALUES($1,$2)', [id, w])
  await db.query('INSERT INTO project_shared_members(project_id,assistant_id) VALUES($1,$2)', [p, assistant])
}, 30_000)
afterAll(async () => { await db?.close() })

describe('[COMP:api/project-harness] restricted-role migration persistence', () => {
  it('reads participants and workspace-owner oversight, but only shared owners govern', async () => {
    const product = await create()
    expect(await read(participant, product.id)).toEqual([])
    expect(await read(oversight, product.id)).toEqual([])
    for (const actor of [participant, oversight]) await expect(create(actor)).rejects.toThrow('harness_owner_required')
    for (const actor of [outsider, expired, randomUUID()]) {
      await expect(read(actor)).rejects.toThrow('harness_not_found')
      expect((await query(actor, 'SELECT * FROM project_harness_products')).rows).toEqual([])
    }
  })
  it('requires acting assistant admission and canonical credential binding / tier', async () => {
    expect(await read(owner, null, null, 'lineage', p, { 'app.v2_assistant_id': assistant })).toEqual([])
    for (const gucs of [{ 'app.v2_assistant_id': otherAssistant }, { 'app.v2_binding': '[]' }, { 'app.v2_cap': 'public' }] as Record<string, string>[]) {
      await expect(read(owner, null, null, 'lineage', p, gucs)).rejects.toThrow('harness_not_found')
      await expect(query(owner, 'SELECT project_harness_write_node($1,$2,NULL,NULL,$3,0)', [w,p,{name:'blocked'}], gucs)).rejects.toThrow('harness_not_found')
    }
    expect(await read(owner, null, null, 'lineage', p, { 'app.v2_binding': JSON.stringify([p]) })).toEqual([])
  })
  it('distinguishes visible legacy 409 from hidden/missing 404', async () => {
    await expect(read(owner, null, null, 'lineage', legacy)).rejects.toThrow('harness_requires_shared_project')
    await expect(read(randomUUID(), null, null, 'lineage', legacy)).rejects.toThrow('harness_not_found')
    await expect(read(owner, null, null, 'lineage', second)).rejects.toThrow('harness_not_found')
    await expect(read(owner, null, null, 'lineage', randomUUID())).rejects.toThrow('harness_not_found')
  })
  it('validates empty-definition target ancestry and excludes siblings from lineage', async () => {
    const product = await create(), sibling = await create(), child = await create(owner, product.id)
    await expect(read(owner, randomUUID())).rejects.toThrow('harness_not_found')
    await expect(read(owner, sibling.id, child.id)).rejects.toThrow('harness_not_found')
    await expect(read(owner, null, child.id)).rejects.toThrow('harness_not_found')
    await put(null, null, 0)
    await put(product.id, null, 0)
    await put(product.id, child.id, 0)
    await put(sibling.id, null, 0)
    const lineage = await read(owner, product.id, child.id)
    expect(lineage.map(r => [r.product_id, r.component_id])).toEqual([[null,null],[product.id,null],[product.id,child.id]])
    expect((await read(owner, sibling.id)).length).toBe(2)
  })
  it('requires optimistic revisions, keeps immutable snapshots and caps newest history at 100', async () => {
    const product = await create()
    await expect(put(product.id, null, null)).rejects.toThrow('harness_revision_stale')
    await put(product.id, null, 0)
    await expect(put(product.id, null, 0)).rejects.toThrow('harness_revision_stale')
    for (let i = 1; i <= 101; i++) await put(product.id, null, i)
    const history = await read(owner, product.id, null, 'history')
    expect(history).toHaveLength(100)
    expect(history[0].revision).toBe(102)
    expect(history[99].revision).toBe(3)
    expect((await read(owner, product.id, null, 'definition'))[0].revision).toBe(102)
    expect((await db.query('SELECT * FROM project_harness_revisions WHERE product_id=$1', [product.id])).rows).toHaveLength(102)
    await expect(db.query('UPDATE project_harness_revisions SET definition=$1 WHERE product_id=$2', [body,product.id])).rejects.toThrow('harness_history_immutable')
    await expect(db.query('DELETE FROM project_harness_revisions WHERE product_id=$1', [product.id])).rejects.toThrow('harness_history_immutable')
  })
  it('denies direct app DML and internal helper invocation, even with forged GUCs', async () => {
    const product = await create()
    for (const sql of [
      'UPDATE project_harness_products SET revision=revision+1',
      'DELETE FROM project_harness_revisions',
      'UPDATE project_harness_revisions SET revision=revision+1',
      `INSERT INTO project_harness_products(workspace_id,project_id,name) VALUES('${w}','${p}','bypass')`,
      `SELECT project_harness_require('${w}','${p}',NULL,NULL,false)`,
    ]) await expect(query(owner, sql, [], { 'app.harness_write': 'true' })).rejects.toThrow('permission denied')
    await expect(db.query('UPDATE project_harness_products SET project_id=$1 WHERE id=$2', [second, product.id])).rejects.toThrow('harness_parent_immutable')
    const child = await create(owner, product.id), other = await create()
    await expect(db.query('UPDATE project_harness_components SET product_id=$1 WHERE id=$2', [other.id,child.id])).rejects.toThrow('harness_parent_immutable')
    await expect(db.query('INSERT INTO project_harness_components(workspace_id,project_id,product_id,name) VALUES($1,$2,$3,$4)', [w, second, product.id,'bad'])).rejects.toThrow('foreign key')
  })
  it('enforces archive ancestry, supports explicit restoration and refuses stale node writes', async () => {
    const product = await create(), child = await create(owner, product.id)
    const update = (patch: unknown, revision: number | null) => query(owner,
      'SELECT project_harness_write_node($1,$2,NULL,$3,$4,$5)', [w,p,product.id,patch,revision])
    await expect(update({name:'new'},null)).rejects.toThrow('harness_revision_stale')
    await update({status:'archived'},1)
    await expect(update({name:'new'},1)).rejects.toThrow('harness_revision_stale')
    await expect(update({name:'new'},2)).rejects.toThrow('harness_archived')
    await expect(create(owner, product.id)).rejects.toThrow('harness_archived')
    await expect(put(product.id,child.id,0)).rejects.toThrow('harness_archived')
    expect(await read(owner,product.id,child.id)).toHaveLength(1)
    await update({status:'active'},2)
    await put(product.id,child.id,0)
    await db.query("UPDATE workspace_projects SET status='archived' WHERE id=$1", [p])
    await expect(create()).rejects.toThrow('harness_archived')
    expect(await read(owner,product.id,child.id)).toHaveLength(2)
    await db.query("UPDATE workspace_projects SET status='active' WHERE id=$1", [p])
  })
  it('fails closed after quarantine, capability disablement and workspace departure', async () => {
    await db.query("UPDATE project_shared_scopes SET status='quarantined' WHERE project_id=$1", [p])
    await expect(read()).rejects.toThrow('harness_not_found')
    await expect(create()).rejects.toThrow('harness_not_found')
    await db.query("UPDATE project_shared_scopes SET status='active' WHERE project_id=$1", [p])
    for (const flag of ['project_shared_spaces','department_read_v2']) {
      await db.exec(`UPDATE workspaces SET ${flag}=false`)
      await expect(read()).rejects.toThrow('harness_not_found')
      await db.exec(`UPDATE workspaces SET ${flag}=true`)
    }
    await db.query('DELETE FROM workspace_members WHERE user_id=$1', [participant])
    await expect(read(participant)).rejects.toThrow('harness_not_found')
  })
  it('supports read-only repeatable-read actor transactions and complete definitions', async () => {
    const product = await create()
    const definition = { ...body,
      rules: [{key:'stable',kind:'invariant',value:'Preserve ancestry',override:false}],
      codeChecks: [{key:'unit',kind:'unit',instructions:'Run tests',command:'pnpm test'}],
      acceptanceScenarios: [{key:'journey',title:'Create product',preconditions:['Shared owner'],steps:['Create product'],
        criteria:[{key:'stored',observation:'Product exists',evidence:'Read response'}]}],
    }
    await put(product.id,null,0,definition)
    await db.transaction(async tx => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL ROLE app_user')
      await tx.query("SELECT set_config('app.current_user_id',$1,true)", [owner])
      const result = await tx.query<{result: Array<{definition: unknown}>}>(
        "SELECT project_harness_read($1,$2,$3,NULL,'definition') result", [w,p,product.id])
      expect(result.rows[0].result[0].definition).toEqual(definition)
    })
    // Simulate post-admission revocation; the next command must not trust a
    // cached store/route decision, even for a Project owner.
    await db.query("UPDATE project_shared_members SET expires_at=now()-interval '1 second' WHERE user_id=$1", [owner])
    await expect(put(product.id,null,1,definition)).rejects.toThrow('harness_not_found')
    await db.query('UPDATE project_shared_members SET expires_at=NULL WHERE user_id=$1', [owner])
    await db.query("UPDATE project_shared_members SET expires_at=now()-interval '1 second' WHERE assistant_id=$1", [assistant])
    await expect(read(owner,null,null,'lineage',p,{'app.v2_assistant_id':assistant})).rejects.toThrow('harness_not_found')
    await db.query('UPDATE project_shared_members SET expires_at=NULL WHERE assistant_id=$1', [assistant])
  })
  it('round-trips normalized whitespace and UTF-16 limits through SQL and application schemas', async () => {
    const product = await create()
    const make = (value: string) => ({ ...body, rules: [{ key: 'example', kind: 'default', value }] })
    for (const value of ['\t', '\n', '\ufeff', ' spaced ', '😀'.repeat(2001)]) {
      await expect(put(product.id, null, 0, make(value))).rejects.toThrow('harness_invalid_input')
    }
    const normalized = harnessDefinitionSchema.parse(make('\t😀\ufeff'))
    await put(product.id, null, 0, normalized)
    const wide = harnessDefinitionSchema.parse(make('😀'.repeat(2000)))
    await put(product.id, null, 1, wide)
    const rows = await query<{ result: Array<{ definition: unknown }> }>(owner,
      "SELECT project_harness_read($1,$2,$3,NULL,'history') result", [w, p, product.id])
    expect(rows.rows[0].result.map(row => harnessDefinitionSchema.parse(row.definition))).toEqual([wide, normalized])
  })
  it('uses the same total text budget independent of JSON serializer spacing', async () => {
    const product = await create()
    const candidate = { ...body, rules: Array.from({ length: 32 }, (_, i) => ({ key: `rule-${i}`, kind: 'default', value: 'x'.repeat(4000), override: false })) }
    candidate.rules[0].value = candidate.rules[0].value.slice(harnessTextUnits(candidate) - 128000)
    expect(harnessTextUnits(candidate)).toBe(128000)
    const accepted = harnessDefinitionSchema.parse(candidate)
    await put(product.id, null, 0, accepted)
    const stored = await query<{ definition: unknown }>(owner,
      'SELECT definition FROM project_harness_revisions WHERE product_id=$1', [product.id])
    expect(harnessDefinitionSchema.parse(stored.rows[0].definition)).toEqual(accepted)
    candidate.rules[0].value += 'x'
    expect(harnessDefinitionSchema.safeParse(candidate).success).toBe(false)
    await expect(put(product.id, null, 1, candidate)).rejects.toThrow('harness_invalid_input')
  })
  it('validates direct SQL payloads without exposing payload text', async () => {
    const product = await create()
    for (const invalid of [null, {}, {...body, extra:'secret'}, {...body,rules:[{key:'bad',kind:'invariant',value:'secret',extra:1}]},
      {...body,rules:[{key:'dup',kind:'local',value:'secret'},{key:'dup',kind:'local',value:'secret'}]},
      {...body,acceptanceScenarios:[{key:'test',title:'secret',preconditions:[],steps:['secret'],criteria:[]}]}]) {
      await expect(put(product.id,null,0,invalid)).rejects.toThrow(/^harness_invalid_input$/)
    }
    await expect(query(owner,'SELECT project_harness_write_node($1,$2,NULL,NULL,$3,0)',[w,p,{name:'secret',projectId:second}])).rejects.toThrow(/^harness_invalid_input$/)
  })
})

describe('source ownership/dependency SQL parity and consistent Project snapshot', () => {
  it('round trips optional metadata and same-Project cross-product dependency targets', async () => {
    const product=await create(), target=await create(), child=await create(owner,target.id)
    const definition=harnessDefinitionSchema.parse({...body,
      sourceMappings:[{repository:' repo-id ',pathPrefix:'src/日本語/file.ts'}],
      dependencies:[{scope:{kind:'component',productId:target.id,componentId:child.id},contract:' Boundary contract '},{scope:{kind:'project'},contract:'Project conventions'}],
    })
    await put(product.id,null,0,definition)
    const rows=await query<{result:Array<{definition:unknown}>}>(owner,'SELECT project_harness_read($1,$2,$3,NULL,$4) result',[w,p,product.id,'definition'])
    expect(rows.rows[0].result[0].definition).toEqual(definition)
    const snapshot=await readHarnessProjectSnapshot(owner,w,p)
    expect(snapshot.tree.products.some(x=>x.id===product.id)).toBe(true)
    expect(snapshot.tree.components.find(x=>x.id===child.id)?.productId).toBe(target.id)
    expect(snapshot.revisions.find(x=>x.scope.kind==='product'&&x.scope.productId===product.id)?.definition).toEqual(definition)
  })
  it('SQL and TypeScript reject noncanonical paths, malformed scopes and optional metadata overflow', async () => {
    const product=await create()
    const invalidPaths=['../src','src/../file','/src','C:/src','src\\file','src//file','src/./file','src/','src/*','src/?','src/[x]','src/{a,b}','src/%2e','src\nfile','src\u007ffile','x'.repeat(501),'😀'.repeat(251)]
    const invalidDefinitions=[
      ...invalidPaths.map(pathPrefix=>({...body,sourceMappings:[{repository:'repo',pathPrefix}]})),
      {...body,sourceMappings:null},{...body,dependencies:null},
      {...body,sourceMappings:[{repository:'x'.repeat(201),pathPrefix:'src'}]},
      {...body,sourceMappings:Array(101).fill({repository:'repo',pathPrefix:'src'})},
      {...body,dependencies:Array(101).fill({scope:{kind:'project'},contract:'contract'})},
      {...body,dependencies:[{scope:{kind:'project',projectId:p},contract:'forged pointer'}]},
      {...body,dependencies:[{scope:{kind:'component',componentId:randomUUID()},contract:'missing parent'}]},
      {...body,dependencies:[{scope:{kind:'product',productId:'invalid'},contract:'bad identity'}]},
      {...body,dependencies:[{scope:{kind:'project'},contract:'x'.repeat(4001)}]},
      {...body,dependencies:Array(40).fill({scope:{kind:'project'},contract:'x'.repeat(4000)})},
    ]
    for(const definition of invalidDefinitions) {
      expect(harnessDefinitionSchema.safeParse(definition).success).toBe(false)
      await expect(put(product.id,null,0,definition)).rejects.toThrow('harness_invalid_input')
    }
    const definition=harnessDefinitionSchema.parse({...body,sourceMappings:[{repository:'😀'.repeat(100),pathPrefix:'😀'.repeat(250)}]})
    await put(product.id,null,0,definition)
  })
  it('put rejects foreign, missing, wrong-parent and archived dependency targets; references remain historical after archive', async () => {
    const product=await create(), target=await create(), sibling=await create(), child=await create(owner,target.id)
    const foreign=randomUUID()
    await db.query('INSERT INTO project_harness_products(id,workspace_id,project_id,name) VALUES($1,$2,$3,$4)',[foreign,w,second,'Foreign Project'])
    const definition=(scope:unknown)=>({...body,dependencies:[{scope,contract:'Explicit dependency'}]})
    for(const scope of [{kind:'product',productId:randomUUID()},{kind:'product',productId:foreign},{kind:'component',productId:sibling.id,componentId:child.id}]) {
      await expect(put(product.id,null,0,definition(scope))).rejects.toThrow('harness_not_found')
    }
    const valid=definition({kind:'component',productId:target.id,componentId:child.id})
    await put(product.id,null,0,valid)
    await query(owner,'SELECT project_harness_write_node($1,$2,NULL,$3,$4,1)',[w,p,target.id,{status:'archived'}])
    await expect(put(product.id,null,1,valid)).rejects.toThrow('harness_archived')
    const snapshot=await readHarnessProjectSnapshot(owner,w,p)
    expect(snapshot.revisions.find(r=>r.scope.kind==='product'&&r.scope.productId===product.id)?.definition).toEqual(valid)
    expect(snapshot.tree.products.find(x=>x.id===target.id)?.status).toBe('archived')
    expect(snapshot.tree.products.some(x=>x.id===foreign)).toBe(false)
    expect((await read(owner,product.id,null,'history'))).toHaveLength(1)
  })
  it('snapshot includes one current head per scope without the history cap and rejects unauthorized/invalid project reads', async () => {
    const product=await create(), child=await create(owner,product.id)
    await put(product.id,null,0)
    await put(product.id,null,1,{...body,sourceMappings:[{repository:'repo',pathPrefix:'new'}]})
    await put(product.id,child.id,0)
    const snapshot=await readHarnessProjectSnapshot(owner,w,p)
    expect(snapshot.revisions.filter(r=>r.scope.kind==='product'&&r.scope.productId===product.id)).toHaveLength(1)
    expect(snapshot.revisions.find(r=>r.scope.kind==='product'&&r.scope.productId===product.id)?.revision).toBe(2)
    expect(snapshot.revisions.find(r=>r.scope.kind==='component'&&r.scope.componentId===child.id)?.revision).toBe(1)
    expect(snapshot.revisions.every(r=>r.workspaceId===w&&r.projectId===p&&typeof r.createdAt==='string')).toBe(true)
    await expect(readHarnessProjectSnapshot(outsider,w,p)).rejects.toMatchObject({code:'harness_not_found'})
    await expect(readHarnessProjectSnapshot(owner,w,legacy)).rejects.toMatchObject({code:'harness_requires_shared_project'})
  })
})
