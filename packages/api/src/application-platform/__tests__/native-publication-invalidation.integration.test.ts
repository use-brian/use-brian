import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const guards = ['application_native_dependency_batch_helpers_current()', 'application_native_field_reference_helpers_current()']
const migration = await readFile(new URL('../../../migrations/8195_native_publication_invalidation_contract.sql', import.meta.url), 'utf8')
const bridge = migration.replace(/^BEGIN;\n/m, '').replace(/\nCOMMIT;\s*$/, '')
const predecessor = await readFile(new URL('./fixtures/native-invalidation-predecessor.sql', import.meta.url), 'utf8')
const canonicalInvalidatorBody = predecessor.split('AS $fixture$')[1].split('$fixture$;')[0]
const legacyInvalidatorBody = canonicalInvalidatorBody.replace(
  " IF TG_TABLE_NAME='application_field_observations' THEN\n  IF TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM native_crm_projection_facts f WHERE f.workspace_id=NEW.workspace_id AND f.resource_id=NEW.resource_id) THEN RETURN NULL;END IF;\n END IF;",
  " IF TG_TABLE_NAME='application_field_observations' AND TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM native_crm_projection_facts f WHERE f.workspace_id=NEW.workspace_id AND f.resource_id=NEW.resource_id) THEN RETURN NULL;END IF;",
)
if (legacyInvalidatorBody === canonicalInvalidatorBody) throw new Error('Reviewed invalidator predecessor anchor missing')
// This migration intentionally refuses later executable successors. The maintained
// upgrade runner executes its replay/adversarial cases before migration 8196.
const upgradeBoundary = process.env.BRIAN_NATIVE_PUBLICATION_UPGRADE_BOUNDARY === '8195'
  || (await pool.query(`SELECT to_regprocedure('public.publish_native_turn_annotation(uuid,uuid,uuid,uuid,jsonb,text,jsonb,uuid,bigint)') IS NULL AS predecessor`)).rows[0].predecessor
afterAll(async () => { await pool.end() })

/** Recreate only the exact pre-bridge catalog in this rollback-only fixture. */
async function restorePredecessors(client: PoolClient) {
  expect((await client.query("SELECT to_regclass('public.native_crm_current_cohorts') value")).rows[0].value).toBeNull()
  await client.query(predecessor)
  expect((await client.query('SELECT application_native_field_reference_helpers_current() valid')).rows[0].valid).toBe(false)
}

describe.sequential('[COMP:api/native-turn-frame] current publication guard compatibility', () => {
  it('keeps the structural publication and complete turn guards current after every migration', async () => {
    const row = (await pool.query(`SELECT application_native_dependency_batch_helpers_current() dependency,
      application_native_field_reference_helpers_current() reference,native_turn_helpers_current() turn`)).rows[0]
    expect(row).toEqual({ dependency: true, reference: true, turn: true })
  })
})

