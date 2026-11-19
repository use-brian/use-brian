// [COMP:api/application-persistence] Compose the original Memory query
// lineage fix with the authenticated current conversation implementation.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8325.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { executableProjection } from './executable-record.mjs'

const migrationName = '8326_native_memory_query_write_contract.sql'
const upstreamOriginal = '8268_native_memory_query_write_lineage.sql'
const predecessor = '8325_conversation_office_observation.sql'
const root = fileURLToPath(new URL('../../', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const historical = 'application_memory_historical_query_scan(uuid,text[],jsonb,boolean,jsonb)'
const statement = 'application_memory_statement_scan(uuid,text[],jsonb,boolean,jsonb,jsonb)'
const writer = 'record_admitted_application_field_derivation(uuid,text,uuid,text,text,jsonb)'
const routinePins = Object.freeze({
  [historical]: ['1f5afc1d54fb3bbb09a9719cbc0b4d6b2bcd6cb5743df2143abc5abb7700a864', 'fc0eb35e01aa364049649bd9d1bbf13ae6515ef6795d59db809d7e5aaf01c4f2'],
  [statement]: ['729e6d8ca0e12251b86a626245b6b226c868aa240fbeaf0b8a5de9c1e80cf447', 'f45fb6e82229635698c0d48ef98244b7c974eb12b1e1cd507f87fbd28ce0ee11'],
  [writer]: ['ad277d20b255862745d1509c40a358b30cdff08dd1169591683018ebaacb7dde', 'e09717426c463f354ee9491681bb80f7f51bc5a1d935e635368b56b4f273d6b4'],
})

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw Error('memory_query_write_contract_source_changed: ' + before.slice(0, 120))
  return source.replace(before, () => after)
}

function portion(source, tag) {
  const tagged = '$' + tag + '$'
  const parts = source.split(tagged)
  if (parts.length !== 3) throw Error('memory_query_write_original_shape_changed: ' + tag)
  return parts[1]
}

async function originalClauses(sourceRoot) {
  const archive = resolve(sourceRoot, 'scripts', 'conversation-store', 'historical', upstreamOriginal)
  const source = await readFile(archive, 'utf8')
  if (sha(source) !== 'cfe2f1cb804b28ab5a79e0f7060f894c84d059b76eba96335881c58dc123b600')
    throw Error('memory_query_write_original_source_changed')
  const original = portion(source, 'lineage_insert')
  const loop = portion(source, 'source_loop')
  const staged = replaceOnce(original, ' INSERT INTO scope_derivation_sources', portion(source, 'intent')) +
    '\n DELETE FROM native_memory_query_write_intents WHERE derivation_id=derivation AND transaction_id=pg_current_xact_id_if_assigned();'
  return {
    scan: [portion(source, 'before_scan'), portion(source, 'after_scan')],
    write: [[original, ''], [loop, staged + '\n' + loop]],
  }
}

const pinRows = successor => Object.entries(routinePins).map(([signature, pins]) =>
  '(' + literal(signature) + ',' + literal(pins[Number(successor)]) + ')').join(',')

const writerAclMismatch = `actual.proacl IS DISTINCT FROM (CASE WHEN member.signature=${literal(writer)} THEN ARRAY[owner_grant,runtime_grant] ELSE ARRAY[owner_grant] END)`
const checkRoutines = (successor = true) => `DO $memory_write_routines$
DECLARE member record; actual pg_proc;
 owner_oid oid:=(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass);
 runtime_oid oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 owner_grant aclitem; runtime_grant aclitem;
BEGIN
 IF current_user::regrole::oid IS DISTINCT FROM owner_oid OR runtime_oid IS NULL
  OR EXISTS(SELECT 1 FROM pg_roles WHERE oid=owner_oid AND (rolsuper OR rolbypassrls))
 THEN RAISE EXCEPTION 'memory_query_write_owner_changed';END IF;
 owner_grant:=makeaclitem(owner_oid,owner_oid,'EXECUTE',false);
 runtime_grant:=makeaclitem(runtime_oid,owner_oid,'EXECUTE',false);
 FOR member IN SELECT * FROM (VALUES ${pinRows(successor)}) known(signature,body_digest) LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||member.signature);
  IF encode(sha256(convert_to(actual.prosrc,'UTF8')),'hex') IS DISTINCT FROM member.body_digest
   OR actual.proowner IS DISTINCT FROM owner_oid OR actual.pronamespace<>'public'::regnamespace
   OR actual.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
   OR ${writerAclMismatch}
   OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
   OR actual.proargnames IS DISTINCT FROM (CASE member.signature
    WHEN ${literal(writer)} THEN ARRAY['w','k','i','v','producer','sources']
    WHEN ${literal(statement)} THEN ARRAY['w','fields','bounds','include_retained','frozen','admitted']
    ELSE ARRAY['w','fields','bounds','include_retained','frozen'] END)
   OR actual.prorettype IS DISTINCT FROM (CASE WHEN member.signature=${literal(writer)} THEN 'uuid'::regtype::oid ELSE 'jsonb'::regtype::oid END)
   OR NOT actual.prosecdef OR actual.proleakproof OR actual.proisstrict OR actual.proretset
   OR actual.prokind<>'f' OR actual.provolatile<>'v' OR actual.proparallel<>'u'
   OR actual.procost<>100 OR actual.prorows<>0 OR actual.pronargdefaults<>0
   OR actual.proargdefaults IS NOT NULL OR actual.proallargtypes IS NOT NULL OR actual.proargmodes IS NOT NULL
   OR actual.protrftypes IS NOT NULL OR actual.provariadic<>0 OR actual.prosupport<>0
   OR actual.probin IS NOT NULL OR actual.prosqlbody IS NOT NULL
  THEN RAISE EXCEPTION 'memory_query_write_routine_contract_changed: %',member.signature;END IF;
 END LOOP;
END $memory_write_routines$;`

const intentTable = `CREATE TABLE public.native_memory_query_write_intents(
 derivation_id uuid NOT NULL REFERENCES public.scope_derivations(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 field_id uuid NOT NULL,field_version text NOT NULL,transaction_id xid8 NOT NULL,
 PRIMARY KEY(derivation_id,field_id,field_version),
 FOREIGN KEY(field_id,field_version) REFERENCES public.application_field_observations(resource_id,version)
);`

const checkTable = (upstreamCapture = false) => `DO $memory_write_intents$
DECLARE installed pg_class;
 owner_oid oid:=(SELECT relowner FROM pg_class WHERE oid='public.memories'::regclass);
BEGIN
 SELECT * INTO STRICT installed FROM pg_class WHERE oid='public.native_memory_query_write_intents'::regclass;
 IF installed.relowner IS DISTINCT FROM owner_oid OR installed.relkind<>'r'
  OR installed.relpersistence<>'p' OR NOT installed.relrowsecurity OR installed.relforcerowsecurity
  OR installed.relispartition
  OR coalesce(installed.relacl,acldefault('r',owner_oid)) IS DISTINCT FROM acldefault('r',owner_oid)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=installed.oid)
  OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=installed.oid)
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=installed.oid OR inhparent=installed.oid)
  OR (SELECT array_agg(attname||':'||format_type(atttypid,atttypmod) ORDER BY attnum)
      FROM pg_attribute WHERE attrelid=installed.oid AND attnum>0)
   IS DISTINCT FROM ARRAY['derivation_id:uuid','workspace_id:uuid','field_id:uuid','field_version:text','transaction_id:xid8']
  OR EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=installed.oid AND attnum>0
   AND (NOT attnotnull OR attisdropped OR atthasdef OR attgenerated<>'' OR attidentity<>'' OR attacl IS NOT NULL))
  OR (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid) COLLATE "C")
   FROM pg_constraint WHERE conrelid=installed.oid AND contype IN('p','f')
    AND convalidated AND NOT condeferrable AND NOT condeferred)
   IS DISTINCT FROM ARRAY[
    'FOREIGN KEY (derivation_id) REFERENCES scope_derivations(id) ON DELETE CASCADE',
    'FOREIGN KEY (field_id, field_version) REFERENCES application_field_observations(resource_id, version)',
    'FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE',
    'PRIMARY KEY (derivation_id, field_id, field_version)']
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid=installed.oid AND contype<>'n')<>4
  OR (SELECT count(*) FROM pg_index WHERE indrelid=installed.oid)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=installed.oid AND indisprimary AND indisvalid AND indisready AND indislive)
  OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=installed.oid
   AND (NOT tgisinternal OR tgenabled<>'O')${upstreamCapture ? " AND tgname<>'crm_recovery_capture'" : ''})
  OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
   WHERE k.conrelid=installed.oid AND (NOT t.tgisinternal OR t.tgenabled<>'O'))
  OR (SELECT count(*) FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint WHERE k.conrelid=installed.oid)<>12
 THEN RAISE EXCEPTION 'memory_query_write_intents_contract_changed';END IF;
 IF EXISTS(SELECT 1 FROM public.native_memory_query_write_intents)
 THEN RAISE EXCEPTION 'memory_query_write_intents_not_empty';END IF;
${upstreamCapture ? '' : ` IF EXISTS(SELECT 1 FROM public.crm_erasure_journal_targets
  WHERE table_name='native_memory_query_write_intents')
 THEN RAISE EXCEPTION 'memory_query_write_recovery_target_unexpected';END IF;
`}
END $memory_write_intents$;`

const normalizeUpstreamCapture = `DO $memory_write_recovery_capture$
DECLARE capture pg_trigger;
 target public.crm_erasure_journal_targets;
BEGIN
 SELECT * INTO capture FROM pg_trigger
  WHERE tgrelid='public.native_memory_query_write_intents'::regclass AND tgname='crm_recovery_capture';
 SELECT * INTO target FROM public.crm_erasure_journal_targets
  WHERE table_name='native_memory_query_write_intents';
 IF capture.oid IS NULL AND target.table_name IS NULL THEN RETURN;END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(upstreamOriginal)})
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8271_refresh_recovery_capture.sql')
  OR capture.oid IS NULL OR target.table_name IS NULL
  OR capture.tgfoid IS DISTINCT FROM 'public.crm_capture_erasure_effect()'::regprocedure::oid
  OR capture.tgtype<>29 OR capture.tgenabled<>'O' OR capture.tgisinternal
  OR capture.tgconstraint<>0 OR capture.tgparentid<>0 OR capture.tgconstrrelid<>0 OR capture.tgconstrindid<>0
  OR capture.tgdeferrable OR capture.tginitdeferred
  OR capture.tgnargs<>0 OR capture.tgargs<>''::bytea OR capture.tgattr<>''::int2vector
  OR capture.tgqual IS NOT NULL OR capture.tgoldtable IS NOT NULL OR capture.tgnewtable IS NOT NULL
  OR target.key_columns IS DISTINCT FROM ARRAY['derivation_id','field_id','field_version']
  OR target.capture_inserts IS DISTINCT FROM false
 THEN RAISE EXCEPTION 'memory_query_write_recovery_capture_changed';END IF;
 IF EXISTS(SELECT 1 FROM public.crm_erasure_journal WHERE table_name='native_memory_query_write_intents')
 THEN RAISE EXCEPTION 'memory_query_write_recovery_receipts_present';END IF;
 DROP TRIGGER crm_recovery_capture ON public.native_memory_query_write_intents;
 DELETE FROM public.crm_erasure_journal_targets WHERE table_name='native_memory_query_write_intents';
END $memory_write_recovery_capture$;`

function editsSql(edits) {
  return edits.map(([before, after]) => `
  marker:=${literal(before)};
  IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  THEN RAISE EXCEPTION 'memory_query_write_source_marker_changed: %',member.signature;END IF;
  body:=replace(body,marker,${literal(after)});`).join('')
}

async function sourceWithCurrentScans(previous, clauses) {
  const before = literal(clauses.scan[0])
  const assertion = "   IF (length(body)-length(replace(body," + before + ",'')))/length(" + before + ")<>1 THEN RAISE EXCEPTION 'memory_query_write_scan_source_changed';END IF;"
  const amendment = signature => `
  IF ${signature} IN(${literal(historical)},${literal(statement)}) THEN
${assertion}
   body:=replace(body,${literal(clauses.scan[0])},${literal(clauses.scan[1])});
  END IF;`
  const predecessorRender = "  body:=pg_temp.a8314_conversion_predecessor_body(expected->>'signature',expected->'bodyParts');"
  const successorRender = '  body:=pg_temp.a8314_conversion_source_body(routine.signature,routine.parts,true);'
  let sql = replaceOnce(previous.sql, predecessorRender, predecessorRender + amendment("expected->>'signature'"))
  sql = replaceOnce(sql, successorRender, successorRender + amendment('routine.signature'))
  sql = replaceOnce(sql, '(' + literal(historical) + ',' + literal(routinePins[historical][0]) + ')',
    '(' + literal(historical) + ',' + literal(routinePins[historical][1]) + ')')
  sql = `SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $memory_write_receipt$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(migrationName)})
 THEN RAISE EXCEPTION 'memory_query_write_release_missing';END IF;
END $memory_write_receipt$;
${checkRoutines()}
${checkTable()}
${sql}`
  return sql
}

async function buildMemoryWriteMigration(sourceRoot = root) {
  const previous = await previousSource({ sourceRoot })
  const clauses = await originalClauses(sourceRoot)
  const priorSql = previous.sql
  return `-- [COMP:api/application-persistence] Retain exact Memory query lineage through canonical publication.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $memory_write_predecessor$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(predecessor)})
  OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 THEN RAISE EXCEPTION 'memory_query_write_predecessor_changed';END IF;
END $memory_write_predecessor$;
${priorSql}
${previous.cleanup}
${checkRoutines(false)}
DO $memory_write_install_intents$ BEGIN
 IF to_regclass('public.native_memory_query_write_intents') IS NULL THEN
  ${intentTable}
  ALTER TABLE public.native_memory_query_write_intents ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON public.native_memory_query_write_intents FROM PUBLIC,app_user;
 END IF;
END $memory_write_install_intents$;
LOCK TABLE public.native_memory_query_write_intents IN ACCESS EXCLUSIVE MODE;
${checkTable(true)}
${normalizeUpstreamCapture}
${checkTable()}
DO $memory_write_compose$
DECLARE member record; actual pg_proc; after_row pg_proc; definition text; body text; marker text;
BEGIN
 FOR member IN SELECT * FROM (VALUES ${pinRows(true)}) known(signature,body_digest) LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||member.signature);
  IF (member.signature<>${literal(writer)}) IS DISTINCT FROM EXISTS(
   SELECT 1 FROM public.native_turn_contract_helpers WHERE signature=member.signature
    AND contract IS NOT DISTINCT FROM ${executableProjection('actual')})
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers WHERE signature=member.signature)
  THEN RAISE EXCEPTION 'memory_query_write_registry_changed: %',member.signature;END IF;
  body:=actual.prosrc;
  IF member.signature=${literal(writer)} THEN
   ${editsSql(clauses.write)}
  ELSE
   ${editsSql([clauses.scan])}
  END IF;
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>member.body_digest
  THEN RAISE EXCEPTION 'memory_query_write_successor_changed: %',member.signature;END IF;
  definition:=pg_get_functiondef(actual.oid);
  IF (length(definition)-length(replace(definition,actual.prosrc,'')))/length(actual.prosrc)<>1
  THEN RAISE EXCEPTION 'memory_query_write_definition_changed: %',member.signature;END IF;
  EXECUTE replace(definition,actual.prosrc,body);
  SELECT * INTO STRICT after_row FROM pg_proc WHERE oid=actual.oid;
  IF to_jsonb(after_row) IS DISTINCT FROM jsonb_set(to_jsonb(actual),'{prosrc}',to_jsonb(body))
  THEN RAISE EXCEPTION 'memory_query_write_metadata_changed: %',member.signature;END IF;
  IF member.signature<>${literal(writer)} THEN
   UPDATE public.native_turn_contract_helpers SET contract=${executableProjection('after_row')}
    WHERE signature=member.signature;
  END IF;
 END LOOP;
END $memory_write_compose$;
${checkRoutines()}
DO $memory_write_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'memory_query_write_successor_witness_changed';END IF;
END $memory_write_witness$;
COMMIT;
`.replace(/^ +$/gm, '')
}

export async function memoryWriteReleaseSource({ sourceRoot = root } = {}) {
  const previous = await previousSource({ sourceRoot })
  const path = resolve(sourceRoot, 'migrations', migrationName)
  const [sql, migration] = await Promise.all([
    originalClauses(sourceRoot).then(clauses => sourceWithCurrentScans(previous, clauses)),
    readFile(path),
  ])
  const migrationSha = sha(migration)
  if (migrationSha !== 'c3a07b8c572088697a353179806f8cb880cfc73838094a2d3c2670c0a6aec269')
    throw Error('memory_query_write_numbered_source_changed')
  // Existing portable exports bind the original release source. The execution
  // projection accepts the same privilege tuples in another stored order.
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) }))
  const executable = replaceOnce(sql, writerAclMismatch, `(${writerAclMismatch}
    AND (member.signature<>${literal(writer)} OR actual.proacl IS DISTINCT FROM ARRAY[runtime_grant,owner_grant]))`)
  assertAuthenticationReadOnly(executable)
  return { ...previous, sql: executable, sourceDigest, migrationSha }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [, , mode] = process.argv
  const path = resolve(root, 'migrations', migrationName)
  const sql = await buildMemoryWriteMigration()
  if (mode === '--write') await writeFile(path, sql, { flag: 'wx' })
  else if (mode === '--check') {
    if (await readFile(path, 'utf8') !== sql) throw Error('memory_query_write_numbered_source_changed')
  } else throw Error('Expected --write or --check')
}
