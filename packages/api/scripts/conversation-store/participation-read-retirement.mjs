// [COMP:api/task-mutation-scope] Source module for the Project participation retirement and unmovable-child successor (8290).
// Migrations 631 and 720 let a legacy (department_read_v2=false) read or derived
// write pass a Project label only for an owner/admin or a `workspace_project_members`
// participant. Participation is navigation metadata and grants no read authority,
// and there is no member Project ceiling (scoped-context.md, projects.md): the
// Project label of a row keeps only its active-Project check, and Team scope,
// sensitivity, workspace membership and the user/assistant visibility double
// decide. Every other clause of each body is byte-identical.
// 8051's canonical task patch repointed every live child of the retired source,
// including one the editor could not move, so the 579 deferred successor guard
// never fired. The successor repoints only children the editor could patch under
// current authority (the canonical patch admission for `parentId`); an unmovable
// child stays on the retired source and the guard refuses the whole edit
// (tasks.md "Supersession"). Everything here is source text; no authorization is stored.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const migrations = directory + '../../migrations/'
const q = value => "'" + value.replaceAll("'", "''") + "'"
const sha = value => createHash('sha256').update(value).digest('hex')
const once = (text, needle, replacement) => {
  if (text.split(needle).length !== 2) throw Error('participation_retirement_source_changed: ' + needle.slice(0, 60))
  return text.replace(needle, () => replacement)
}
// The exact installed body of a function as its immutable migration declared it.
const declaredBody = (file, head, expectedSha) => {
  const text = readFileSync(migrations + file, 'utf8'), start = text.indexOf(head)
  if (start < 0 || text.indexOf(head, start + 1) >= 0) throw Error('participation_retirement_source_changed: ' + head)
  const open = text.indexOf('AS $$', start) + 'AS $$'.length, close = text.indexOf('$$;', open)
  const body = text.slice(open, close)
  if (sha(body) !== expectedSha) throw Error('participation_retirement_predecessor_source_changed: ' + head)
  return body
}

// The participation gate, as 631 wrote it for its reader and derived entity writer.
const memberGate = `
      AND (EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor AND wm.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=pid AND pm.user_id=actor))))`
// 720's derived file writer, whose v2 branch already admitted any active Project.
const fileGate = `
      AND (EXISTS(SELECT 1 FROM workspaces WHERE id=w AND department_read_v2)
        OR EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=w AND wm.user_id=actor AND wm.role IN('owner','admin'))
        OR EXISTS(SELECT 1 FROM workspace_project_members pm WHERE pm.project_id=pid AND pm.user_id=actor))))`

// Registry members: the 631 reader (renamed through the chain) and its 8160 worklist copy.
export const readSignatures = Object.freeze(['read_entity_derivation_source_before_capture(uuid,text,uuid)', 'native_worklist_source_capture(uuid,text,uuid,jsonb)'])
export const predecessorReadSha = 'cdc03dd1c41f3a47d810a4f3acc0e53d2697e255a74b461b6fa4194b89419333'
export const predecessorReadBody = declaredBody('631_entity_knowledge_derivation.sql', 'CREATE FUNCTION read_entity_derivation_source(', predecessorReadSha)
export const readBody = once(predecessorReadBody, memberGate, '))')

// Ordinary functions: not registry members and not pinned by any catalog body.
export const ordinaryReplacements = Object.freeze([
  {
    signature: 'create_source_derived_entity_before_capture(jsonb,jsonb)',
    predecessorSha: '17f7a13c5c94317c74c983c4de606729fe2ce5f84061e697a8b523b0d54b10a4',
    config: 'search_path=public, pg_temp', acl: 'default',
    predecessor: declaredBody('631_entity_knowledge_derivation.sql', 'CREATE FUNCTION create_source_derived_entity(', '17f7a13c5c94317c74c983c4de606729fe2ce5f84061e697a8b523b0d54b10a4'),
    gate: memberGate,
  },
  {
    signature: 'create_source_derived_file(jsonb,jsonb)',
    predecessorSha: '7212e9d3df50cd5709d455ee25cf91e09b98761708d7a25c839364605f5f348b',
    config: 'search_path=public, pg_temp', acl: 'default',
    predecessor: declaredBody('720_primitive_derivation_v2.sql', 'CREATE OR REPLACE FUNCTION create_source_derived_file(', '7212e9d3df50cd5709d455ee25cf91e09b98761708d7a25c839364605f5f348b'),
    gate: fileGate,
  },
  {
    signature: 'application_patch_canonical_task(uuid,uuid,jsonb,text,jsonb)',
    predecessorSha: 'f7c4bef820b384c7dde778dd0296e1ad1cb7ef9af67a777ce2b31bcd73aa6469',
    config: 'search_path=pg_catalog, public, pg_temp', acl: 'owner_app',
    // 8051 declares the body, then later in the same file inserts the write-intent
    // statements around its INSERT; the installed body is that exact result.
    predecessor: (() => {
      const declared = declaredBody('8051_application_native_operation_completion.sql', 'CREATE FUNCTION application_patch_canonical_task(', 'fdeb5755d162de2e220eee6f79288f95cd4a70840f028a431667313be821d684')
      const installed = once(declared, 'INSERT INTO tasks SELECT next.*;', "PERFORM set_config('app.native_task_write_intent',jsonb_build_object('workspaceId',w,'logicalId',next.logical_id,'fields',fields)::text,true);\n INSERT INTO tasks SELECT next.*;\n PERFORM set_config('app.native_task_write_intent','',true);")
      if (sha(installed) !== 'f7c4bef820b384c7dde778dd0296e1ad1cb7ef9af67a777ce2b31bcd73aa6469') throw Error('participation_retirement_predecessor_source_changed: application_patch_canonical_task')
      return installed
    })(),
    childRepoint: true,
  },
].map(item => {
  const body = item.childRepoint
    ? once(item.predecessor,
      ' UPDATE tasks SET parent_id=next.id WHERE workspace_id=w AND parent_id=old.id AND valid_to IS NULL AND retracted_at IS NULL AND NOT scope_held;\n',
      " -- Only a child the editor could patch under current authority moves; an unmovable\n"
      + " -- child stays on the retired source and the 579 deferred guard refuses the edit.\n"
      + ' UPDATE tasks child SET parent_id=next.id WHERE child.workspace_id=w AND child.parent_id=old.id AND child.valid_to IS NULL AND child.retracted_at IS NULL AND NOT child.scope_held\n'
      + "  AND application_task_patch_state(w,child.id,ARRAY['parentId']) IS NOT NULL;\n")
    : once(item.predecessor, item.gate, '))')
  if (body.includes('$participation_body$') || sha(body) === item.predecessorSha) throw Error('participation_retirement_successor_source_changed: ' + item.signature)
  return Object.freeze({ signature: item.signature, predecessorSha: item.predecessorSha, config: item.config, acl: item.acl, body })
}))
if (readBody.includes('$participation_body$') || readBody.includes('workspace_project_members') || sha(readBody) === predecessorReadSha
  || ordinaryReplacements.slice(0, 2).some(item => item.body.includes('workspace_project_members'))) throw Error('participation_retirement_successor_source_changed')

