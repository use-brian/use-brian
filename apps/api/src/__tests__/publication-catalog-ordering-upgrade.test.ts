/** [COMP:api/migration-execution-sql] Historical restores through all copied installers, ordinary owner. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { vector } from '@electric-sql/pglite-pgvector'
import { openOrdinaryOwnerPglite } from './ordinary-owner-pglite.js'
import { migratePglite } from '../migrate-pglite.js'
import { toPgliteMigrationSql } from '../../../../packages/api/src/migrations/pglite-sql.js'
import { memoryLineagePublicationExecutionSql } from '../../../../packages/api/src/migrations/memory-lineage-publication-execution.js'
import { publicationCatalogOrderingExecutionSql } from '../../../../packages/api/src/migrations/publication-catalog-ordering-execution.js'
import { withoutOuterTransaction } from '../../../../packages/api/src/migrations/transaction-sql.js'

const directory = fileURLToPath(new URL('../../../../packages/api/migrations/', import.meta.url))
const publication = '8272_durable_conversation_publications.sql'
const upstream = '8268_native_memory_query_write_lineage.sql'

test('[COMP:api/migration-execution-sql] upgrades historical Memory with reordered relations, FK triggers and functions while preserving strict authentication', async () => {
  let db = await openOrdinaryOwnerPglite()
  try {
    await migratePglite(db, directory, { through: '562_decision_fk_cleanup.sql' })
    const foundation = '5630_department_scope_evidence.sql'
    const foundationSql = await readFile(`${directory}/${foundation}`, 'utf8')
    const derivations = foundationSql.match(/^CREATE TABLE scope_derivations \([\s\S]*?^\);/m)?.[0]
    const sources = foundationSql.match(/^CREATE TABLE scope_derivation_sources \([\s\S]*?^\);/m)?.[0]
    assert.ok(derivations && sources)
    const foreignKey = 'FOREIGN KEY (workspace_id,derivation_id) REFERENCES scope_derivations(workspace_id,id) ON DELETE CASCADE'
    assert.equal(sources.split(foreignKey).length, 2)
    // Like pg_restore, declare independent tables first and add the cross-table
    // FK afterwards. Identical final declarations, but reverse relation OIDs.
    const reorderedFoundation = foundationSql.replace(`${derivations}\n${sources}`,
      `${sources.replace(`,\n  ${foreignKey}`, '')}\n${derivations}\nALTER TABLE scope_derivation_sources ADD CONSTRAINT scope_derivation_sources_workspace_id_derivation_id_fkey ${foreignKey};`)
    assert.notEqual(reorderedFoundation, foundationSql)
    await db.transaction(async tx => {
      await tx.exec(withoutOuterTransaction(reorderedFoundation, foundation))
      await tx.query('INSERT INTO public._migrations(name) VALUES($1)', [foundation])
    })
    assert.deepEqual((await db.query(`SELECT 'public.scope_derivation_sources'::regclass::oid
      <'public.scope_derivations'::regclass::oid reordered`)).rows, [{ reordered: true }])
    // A valid restore/recreated FK can assign newer OIDs than the reference
    // trigger. Do this before any native comparator captures these objects.
    const foreignKeys = (await db.query<{ name: string; definition: string }>(`SELECT conname name,pg_get_constraintdef(oid) definition
      FROM pg_constraint WHERE conrelid='public.scope_derivation_sources'::regclass AND contype='f' ORDER BY oid DESC`)).rows
    for (const key of foreignKeys) {
      await db.exec(`ALTER TABLE public.scope_derivation_sources DROP CONSTRAINT ${key.name};
        ALTER TABLE public.scope_derivation_sources ADD CONSTRAINT ${key.name} ${key.definition};`)
    }
    assert.equal((await db.query<{ name: string }>(`SELECT tgname name FROM pg_trigger
      WHERE tgrelid='public.scope_derivation_sources'::regclass ORDER BY oid LIMIT 1`)).rows[0].name, 'scope_derivation_sources_reference')
    await migratePglite(db, directory, { through: '8159_native_field_reference_checks.sql' })
    const worklists = '8160_native_file_proof_worklists.sql'
    const declarations = await readFile(`${directory}/${worklists}`, 'utf8')
    const definitions = ['knowledge_versions', 'persistent_context'].map(kind =>
      declarations.match(new RegExp(String.raw`CREATE FUNCTION public\.native_worklist_current_${kind}\([\s\S]*?END \$function\$;`))?.[0])
    assert.ok(definitions[0] && definitions[1])
    // Reorder two independent PL/pgSQL declarations in this disposable fixture,
    // like a restore can, before any comparator enrolls their OIDs. Bodies,
    // metadata, source migration files and all installed guards stay intact.
    const reordered = declarations.replace(definitions[0], '__FIXTURE_FIRST_DECLARATION__')
      .replace(definitions[1], definitions[0]).replace('__FIXTURE_FIRST_DECLARATION__', definitions[1])
    await db.transaction(async tx => {
      await tx.exec(withoutOuterTransaction(reordered, worklists))
      await tx.query('INSERT INTO public._migrations(name) VALUES($1)', [worklists])
    })
    assert.deepEqual((await db.query(`SELECT
      'native_worklist_current_persistent_context(uuid,text,uuid,jsonb)'::regprocedure::oid
      <'native_worklist_current_knowledge_versions(uuid,text,uuid,jsonb)'::regprocedure::oid reordered`)).rows, [{ reordered: true }])
    await migratePglite(db, directory, { through: '8267_retained_native_graph.sql' })
    const canonicalImage = await db.dumpDataDir('none')
    const upstreamSql = await readFile(new URL(`../../../../packages/api/scripts/conversation-store/historical/${upstream}`, import.meta.url), 'utf8')
    await db.transaction(async tx => {
      await tx.exec(withoutOuterTransaction(upstreamSql, upstream))
      await tx.query('INSERT INTO public._migrations(name) VALUES($1)', [upstream])
    })
    await migratePglite(db, directory, { through: '8271_refresh_recovery_capture.sql' })
    const source = await readFile(`${directory}/${publication}`, 'utf8')
    const old = withoutOuterTransaction(memoryLineagePublicationExecutionSql(publicationCatalogOrderingExecutionSql(source)), publication)
    await assert.rejects(db.transaction(tx => tx.exec(old)), /publication_upstream_memory_body_changed: application_native_worklist_helpers_current/)
    const guard = (await db.query<{ body: string; definition: string }>(`SELECT prosrc body,pg_get_functiondef(oid) definition
      FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure`)).rows[0]
    const state = async () => ({
      functions: (await db.query(`SELECT to_jsonb(p) value FROM pg_proc p WHERE pronamespace='public'::regnamespace ORDER BY oid`)).rows,
      native: (await db.query('SELECT to_jsonb(h) value FROM native_turn_contract_helpers h ORDER BY signature')).rows,
      retained: (await db.query('SELECT to_jsonb(h) value FROM native_retained_contract_helpers h ORDER BY signature')).rows,
      ledger: (await db.query('SELECT * FROM _migrations ORDER BY name')).rows,
    })
    const before = await state()
    // Drift must still fail and roll back without adopting an installed body.
    await db.exec('BEGIN')
    await db.exec(guard.definition.replace(guard.body, () => guard.body + '\n-- unreviewed body'))
    const drifted = await state()
    await db.exec('SAVEPOINT publication_attempt')
    await assert.rejects(db.exec(toPgliteMigrationSql(source, publication)), /publication_upstream_memory_body_changed: native_turn_helpers_current/)
    await db.exec('ROLLBACK TO SAVEPOINT publication_attempt')
    assert.deepEqual(await state(), drifted)
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [publication])).rows, [])
    await db.exec('ROLLBACK')
    assert.deepEqual(await state(), before)
    await migratePglite(db, directory, { through: publication })
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [publication])).rows, [{ name: publication }])
    assert.deepEqual((await db.query(`SELECT native_turn_helpers_current() native,
      native_turn_publication_contract() publication,native_retained_helpers_current() retained,
      application_native_worklist_helpers_current() worklist`)).rows,
      [{ native: true, publication: true, retained: true, worklist: true }])
    const registry = JSON.parse(source.match(/ FOR expected IN SELECT value FROM jsonb_array_elements\('((?:''|[^'])*)'::jsonb/)![1].replaceAll("''", "'"))
    const worklist = registry.find((item: { signature: string }) => item.signature === 'application_native_worklist_helpers_current()')
    assert.deepEqual((await db.query(`SELECT p.prosrc=pg_temp.publication_body($1::jsonb) authored_order
      FROM pg_proc p WHERE oid='application_native_worklist_helpers_current()'::regprocedure`, [JSON.stringify(worklist.bodyParts)])).rows,
      [{ authored_order: true }])
    assert.deepEqual((await db.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows,
      [{ rolsuper: false, rolbypassrls: false }])
    assert.equal((await db.query<{ body: string }>(`SELECT prosrc body FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure`)).rows[0].body.includes('-- unreviewed body'), false)
    await migratePglite(db, directory, { through: '8275_joint_native_preparation_acquisition.sql' })
    const successor = '8276_registry_guard_successor.sql'
    const successorSql = await readFile(`${directory}/${successor}`, 'utf8')
    await assert.rejects(db.transaction(tx => tx.exec(withoutOuterTransaction(successorSql, successor))),
      /installation_current_source_changed: native_turn_helpers_current/)
    const current = (await db.query<{ body: string; definition: string }>(`SELECT prosrc body,pg_get_functiondef(oid) definition
      FROM pg_proc WHERE oid='native_turn_helpers_current()'::regprocedure`)).rows[0]
    await assert.rejects(db.transaction(async tx => {
      await tx.exec(current.definition.replace(current.body, () => current.body + '\n-- unreviewed successor body'))
      await tx.exec(toPgliteMigrationSql(successorSql, successor))
    }), /changed|mismatch/)
    assert.equal((await db.query<{ body: string }>(`SELECT prosrc body FROM pg_proc
      WHERE oid='native_turn_helpers_current()'::regprocedure`)).rows[0].body, current.body)
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [successor])).rows, [])
    const latest = '8338_native_workspace_skill_receipts.sql'
    await migratePglite(db, directory, { through: latest })
    assert.deepEqual((await db.query(`SELECT native_turn_helpers_current() native,
      native_turn_publication_contract() publication,native_retained_helpers_current() retained`)).rows,
      [{ native: true, publication: true, retained: true }])
    // The renderer also serves installations without upstream 8268. Reuse a
    // same-run pre-upstream image, not a cached migration verdict.
    await db.close()
    db = new PGlite({ extensions: { vector, pg_trgm }, loadDataDir: canonicalImage })
    await db.waitReady
    await db.exec('SET ROLE migration_owner')
    await migratePglite(db, directory, { through: latest })
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [latest])).rows, [{ name: latest }])
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [upstream])).rows, [])
    assert.deepEqual((await db.query('SELECT name FROM _migrations WHERE name=$1', [publication])).rows, [{ name: publication }])
  } finally { await db.close() }
})
