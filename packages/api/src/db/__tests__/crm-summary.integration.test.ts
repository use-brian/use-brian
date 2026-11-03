import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { boundScopeSources, type AccessContext } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createEntity } from '../entities-store.js'
import { getCrmConfig, getCrmSummary } from '../crm-r2.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const owner = getPool()
const cleanups: Array<() => Promise<void>> = []

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), memberId = randomUUID(), assistantId = randomUUID()
  for (const id of [userId, memberId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
  await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional summary fixture',$2,false)", [workspaceId, userId])
  for (const [id, role, clearance] of [[userId, 'owner', 'confidential'], [memberId, 'member', 'internal']]) {
    await owner.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, id, role, clearance])
  }
  await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional summary assistant',$2,$3,'primary','confidential')", [assistantId, userId, workspaceId])
  const access: AccessContext = { workspaceId, userId: memberId, assistantId, assistantKind: 'primary', clearance: 'internal' }
  const config = await getCrmConfig(userId, workspaceId)
  cleanups.push(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId, memberId]])
  })
  const add = (kind: 'person' | 'company' | 'deal', attributes: Record<string, unknown> = {}, extra: Partial<Parameters<typeof createEntity>[0]> = {}) =>
    createEntity({ workspaceId, kind, displayName: 'Fictional summary record', attributes, createdByUserId: userId, source: 'user', ...extra })
  return { workspaceId, userId, memberId, access, config, add }
}

async function trace<T>(run: () => Promise<T>, afterAggregate?: () => Promise<void>) {
  const sql: string[] = [], statements: Array<{ text: string; values: unknown[] }> = [], original = pg.Client.prototype.query
  let fired = false
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: Parameters<typeof original>) {
    const statement = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
    sql.push(statement)
    if (statement.includes('AS \"noAmount\"')) statements.push({ text: statement, values: [...(args[1] as unknown as unknown[])] })
    const result = original.apply(this, args)
    if (!fired && afterAggregate && statement.includes('AS "noAmount"')) {
      fired = true
      return (result as unknown as Promise<unknown>).then(async value => { await afterAggregate(); return value })
    }
    return result
  } as typeof original)
  try { return { value: await run(), sql, statements } } finally { spy.mockRestore() }
}

const empty = { totals: { deals: 0, contacts: 0, companies: 0 }, attention: { overdue: 0, stale: 0, noAmount: 0, orphaned: 0 }, stages: [] }