const owner = `(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)`
const readMetadataCheck = signature => `NOT p.prosecdef OR p.proowner<>${owner}
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(signature)} AND ${executableProjection('p')} IS NOT DISTINCT FROM h.contract)`

// Wrap the predecessor body renderer: each member body is replaced only when the
// predecessor renders the exact 631 body. Every other routine renders unchanged,
// so every consumer pin of the two members follows from the same renderer.
export const participationRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $participation_render$
DECLARE body text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine IN(${readSignatures.map(q).join(',')}) THEN
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${q(predecessorReadSha)} THEN RAISE EXCEPTION 'participation_retirement_predecessor_changed';END IF;
  body:=${q(readBody)};
 END IF;
 RETURN body;
END $participation_render$;`

// Before installation: both members are the exact 631 body with their reviewed
// metadata and registry records; each ordinary function is its exact declared body.
export const participationPredecessorSql = `DO $participation_predecessor$ DECLARE p pg_proc;BEGIN
${readSignatures.map(signature => ` SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + signature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(predecessorReadSha)} OR ${readMetadataCheck(signature)}
 THEN RAISE EXCEPTION 'participation_retirement_predecessor_changed: %',${q(signature)};END IF;`).join('\n')}
${ordinaryReplacements.map(item => ` SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + item.signature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(item.predecessorSha)} OR NOT p.prosecdef OR p.proowner<>${owner}
  OR p.proconfig IS DISTINCT FROM ARRAY[${q(item.config)}] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ${item.acl === 'default' ? 'NULL' : `ARRAY[makeaclitem(${owner},${owner},'EXECUTE',false),makeaclitem((SELECT oid FROM pg_roles WHERE rolname='app_user'),${owner},'EXECUTE',false)]`}
  OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(item.signature)})
  OR EXISTS(SELECT 1 FROM pg_proc c WHERE c.oid<>p.oid AND (strpos(c.prosrc,encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))>0
   OR strpos(c.prosrc,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'))>0 OR strpos(c.prosrc,md5(p.prosrc))>0))
 THEN RAISE EXCEPTION 'participation_retirement_predecessor_changed: %',${q(item.signature)};END IF;`).join('\n')}
END $participation_predecessor$;`

// Ordinary replacements keep every catalog field except the body: the owning
// definition is rewritten in place and compared field by field afterwards.
export const ordinaryInstallSql = `DO $participation_ordinary$ DECLARE before_row pg_proc;after_row pg_proc;definition text;
 replacements jsonb:=${q(JSON.stringify(ordinaryReplacements.map(item => ({ signature: item.signature, body: item.body }))))}::jsonb;item jsonb;BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(replacements) LOOP
  SELECT * INTO STRICT before_row FROM pg_proc WHERE oid=to_regprocedure('public.'||(item->>'signature'));
  definition:=pg_get_functiondef(before_row.oid);
  IF before_row.prosrc='' OR (length(definition)-length(replace(definition,before_row.prosrc,'')))/length(before_row.prosrc)<>1 THEN RAISE EXCEPTION 'participation_retirement_owning_body_shape: %',item->>'signature';END IF;
  EXECUTE replace(definition,before_row.prosrc,item->>'body');
  SELECT * INTO STRICT after_row FROM pg_proc WHERE oid=before_row.oid;
  IF (after_row.prosrc COLLATE "C") IS DISTINCT FROM ((item->>'body') COLLATE "C") OR (to_jsonb(after_row)-'prosrc') IS DISTINCT FROM (to_jsonb(before_row)-'prosrc')
  THEN RAISE EXCEPTION 'participation_retirement_ordinary_changed: %',item->>'signature';END IF;
 END LOOP;
END $participation_ordinary$;`

// After installation (and on every authentication): the exact successor bodies,
// unchanged metadata and the matching registry records.
export const participationCheckSql = prefix => `DO $${prefix}participation$ DECLARE p pg_proc;BEGIN
${readSignatures.map(signature => ` SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + signature)});
 IF p.oid IS NULL OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(readBody)} COLLATE "C") OR ${readMetadataCheck(signature)}
 THEN RAISE EXCEPTION 'installation_participation_retirement_changed';END IF;`).join('\n')}
END $${prefix}participation$;`
