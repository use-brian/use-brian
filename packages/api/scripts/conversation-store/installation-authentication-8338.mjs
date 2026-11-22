// [COMP:api/procedural-skill-evidence] Native member authority for immutable skill receipts.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { executableProjection } from './executable-record.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as predecessor } from './installation-authentication-8337.mjs'

const migration = '8338_native_workspace_skill_receipts.sql'
const defaultRoot = fileURLToPath(new URL('../../', import.meta.url))
const sha = text => createHash('sha256').update(text).digest('hex')
const literal = text => "'" + text.replaceAll("'", "''") + "'"
const encoded = text => JSON.stringify(text).slice(1, -1).replaceAll("'", "''")
const reader = 'read_admitted_native_scope_snapshot_before_application_sources(uuid,text,uuid)'
const worklist = 'application_native_worklist_helpers_current()'
const fileEvidence = 'read_native_file_session_evidence(uuid,text[],uuid[],text[],boolean)'
const fileCohort = 'read_native_file_session_cohort_frame(uuid,text[],uuid[],text[],boolean)'
const fileCapture = 'application_native_file_capture_helpers_current()'
const titleGroup = 'application_native_title_group_helpers_current()'
const titleAcquisition = 'application_native_title_acquisition_helpers_current()'

// These consumers embed installation-local pg_proc identities. Preserve their
// executable metadata and rewrite just the authenticated reference tokens, in
// dependency order. No target-discovered routine can enter the successor.
const owners = [
  [reader, true, []],
  [worklist, true, [reader]],
  [fileEvidence, true, [worklist]],
  [fileCohort, true, [worklist]],
  [fileCapture, true, [fileEvidence, fileCohort]],
  [titleGroup, false, [fileEvidence]],
  [titleAcquisition, false, [fileEvidence, titleGroup]],
  ['capture_native_session_query_stage(uuid,uuid,integer,text,jsonb,jsonb)', false, [fileCapture]],
  ['read_native_personal_title_group_evidence(uuid,uuid[],uuid[])', false, [titleAcquisition]],
]
const before = ` IF snapshot->>'validTo' IS NULL AND snapshot->>'retractedAt' IS NULL
  AND read_entity_derivation_source(w,k,i) IS NULL THEN RETURN '{"held":true}'::jsonb; END IF;`
const after = ` IF k='workspace_skill_revision' THEN
  -- A receipt belongs to the skill that issued it. Edits can advance the
  -- current head while a prior read still depends on an intact revision.
  PERFORM 1 FROM public.workspace_skills s
   JOIN public.workspace_skill_scope_revisions r ON r.workspace_id=s.workspace_id
    AND r.skill_id=s.id
   WHERE s.workspace_id=w AND r.id=i AND NOT r.scope_held;
  IF NOT FOUND THEN RETURN '{"held":true}'::jsonb; END IF;
 ELSIF snapshot->>'validTo' IS NULL AND snapshot->>'retractedAt' IS NULL
  AND read_entity_derivation_source(w,k,i) IS NULL THEN RETURN '{"held":true}'::jsonb; END IF;`
const missing = ` snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL THEN RETURN NULL; END IF;`
const missingAfter = ` snapshot:=read_scope_source(w,k,i);
 IF snapshot IS NULL THEN
  IF k='workspace_skill_revision' THEN RETURN '{"held":true}'::jsonb; END IF;
  RETURN NULL;
 END IF;`