describe.skipIf(!upgradeBoundary).sequential('[COMP:api/native-turn-frame] independent cohort trigger compatibility (8195 upgrade profile)', () => {
  it('leaves a canonical installation without the retired cohort feature unchanged', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const before = (await client.query('SELECT to_jsonb(p) value FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY oid', [guards])).rows
      await client.query(bridge)
      expect((await client.query('SELECT to_jsonb(p) value FROM pg_proc p WHERE oid=ANY($1::regprocedure[]) ORDER BY oid', [guards])).rows).toEqual(before)
      expect((await client.query("SELECT to_regclass('public.native_crm_current_cohorts') value")).rows[0].value).toBeNull()
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it.each(['table', 'function'] as const)('refuses a partial %s installation', async kind => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      if (kind === 'table') await client.query('CREATE TABLE native_crm_current_cohorts(id uuid)')
      else await client.query("CREATE FUNCTION invalidate_native_crm_cohorts() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL;END'")
      await expect(client.query(bridge)).rejects.toThrow('native_invalidation_partial_state')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it.each(['dependency', 'reference', 'turn', 'publication-contract'] as const)('rejects a forged %s guard even when cohort objects are absent', async kind => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const name = kind === 'dependency' ? guards[0] : kind === 'reference' ? guards[1]
        : kind === 'turn' ? 'native_turn_helpers_current()' : 'native_turn_publication_contract()'
      await client.query(`CREATE OR REPLACE FUNCTION ${name} RETURNS boolean LANGUAGE ${kind === 'dependency' || kind === 'reference' ? 'plpgsql' : 'sql STABLE'}
        SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS '${kind === 'dependency' || kind === 'reference' ? 'BEGIN RETURN true;END' : 'SELECT true'}'`)
      await expect(client.query(bridge)).rejects.toThrow()
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('rejects a publication foreign key redirected to the same table name in another schema', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`CREATE SCHEMA fictional_publication_shadow;
        CREATE TABLE fictional_publication_shadow.native_turn_publication_impossible(id uuid PRIMARY KEY);
        ALTER TABLE native_turn_publication_debt DROP CONSTRAINT application_field_derivation_dependencies;
        ALTER TABLE native_turn_publication_debt ADD CONSTRAINT application_field_derivation_dependencies FOREIGN KEY(frame_id)
          REFERENCES fictional_publication_shadow.native_turn_publication_impossible(id) DEFERRABLE INITIALLY DEFERRED`)
      await expect(client.query(bridge)).rejects.toThrow('native_annotation_publication_constraints_changed')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('rejects changing the completion debt target check from false to true', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DO $fixture$ DECLARE name text; BEGIN
        SELECT conname INTO STRICT name FROM pg_constraint
          WHERE conrelid='public.native_turn_publication_impossible'::regclass AND contype='c';
        EXECUTE format('ALTER TABLE public.native_turn_publication_impossible DROP CONSTRAINT %I',name);
        EXECUTE format('ALTER TABLE public.native_turn_publication_impossible ADD CONSTRAINT %I CHECK(true)',name);
      END $fixture$`)
      await expect(client.query(bridge)).rejects.toThrow('native_annotation_publication_constraints_changed')
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('rejects a forged publication contract even after its callers and mutable manifest are repinned consistently', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Construct the synthetic, fully coordinated forgery under concurrent CI load.
      await client.query("SET LOCAL statement_timeout='60s'")
      await restorePredecessors(client)
      await client.query(`CREATE TEMP TABLE forged_contract_originals ON COMMIT DROP AS
        SELECT oid,prosrc body,quote_literal(prosrc) quoted_body,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') fingerprint,
          encode(sha256(convert_to(prosrc,'UTF8')),'hex') body_hash FROM pg_proc p WHERE pronamespace='public'::regnamespace;
        CREATE OR REPLACE FUNCTION native_turn_publication_contract() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
          SET search_path=pg_catalog,public,pg_temp AS 'SELECT true';
        DO $test$ DECLARE previous record;caller record;body text;changed boolean;round integer;BEGIN
        FOR round IN 1..32 LOOP
          changed:=false;
          FOR previous IN SELECT original.*,p.prosrc current_body,
            encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') current_fingerprint,
            encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') current_hash
            FROM forged_contract_originals original JOIN pg_proc p ON p.oid=original.oid WHERE original.body IS DISTINCT FROM p.prosrc LOOP
            FOR caller IN SELECT p.oid,p.prosrc FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.oid<>previous.oid
              AND(position(previous.quoted_body IN p.prosrc)>0 OR position(previous.fingerprint IN p.prosrc)>0 OR position(previous.body_hash IN p.prosrc)>0) LOOP
              body:=replace(replace(replace(caller.prosrc,previous.quoted_body,quote_literal(previous.current_body)),
                previous.fingerprint,previous.current_fingerprint),previous.body_hash,previous.current_hash);
              IF body IS DISTINCT FROM caller.prosrc THEN EXECUTE replace(pg_get_functiondef(caller.oid),caller.prosrc,body);changed:=true;END IF;
            END LOOP;
            UPDATE forged_contract_originals SET body=previous.current_body,quoted_body=quote_literal(previous.current_body),
              fingerprint=previous.current_fingerprint,body_hash=previous.current_hash WHERE oid=previous.oid;
          END LOOP;
          EXIT WHEN NOT changed;
          IF round=32 THEN RAISE EXCEPTION 'Fictional forgery did not converge';END IF;
        END LOOP;END $test$;
        UPDATE native_turn_contract_helpers h SET fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex')
          FROM pg_proc p WHERE p.oid=to_regprocedure(h.signature)`)
      expect((await client.query('SELECT native_turn_helpers_current() valid')).rows[0].valid).toBe(true)
      await expect(client.query(bridge)).rejects.toThrow()
    } finally { await client.query('ROLLBACK'); client.release() }
  }, 120_000)
  it('rejects an unreviewed trigger even when both legacy guards are forged to include it', async () => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await restorePredecessors(client)
      await client.query(`CREATE TRIGGER unrelated_invalidation AFTER INSERT ON scope_derivation_sources
        FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts();
        DO $test$ DECLARE before_state text;after_state text;dependency pg_proc;reference pg_proc;body text;BEGIN
        SELECT quote_literal(jsonb_agg(to_jsonb(t) ORDER BY t.oid) FILTER(WHERE t.tgname NOT IN('native_crm_cohort_invalidate','unrelated_invalidation'))::text),
          quote_literal(jsonb_agg(to_jsonb(t) ORDER BY t.oid) FILTER(WHERE t.tgname<>'native_crm_cohort_invalidate')::text)
          INTO before_state,after_state FROM pg_trigger t WHERE t.tgrelid IN('scope_derivation_sources'::regclass,'native_field_dependency_batches'::regclass,'native_field_dependency_work'::regclass);
        SELECT * INTO dependency FROM pg_proc WHERE oid='application_native_dependency_batch_helpers_current()'::regprocedure;
        body:=replace(dependency.prosrc,before_state,after_state);
        IF body=dependency.prosrc THEN RAISE EXCEPTION 'Fictional dependency forgery missing';END IF;
        EXECUTE replace(pg_get_functiondef(dependency.oid),dependency.prosrc,body);
        SELECT * INTO reference FROM pg_proc WHERE oid='application_native_field_reference_helpers_current()'::regprocedure;
        body:=replace(reference.prosrc,quote_literal(dependency.prosrc),quote_literal(body));
        body:=replace(body,before_state,after_state);
        EXECUTE replace(pg_get_functiondef(reference.oid),reference.prosrc,body);
        END $test$`)
      await expect(client.query(bridge)).rejects.toThrow()
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it.each(['canonical', 'legacy-body', 'legacy-body-drift', 'body', 'metadata', 'acl', 'owner', 'missing-trigger', 'disabled-trigger', 'extra-trigger',
    'missing-output-trigger', 'disabled-output-trigger', 'changed-output-trigger', 'extra-output-trigger',
    'guard-body', 'guard-acl', 'other-helper', 'paired-helper-and-guard', 'cohort-rule', 'cohort-trigger', 'cohort-column-acl', 'cohort-policy', 'cohort-check',
    'cohort-index', 'cohort-collation', 'cohort-fk-disabled'] as const)(
    'authenticates the exact predecessor with %s state', async change => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await restorePredecessors(client)
        if (change === 'legacy-body' || change === 'legacy-body-drift') {
          // This exact observed predecessor is derived from the archived nested body.
          const body = change === 'legacy-body' ? legacyInvalidatorBody : legacyInvalidatorBody.replace('RETURN NULL;END IF;', 'RETURN NEW;END IF;')
          await client.query(`CREATE OR REPLACE FUNCTION invalidate_native_crm_cohorts() RETURNS trigger
            LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $earlier$${body}$earlier$`)
        }
        if (change === 'body') await client.query(`CREATE OR REPLACE FUNCTION invalidate_native_crm_cohorts() RETURNS trigger
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS 'BEGIN RETURN NULL;END'`)
        if (change === 'metadata') await client.query('ALTER FUNCTION invalidate_native_crm_cohorts() STABLE')
        if (change === 'acl') await client.query('GRANT EXECUTE ON FUNCTION invalidate_native_crm_cohorts() TO app_user')
        if (change === 'owner') await client.query('ALTER FUNCTION invalidate_native_crm_cohorts() OWNER TO app_user')
        if (change === 'missing-trigger') await client.query('DROP TRIGGER native_crm_cohort_invalidate ON scope_derivation_sources')
        if (change === 'disabled-trigger') await client.query('ALTER TABLE scope_derivation_sources DISABLE TRIGGER native_crm_cohort_invalidate')
        if (change === 'extra-trigger') await client.query('CREATE TRIGGER unrelated_invalidation AFTER INSERT ON scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts()')
        if (change === 'missing-output-trigger') await client.query('DROP TRIGGER native_crm_cohort_invalidate ON scope_derivations')
        if (change === 'disabled-output-trigger') await client.query('ALTER TABLE scope_derivations DISABLE TRIGGER native_crm_cohort_invalidate')
        if (change === 'changed-output-trigger') await client.query(`DROP TRIGGER native_crm_cohort_invalidate ON scope_derivations;
          CREATE TRIGGER native_crm_cohort_invalidate AFTER INSERT ON scope_derivations FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts()`)
        if (change === 'extra-output-trigger') await client.query('CREATE TRIGGER unrelated_invalidation AFTER INSERT ON scope_derivations FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts()')
        if (change === 'guard-body') await client.query(`CREATE OR REPLACE FUNCTION application_native_field_reference_helpers_current() RETURNS boolean
          LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS 'BEGIN RETURN true;END'`)
        if (change === 'guard-acl') await client.query('GRANT EXECUTE ON FUNCTION application_native_field_reference_helpers_current() TO app_user')
        if (change === 'other-helper') await client.query('ALTER FUNCTION application_current_field_snapshot(uuid,uuid) COST 101')
        if (change === 'paired-helper-and-guard') {
          const original = (await client.query<{ quoted: string }>("SELECT quote_literal(prosrc) quoted FROM pg_proc WHERE oid='application_current_field_snapshot(uuid,uuid)'::regprocedure")).rows[0].quoted
          await client.query(`CREATE OR REPLACE FUNCTION application_current_field_snapshot(w uuid,i uuid) RETURNS jsonb
            LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS 'BEGIN RETURN NULL;END'`)
          const replacement = (await client.query<{ quoted: string }>("SELECT quote_literal(prosrc) quoted FROM pg_proc WHERE oid='application_current_field_snapshot(uuid,uuid)'::regprocedure")).rows[0].quoted
          const guard = (await client.query<{ body: string; definition: string }>('SELECT prosrc body,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid=$1::regprocedure', [guards[1]])).rows[0]
          expect(guard.body).toContain(original)
          await client.query(guard.definition.replace(guard.body, () => guard.body.replace(original, () => replacement)))
        }
        if (change === 'cohort-rule') await client.query('CREATE RULE unrelated_cohort_update AS ON UPDATE TO native_crm_current_cohorts DO INSTEAD NOTHING')
        if (change === 'cohort-trigger') await client.query('CREATE TRIGGER unrelated_cohort_update AFTER UPDATE ON native_crm_current_cohorts FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts()')
        if (change === 'cohort-column-acl') await client.query('GRANT UPDATE(eligible) ON native_crm_current_cohorts TO app_user')
        if (change === 'cohort-policy') await client.query('CREATE POLICY unrelated_cohort_read ON native_crm_current_cohorts FOR SELECT TO app_user USING(true)')
        if (change === 'cohort-check') await client.query('ALTER TABLE native_crm_current_cohorts ADD CHECK (eligible OR NOT eligible)')
        if (change === 'cohort-index') await client.query('CREATE INDEX unrelated_cohort_index ON native_crm_current_cohorts(eligible)')
        if (change === 'cohort-collation') await client.query('ALTER TABLE native_crm_current_cohorts ALTER COLUMN type_key TYPE text COLLATE "C"')
        if (change === 'cohort-fk-disabled') await client.query('ALTER TABLE native_crm_current_cohorts DISABLE TRIGGER ALL')
        if (change === 'canonical' || change === 'legacy-body') {
          await client.query(bridge)
          expect((await client.query(`SELECT application_native_dependency_batch_helpers_current() dependency,
            application_native_field_reference_helpers_current() reference,native_turn_helpers_current() turn`)).rows[0])
            .toEqual({ dependency: true, reference: true, turn: true })
          expect((await client.query("SELECT prosrc body FROM pg_proc WHERE oid='public.invalidate_native_crm_cohorts()'::regprocedure")).rows[0].body).toBe(canonicalInvalidatorBody)
          if (change === 'legacy-body') {
            await client.query(`CREATE TEMP TABLE fictional_invalidation_record(workspace_id uuid) ON COMMIT DROP;
              CREATE TRIGGER fictional_invalidation AFTER INSERT ON fictional_invalidation_record FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts();
              INSERT INTO fictional_invalidation_record VALUES(gen_random_uuid())`)
          }
        } else await expect(client.query(bridge)).rejects.toThrow(
          ['disabled-trigger', 'extra-trigger', 'disabled-output-trigger', 'extra-output-trigger'].includes(change)
            ? 'native_legacy_evidence_trigger_changed' : 'native_invalidation_',
        )
      } finally { await client.query('ROLLBACK'); client.release() }
    }, 120_000,
  )
  it.each(['body', 'trigger', 'output-trigger', 'extra-output-trigger', 'rule', 'column-acl'] as const)('disables the structural shortcut after later %s drift', async change => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await restorePredecessors(client)
      await client.query(bridge)
      if (change === 'body') await client.query(`CREATE OR REPLACE FUNCTION invalidate_native_crm_cohorts() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS 'BEGIN RETURN NULL;END'`)
      if (change === 'trigger') await client.query('ALTER TABLE scope_derivation_sources DISABLE TRIGGER native_crm_cohort_invalidate')
      if (change === 'output-trigger') await client.query('ALTER TABLE scope_derivations DISABLE TRIGGER native_crm_cohort_invalidate')
      if (change === 'extra-output-trigger') await client.query('CREATE TRIGGER unrelated_invalidation AFTER INSERT ON scope_derivations FOR EACH ROW EXECUTE FUNCTION invalidate_native_crm_cohorts()')
      if (change === 'rule') await client.query('CREATE RULE unrelated_cohort_update AS ON UPDATE TO native_crm_current_cohorts DO INSTEAD NOTHING')
      if (change === 'column-acl') await client.query('GRANT UPDATE(eligible) ON native_crm_current_cohorts TO app_user')
      expect((await client.query(`SELECT application_native_dependency_batch_helpers_current() dependency,
        application_native_field_reference_helpers_current() reference`)).rows[0]).toEqual({ dependency: false, reference: false })
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