describe.sequential('[COMP:crm/r2-store] single-capture summary on real PostgreSQL', () => {
  afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
  afterAll(async () => { await getAppPool().end(); await owner.end() })

  it('captures each domain once, retains absence evidence and independently revalidates the result', async () => {
    const f = await fixture()
    const role = (await getAppPool().query(`SELECT current_user,session_user,r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns
      FROM pg_roles r JOIN pg_class c ON c.oid='entities'::regclass WHERE r.rolname=current_user`)).rows[0]
    expect(role).toMatchObject({ current_user: 'app_user', session_user: 'app_user', rolsuper: false, rolbypassrls: false, owns: false })
    const result = await trace(() => getCrmSummary(f.access))
    expect(result.value).toEqual(empty)
    expect(boundScopeSources(result.value).length).toBeGreaterThanOrEqual(3)
    expect(result.sql.filter(sql => sql.includes('SELECT observe_native_application_query_domain('))).toHaveLength(3)
    expect(result.sql.filter(sql => sql.includes('SELECT * FROM read_native_application_query_candidates('))).toHaveLength(3)
    expect(result.sql.filter(sql => sql.includes('SELECT ord,snapshot FROM read_native_session_field_snapshots('))).toHaveLength(2)
    expect(result.sql.filter(sql => sql === 'COMMIT')).toHaveLength(1)
  })

  it('preserves totals, attention, archived exclusion, private and clearance masks, and unmatched pipeline behavior', async () => {
    const f = await fixture(), other = await fixture()
    const company = await f.add('company')
    await f.add('person')
    await f.add('person', { company_id: company.id })
    await f.add('person', { crm_archived_at: '2025-01-01T00:00:00.000Z' })
    await f.add('person', {}, { sensitivity: 'confidential' })
    await f.add('person', {}, { userId: f.userId })
    await f.add('deal', { stage: 'lead', amount: '9007199254740993.000000000000000001' })
    await f.add('deal', { stage: 'lead', close_date: '2020-01-01' })
    await f.add('deal', { stage: 'won' })
    await other.add('deal', { stage: 'lead', amount: 999 })
    const summary = await getCrmSummary(f.access)
    expect(summary).toEqual({ totals: { deals: 3, contacts: 2, companies: 1 }, attention: { overdue: 1, stale: 0, noAmount: 1, orphaned: 1 }, stages: [] })
    expect(await getCrmSummary(f.access, randomUUID())).toEqual({ ...empty, totals: { deals: 0, contacts: 2, companies: 1 }, attention: { ...empty.attention, orphaned: 1 } })
    await expect(getCrmSummary({ ...f.access, workspaceId: other.workspaceId })).rejects.toMatchObject({ code: 'access_unavailable' })
  })

  it('evaluates stage counts, pipeline selection and exact decimal currencies in PostgreSQL', async () => {
    const f = await fixture(), pipeline = f.config.pipelines[0], stage = pipeline.stages.find(stage => stage.category === 'open')!
    // The real canonical read supplies the compiled SQL and admitted configuration.
    // This projection-only case isolates numeric/grouping semantics from native stage-reference admission.
    const captured = await trace(() => getCrmSummary(f.access, pipeline.id))
    expect(captured.statements).toHaveLength(1)
    const { text, values } = captured.statements[0]
    const entitiesParameter = Number(text.match(/NULL::public\.entities,\$(\d+)::jsonb/)![1]) - 1
    const entity = (attributes: Record<string, unknown>) => ({ id: randomUUID(), workspace_id: f.workspaceId,
      kind: 'deal', display_name: 'Fictional projected deal', attributes, user_id: null, assistant_id: null,
      sensitivity: 'internal', compartments: [], project_ids: [], scope_held: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), valid_to: null, retracted_at: null })
    values[entitiesParameter] = JSON.stringify([
      entity({ pipeline_id: pipeline.id, pipeline_stage_id: stage.id, amount: '9007199254740993.000000000000000001', currency_code: 'usd' }),
      entity({ pipeline_id: pipeline.id, pipeline_stage_id: stage.id, amount: '0.000000000000000009', currency_code: 'USD' }),
      entity({ pipeline_id: pipeline.id, pipeline_stage_id: stage.id, amount: '12.5', currency_code: 'eur' }),
      entity({ pipeline_id: randomUUID(), pipeline_stage_id: stage.id, amount: '999', currency_code: 'USD' }),
      entity({ pipeline_id: pipeline.id, pipeline_stage_id: stage.id, amount: '999', crm_archived_at: '2025-01-01T00:00:00.000Z' }),
    ])
    const result = (await getAppPool().query(text, values)).rows[0]
    expect(result.deals).toBe('3')
    expect(result.stages).toHaveLength(2)
    expect(result.stages).toEqual(expect.arrayContaining([
      { stageId: stage.id, stageCount: '3', currency: 'USD', value: '9007199254740993.000000000000000010' },
      { stageId: stage.id, stageCount: '3', currency: 'EUR', value: '12.5' },
    ]))
  })

  it('reacquires independent registered policy data at both final boundaries', async () => {
    const f = await fixture(), person = await f.add('person')
    await owner.query(`CREATE TABLE crm_summary_policy_fixture(workspace_id uuid PRIMARY KEY,restricted boolean NOT NULL);
      REVOKE ALL ON crm_summary_policy_fixture FROM PUBLIC,app_user;
      CREATE FUNCTION crm_summary_policy_rules(t text,restricted boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN restricted AND key='archivedAt' THEN '[["finance"]]'::jsonb ELSE '[]'::jsonb END,
        'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(public.application_native_field_keys(t)) key $$;
      REVOKE ALL ON FUNCTION crm_summary_policy_rules(text,boolean) FROM PUBLIC;
      CREATE FUNCTION crm_summary_policy_record(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       DECLARE source jsonb;restricted boolean;BEGIN
        IF t<>'person' OR NOT EXISTS(SELECT 1 FROM public.entities WHERE workspace_id=w AND id=i::uuid AND kind=t) THEN RETURN NULL;END IF;
        SELECT policy.restricted INTO STRICT restricted FROM public.crm_summary_policy_fixture policy WHERE policy.workspace_id=w;
        source:=public.read_scope_source(w,'entity',i::uuid);
        RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion',CASE WHEN restricted THEN '2' ELSE '1' END,
         'recordVersion',source->>'version','fieldKeys',public.application_native_field_keys(t),'fields',public.crm_summary_policy_rules(t,restricted),'source',source);END $$;
      REVOKE ALL ON FUNCTION crm_summary_policy_record(uuid,jsonb,text,text) FROM PUBLIC;
      CREATE FUNCTION crm_summary_policy_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1','fieldKeys',public.application_native_field_keys(t),
        'fields',public.crm_summary_policy_rules(t,false),'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
      REVOKE ALL ON FUNCTION crm_summary_policy_catalog(uuid,jsonb,text) FROM PUBLIC`)
    try {
      await owner.query('INSERT INTO crm_summary_policy_fixture VALUES($1,false)', [f.workspaceId])
      await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
        VALUES('native','1',ARRAY['finance'],'crm_summary_policy_record(uuid,jsonb,text,text)'::regprocedure,'crm_summary_policy_catalog(uuid,jsonb,text)'::regprocedure)`)
      await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
        VALUES($1,'{"kind":"native","moduleKey":"native"}','person','native')`, [f.workspaceId])
      const before = await getCrmSummary(f.access)
      expect(before.totals.contacts).toBe(1)
      const version = (await owner.query('SELECT scope_version FROM entities WHERE id=$1', [person.id])).rows[0].scope_version
      await owner.query('UPDATE crm_summary_policy_fixture SET restricted=true WHERE workspace_id=$1', [f.workspaceId])
      expect((await owner.query('SELECT scope_version FROM entities WHERE id=$1', [person.id])).rows[0].scope_version).toBe(version)
      await expect(getCrmSummary(f.access)).rejects.toMatchObject({ code: 'access_unavailable' })
      await owner.query('UPDATE crm_summary_policy_fixture SET restricted=false WHERE workspace_id=$1', [f.workspaceId])
      expect(await getCrmSummary(f.access)).toEqual(before)
      for (const boundary of [1, 2]) {
        let reached = 0
        const original = pg.Client.prototype.query
        const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: Parameters<typeof original>) {
          const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
          if (text.includes('SELECT ord,snapshot FROM read_native_session_field_snapshots(') && ++reached === boundary) {
            return owner.query('UPDATE crm_summary_policy_fixture SET restricted=true WHERE workspace_id=$1', [f.workspaceId])
              .then(() => Reflect.apply(original, this, args))
          }
          return Reflect.apply(original, this, args)
        } as typeof original)
        try {
          await expect(getCrmSummary(f.access)).rejects.toMatchObject({ code: 'access_unavailable' })
          expect(reached).toBe(boundary)
        } finally {
          spy.mockRestore()
          await owner.query('UPDATE crm_summary_policy_fixture SET restricted=false WHERE workspace_id=$1', [f.workspaceId])
        }
        expect(await getCrmSummary(f.access)).toEqual(before)
      }
    } finally {
      await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1', [f.workspaceId])
      await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await owner.query('DROP FUNCTION crm_summary_policy_record(uuid,jsonb,text,text),crm_summary_policy_catalog(uuid,jsonb,text),crm_summary_policy_rules(text,boolean); DROP TABLE crm_summary_policy_fixture')
    }
  })

  it('rechecks clock-dependent record policy at each final boundary without a policy write', async () => {
    const f = await fixture(), person = await f.add('person')
    await owner.query(`CREATE TABLE crm_summary_expiry_fixture(workspace_id uuid NOT NULL,record_id uuid NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(workspace_id,record_id));
      REVOKE ALL ON crm_summary_expiry_fixture FROM PUBLIC,app_user;
      CREATE FUNCTION crm_summary_expiry_rules(t text,expired boolean) RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN expired AND key='archivedAt' THEN '[["finance"]]'::jsonb ELSE '[]'::jsonb END,
        'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(public.application_native_field_keys(t)) key $$;
      REVOKE ALL ON FUNCTION crm_summary_expiry_rules(text,boolean) FROM PUBLIC;
      CREATE FUNCTION crm_summary_expiry_record(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       DECLARE source jsonb;expired boolean;BEGIN
        IF t<>'person' OR NOT EXISTS(SELECT 1 FROM public.entities WHERE workspace_id=w AND id=i::uuid AND kind=t) THEN RETURN NULL;END IF;
        SELECT clock_timestamp()>=policy.expires_at INTO STRICT expired FROM public.crm_summary_expiry_fixture policy WHERE policy.workspace_id=w AND policy.record_id=i::uuid;
        source:=public.read_scope_source(w,'entity',i::uuid);
        RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion',CASE WHEN expired THEN '2' ELSE '1' END,
         'recordVersion',source->>'version','fieldKeys',public.application_native_field_keys(t),'fields',public.crm_summary_expiry_rules(t,expired),'source',source);END $$;
      REVOKE ALL ON FUNCTION crm_summary_expiry_record(uuid,jsonb,text,text) FROM PUBLIC;
      CREATE FUNCTION crm_summary_expiry_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1','fieldKeys',public.application_native_field_keys(t),
        'fields',public.crm_summary_expiry_rules(t,false),'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
      REVOKE ALL ON FUNCTION crm_summary_expiry_catalog(uuid,jsonb,text) FROM PUBLIC`)
    try {
      await owner.query("INSERT INTO crm_summary_expiry_fixture VALUES($1,$2,clock_timestamp()+interval '1 hour')", [f.workspaceId, person.id])
      const contract = (await owner.query(`SELECT application_native_record_port_valid('crm_summary_expiry_record(uuid,jsonb,text,text)'::regprocedure) AS valid,
        provolatile FROM pg_proc WHERE oid='crm_summary_expiry_record(uuid,jsonb,text,text)'::regprocedure`)).rows[0]
      expect(contract).toEqual({ valid: true, provolatile: 'v' })
      await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
        VALUES('native','1',ARRAY['finance'],'crm_summary_expiry_record(uuid,jsonb,text,text)'::regprocedure,'crm_summary_expiry_catalog(uuid,jsonb,text)'::regprocedure)`)
      await owner.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key)
        VALUES($1,'{"kind":"native","moduleKey":"native"}','person','native')`, [f.workspaceId])
      const before = await getCrmSummary(f.access)
      expect(before.totals.contacts).toBe(1)
      const stableInputs = async () => (await owner.query(`SELECT e.scope_version,
        (SELECT to_jsonb(p) FROM crm_summary_expiry_fixture p WHERE p.workspace_id=e.workspace_id AND p.record_id=e.id) AS policy,
        (SELECT to_jsonb(c) FROM application_native_field_contracts c WHERE c.module_key='native') AS contract,
        (SELECT prosrc FROM pg_proc WHERE oid='crm_summary_expiry_record(uuid,jsonb,text,text)'::regprocedure) AS body
        FROM entities e WHERE e.id=$1`, [person.id])).rows[0]
      for (const boundary of [1, 2]) {
        await owner.query("UPDATE crm_summary_expiry_fixture SET expires_at=clock_timestamp()+interval '10 seconds' WHERE workspace_id=$1", [f.workspaceId])
        const inputs = await stableInputs()
        let reached = 0
        const original = pg.Client.prototype.query
        const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function(this: pg.Client, ...args: Parameters<typeof original>) {
          const text = typeof args[0] === 'string' ? args[0] : String((args[0] as { text?: string })?.text ?? '')
          if (text.includes('SELECT ord,snapshot FROM read_native_session_field_snapshots(') && ++reached === boundary) {
            // Time advances; no entity, policy, registry or function write occurs
            // between capture and this independent final validation.
            return owner.query(`SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))::double precision+0.05)
              FROM crm_summary_expiry_fixture WHERE workspace_id=$1 AND record_id=$2`, [f.workspaceId, person.id])
              .then(() => Reflect.apply(original, this, args))
          }
          return Reflect.apply(original, this, args)
        } as typeof original)
        try {
          await expect(getCrmSummary(f.access)).rejects.toMatchObject({ code: 'access_unavailable' })
          expect(reached).toBe(boundary)
        } finally { spy.mockRestore() }
        expect(await stableInputs()).toEqual(inputs)
        await owner.query("UPDATE crm_summary_expiry_fixture SET expires_at=clock_timestamp()+interval '1 hour' WHERE workspace_id=$1", [f.workspaceId])
        expect(await getCrmSummary(f.access)).toEqual(before)
      }
    } finally {
      await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1', [f.workspaceId])
      await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await owner.query('DROP FUNCTION crm_summary_expiry_record(uuid,jsonb,text,text),crm_summary_expiry_catalog(uuid,jsonb,text),crm_summary_expiry_rules(text,boolean); DROP TABLE crm_summary_expiry_fixture')
    }
  }, 60_000)

  async function waitForWriter(client: pg.PoolClient) {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    return { pid }
  }

  async function observeBlockedWriter(pid: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (await owner.query('SELECT cardinality(pg_blocking_pids($1)) AS blockers', [pid])).rows[0]
      if (Number(state.blockers) > 0) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Expected the concurrent writer to wait for the current read lease')
  }

  it('serializes concurrent source changes and never reuses a result across requests', async () => {
    const f = await fixture(), record = await f.add('person'), writer = await owner.connect()
    const { pid } = await waitForWriter(writer)
    let mutation: Promise<pg.QueryResult> | undefined
    try {
      const result = await trace(() => getCrmSummary(f.access), async () => {
        mutation = writer.query("UPDATE entities SET attributes=attributes || '{\"crm_archived_at\":\"2025-01-01T00:00:00.000Z\"}'::jsonb WHERE id=$1", [record.id])
        await observeBlockedWriter(pid)
      })
      expect(result.value.totals.contacts).toBe(1)
      await mutation
      expect((await getCrmSummary(f.access)).totals.contacts).toBe(0)
    } finally { await mutation; writer.release() }
  })

  it('serializes concurrent revocation, refuses the next request and cleans the transaction', async () => {
    const f = await fixture(), writer = await owner.connect()
    await f.add('person')
    const { pid } = await waitForWriter(writer)
    let mutation: Promise<pg.QueryResult> | undefined
    try {
      const result = await trace(() => getCrmSummary(f.access), async () => {
        mutation = writer.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.memberId])
        await observeBlockedWriter(pid)
      })
      expect(result.value.totals.contacts).toBe(1)
      await mutation
      await expect(getCrmSummary(f.access)).rejects.toMatchObject({ code: 'access_unavailable' })
    } finally { await mutation; writer.release() }
    const client = await getAppPool().connect()
    try {
      const state = (await client.query("SELECT current_setting('app.current_user_id',true) AS actor,current_setting('app.native_query_data_ceilings',true) AS ceiling")).rows[0]
      expect(state.actor).toBe('00000000-0000-0000-0000-000000000000')
      expect(state.ceiling ?? '').toBe('')
    } finally { client.release() }
  })
})