function numberedSource(previous) {
  const rows = owners.map(([signature, registered, inputs], index) =>
    `(${index},${literal(signature)},${registered},ARRAY[${inputs.map(literal).join(',')}]::text[])`).join(',\n  ')
  return `-- [COMP:api/procedural-skill-evidence] Admit governed native skill receipts for context and reply lineage.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $skill_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8337_project_chat_creation_admission.sql')
 THEN RAISE EXCEPTION 'skill_scope_predecessor_changed'; END IF;
END $skill_predecessor$;
${previous.sql}
CREATE TEMP TABLE skill_scope_pins(signature text PRIMARY KEY,old_hash text NOT NULL,new_hash text NOT NULL) ON COMMIT DROP;
DO $skill_scope$
DECLARE original pg_proc; successor pg_proc; node record; dependency text; pin record; body text; definition text; fingerprint text;
BEGIN
 FOR node IN SELECT * FROM (VALUES
  ${rows}
 ) AS owners(position,signature,registered,dependencies) ORDER BY position LOOP
  SELECT * INTO STRICT original FROM pg_proc WHERE oid=to_regprocedure('public.'||node.signature);
  IF EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=node.signature) IS DISTINCT FROM node.registered
   OR node.registered AND NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=node.signature
    AND h.contract IS NOT DISTINCT FROM ${executableProjection('original')})
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers h WHERE h.signature=node.signature)
   OR EXISTS(SELECT 1 FROM public.private_session_display_contract d WHERE d.signature='public.'||node.signature)
  THEN RAISE EXCEPTION 'skill_scope_pin_changed: %',node.signature; END IF;
  fingerprint:=encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex');
  body:=original.prosrc;
  IF node.position=0 THEN
   IF strpos(body,${literal(before)})=0 OR strpos(body,${literal(missing)})=0 THEN RAISE EXCEPTION 'skill_scope_reader_changed'; END IF;
   body:=replace(replace(body,${literal(before)},${literal(after)}),${literal(missing)},${literal(missingAfter)});
  ELSE
   FOREACH dependency IN ARRAY node.dependencies LOOP
    SELECT * INTO STRICT pin FROM pg_temp.skill_scope_pins WHERE signature=dependency;
    IF strpos(body,pin.old_hash)=0 THEN RAISE EXCEPTION 'skill_scope_dependency_changed: %',dependency; END IF;
    body:=replace(body,pin.old_hash,pin.new_hash);
   END LOOP;
  END IF;
  definition:=pg_get_functiondef(original.oid);
  IF (length(definition)-length(replace(definition,original.prosrc,'')))<>length(original.prosrc) THEN RAISE EXCEPTION 'skill_scope_definition_changed'; END IF;
  EXECUTE replace(definition,original.prosrc,body);
  SELECT * INTO STRICT successor FROM pg_proc WHERE oid=original.oid;
  IF to_jsonb(successor) IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(body)) THEN RAISE EXCEPTION 'skill_scope_metadata_changed'; END IF;
  INSERT INTO pg_temp.skill_scope_pins VALUES(node.signature,fingerprint,encode(sha256(convert_to(to_jsonb(successor)::text,'UTF8')),'hex'));
  IF node.registered THEN
   UPDATE public.native_turn_contract_helpers SET contract=${executableProjection('successor')} WHERE signature=node.signature;
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_temp.skill_scope_pins retired ON strpos(p.prosrc,retired.old_hash)>0
  WHERE p.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(p.pronamespace))
  OR public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE OR public.native_turn_publication_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'skill_scope_successor_contract_changed'; END IF;
END $skill_scope$;
${previous.cleanup}
COMMIT;
`
}

export async function currentInstallationAuthenticationSource({ sourceRoot = defaultRoot } = {}) {
  const previous = await predecessor({ sourceRoot })
  const numbered = await readFile(resolve(sourceRoot, 'migrations', migration), 'utf8')
  if (numbered !== numberedSource(previous)) throw Error('skill_scope_numbered_source_changed')
  let sql = previous.sql
  const liveCheck = sql.indexOf(encoded(before))
  const nullCheck = sql.lastIndexOf(encoded(missing), liveCheck)
  if (sql.split(encoded(before)).length !== 2 || nullCheck < 0 || liveCheck - nullCheck > 2400)
    throw Error('skill_scope_reader_anchor_changed')
  sql = sql.slice(0, nullCheck) + encoded(missingAfter) +
    sql.slice(nullCheck + encoded(missing).length, liveCheck) + encoded(after) +
    sql.slice(liveCheck + encoded(before).length)
  sql = `DO $skill_receipt$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${migration}') THEN RAISE EXCEPTION 'skill_scope_release_missing'; END IF;
END $skill_receipt$;
` + sql
  assertAuthenticationReadOnly(sql)
  const migrationSha = sha(numbered)
  return { ...previous, sql, migrationSha, sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) })) }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, output, ...extra] = process.argv.slice(2)
  if (mode === '--candidate' && output && !extra.length)
    await writeFile(resolve(output), numberedSource(await predecessor()), { flag: 'wx' })
  else if (mode === '--check' && !output) await currentInstallationAuthenticationSource()
  else throw Error('Use --candidate PATH or --check')
}
