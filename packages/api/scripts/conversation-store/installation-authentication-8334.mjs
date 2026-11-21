// [COMP:api/native-turn-frame] Preserve publication ordering without excluding a workspace's readers.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { executableProjection } from './executable-record.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8333.mjs'

const migration = '8334_conversation_publication_lock.sql'
const sourceRootDefault = fileURLToPath(new URL('../../', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const encodedBody = value => JSON.stringify(value).slice(1, -1).replaceAll("'", "''")

// A policy cannot be deleted while its workspace exists. The initial creation
// still fires guard_workspace_access_mode and therefore takes the stronger
// workspace lock before any destination/session lock.
const writerLocks = ` IF EXISTS(SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=w) THEN
  PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 ELSE
  PERFORM id FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;
 END IF;
 IF FOUND THEN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('native-session-publication:'||w::text,0));
 END IF;`
const policyInsert = ' INSERT INTO workspace_access_policies(workspace_id) VALUES(w) ON CONFLICT DO NOTHING;'
const createMissingPolicy = ` INSERT INTO workspace_access_policies(workspace_id)
 SELECT w WHERE NOT EXISTS(SELECT 1 FROM public.workspace_access_policies p WHERE p.workspace_id=w)
 ON CONFLICT DO NOTHING;`
const sessionLock = '\n PERFORM id FROM sessions WHERE workspace_id=w AND id=s FOR UPDATE;'
const sequence = '\n SELECT coalesce(max(sequence_num),0) INTO next_sequence FROM session_messages WHERE session_id=s;'
const generation = ' UPDATE sessions SET session_context_generation=session_context_generation+1 WHERE workspace_id=w AND id=s;\n'
const workspaceShare = ' PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;'
const publicPin = '  IF pin_facts THEN PERFORM id FROM public.workspaces WHERE id=w FOR SHARE; END IF;'
const verifiedChannel = workspaceShare + '\n PERFORM id FROM public.assistants WHERE id=responder AND workspace_id=w FOR SHARE;'
const sharedRoom = ' -- stronger destination locks from proof through append and completion.\n' + workspaceShare
const transition = '  PERFORM id FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;\n  IF NOT FOUND THEN RETURN NULL;END IF;'
const release = ' IF w IS NOT NULL THEN PERFORM id FROM public.workspaces WHERE id=w FOR NO KEY UPDATE;END IF;\n SELECT * INTO r FROM public.sessions WHERE id=s FOR UPDATE;'
const titleAnchor = ` IF w IS NULL THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501';END IF;\n${workspaceShare}
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;`
const edits = [
  { signature: 'lock_native_session_context_publication(uuid,uuid)', registered: true,
    before: ' PERFORM id FROM workspaces WHERE id=w FOR NO KEY UPDATE;' + sessionLock, after: writerLocks + sessionLock },
  { signature: 'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb,jsonb)', registered: true,
    before: policyInsert + sequence, after: createMissingPolicy + sequence, copies: 2 },
  { signature: 'publish_native_session_context_revision(uuid,uuid,text,uuid,uuid,jsonb,text,jsonb,uuid,bigint,integer)', registered: false,
    before: generation + policyInsert, after: generation + createMissingPolicy },
  { signature: 'native_conversation_title_context(uuid,uuid,integer,uuid,boolean)', registered: false,
    before: titleAnchor, after: titleAnchor.replace(workspaceShare, ` IF mutation THEN
${writerLocks}
 ELSE
${workspaceShare}
 END IF;`), plainReference: true },
  { signature: 'pin_verified_channel_conversation_append(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)', registered: false,
    before: verifiedChannel, after: verifiedChannel.replace(workspaceShare, writerLocks), plainReference: true },
  { signature: 'public_conversation_session_current(uuid,jsonb,uuid,text,text,uuid,uuid,text,bigint,boolean,uuid,boolean)', registered: false,
    before: publicPin, after: `  IF write_lock THEN
${writerLocks}
  ELSIF pin_facts THEN
${workspaceShare}
  END IF;`, plainReference: true },
  { signature: 'lock_shared_room_resume_evidence(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,boolean)', registered: false,
    before: sharedRoom, after: sharedRoom.replace(workspaceShare, ` IF writing THEN
${writerLocks}
 ELSE
${workspaceShare}
 END IF;`), plainReference: true },
  // Lifecycle operations can only mutate their one token-fenced destination.
  { signature: 'native_session_turn_transition(uuid,text,uuid,timestamp with time zone,integer,uuid,text,boolean)', registered: true,
    before: transition, after: transition.replace('FOR NO KEY UPDATE', 'FOR SHARE'), copies: 2 },
  { signature: 'native_session_release_turn(uuid,uuid,text)', registered: true,
    before: release, after: release.replace('FOR NO KEY UPDATE', 'FOR SHARE'), copies: 2 },
]
const reviewedRows = edits.map(({ signature, registered, before, after }) =>
  `(${literal(signature)},${registered},${literal(before)},${literal(after)})`).join(',\n  ')

function authenticatedSuccessor(source) {
  for (const { signature, before, after, plainReference, copies = 1 } of edits) {
    const encode = plainReference ? value => value.replaceAll("'", "''") : encodedBody
    if (source.split(encode(before)).length !== copies + 1) throw Error('publication_lock_source_anchor_changed: ' + signature)
    source = source.replaceAll(encode(before), () => encode(after))
  }
  return source
}

function numberedSource(previous) {
  return `-- [COMP:api/native-turn-frame] Separate the publication writer queue from workspace authority readers.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $publication_lock_prerequisites$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'publication_lock_unreviewed_ddl_trigger'; END IF;
END $publication_lock_prerequisites$;
${previous.sql}
DO $publication_lock$
DECLARE original pg_proc; successor pg_proc; fingerprint text; definition text; edit record; body text;
BEGIN
 FOR edit IN SELECT * FROM (VALUES
  ${reviewedRows}
 ) AS owners(signature,registered,before_text,after_text) LOOP
  SELECT * INTO STRICT original FROM pg_proc WHERE oid=to_regprocedure('public.'||edit.signature);
  IF (length(original.prosrc)-length(replace(original.prosrc,edit.before_text,'')))<>length(edit.before_text)
   OR EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=edit.signature) IS DISTINCT FROM edit.registered
   OR edit.registered AND NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=edit.signature
    AND h.contract IS NOT DISTINCT FROM ${executableProjection('original')})
  THEN RAISE EXCEPTION 'publication_lock_predecessor_changed: %',edit.signature; END IF;
  fingerprint:=encode(sha256(convert_to(to_jsonb(original)::text,'UTF8')),'hex');
  IF EXISTS(SELECT 1 FROM pg_proc WHERE strpos(prosrc,fingerprint)>0 AND pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(pronamespace))
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers h WHERE h.signature=edit.signature)
   OR EXISTS(SELECT 1 FROM public.private_session_display_contract d WHERE d.signature='public.'||edit.signature)
  THEN RAISE EXCEPTION 'publication_lock_unreviewed_consumer: %',edit.signature; END IF;
  definition:=pg_get_functiondef(original.oid);
  IF (length(definition)-length(replace(definition,original.prosrc,'')))<>length(original.prosrc)
  THEN RAISE EXCEPTION 'publication_lock_definition_changed'; END IF;
  body:=replace(original.prosrc,edit.before_text,edit.after_text);
  EXECUTE replace(definition,original.prosrc,body);
  SELECT * INTO STRICT successor FROM pg_proc WHERE oid=original.oid;
  IF to_jsonb(successor) IS DISTINCT FROM jsonb_set(to_jsonb(original),'{prosrc}',to_jsonb(body))
  THEN RAISE EXCEPTION 'publication_lock_metadata_changed'; END IF;
  IF edit.registered THEN
   UPDATE public.native_turn_contract_helpers h SET contract=${executableProjection('successor')} WHERE h.signature=edit.signature;
  END IF;
 END LOOP;
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'publication_lock_contract_changed'; END IF;
END $publication_lock$;
${previous.cleanup}
COMMIT;
`
}

export async function currentInstallationAuthenticationSource({ sourceRoot = sourceRootDefault } = {}) {
  const previous = await previousSource({ sourceRoot })
  const numbered = await readFile(resolve(sourceRoot, 'migrations', migration), 'utf8')
  if (numbered !== numberedSource(previous)) throw Error('publication_lock_numbered_source_changed')
  // Rerender the frozen member and reference bodies in the original verifier.
  // The rest of the catalog and every executable attribute remain pinned.
  const sql = `DO $publication_lock_receipt$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='${migration}') THEN RAISE EXCEPTION 'publication_lock_release_missing'; END IF;
END $publication_lock_receipt$;
` + authenticatedSuccessor(previous.sql)
  assertAuthenticationReadOnly(sql)
  const migrationSha = sha(numbered)
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) }))
  return { ...previous, sql, sourceDigest, migrationSha }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, output, ...extra] = process.argv.slice(2)
  if (mode === '--candidate' && output && !extra.length)
    await writeFile(resolve(output), numberedSource(await previousSource()), { flag: 'wx' })
  else if (mode === '--check' && !output) await currentInstallationAuthenticationSource()
  else throw Error('Use --candidate PATH or --check')
}
