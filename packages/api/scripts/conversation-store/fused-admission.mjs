// [COMP:api/fused-admission] Source module for the fused admission owner (8289).
// capture_conversation_evidence keeps its signature, metadata and two-role ACL; its
// body becomes a fixed wrapper that runs the compiled owner fused_f_capture and, when
// that owner does not compile the shape (it declines or returns the route sentinel),
// answers the whole capture with capture_conversation_evidence_generic: the exact
// predecessor body, enrolled as a template routine so every later guard re-render
// repins it. 75 compiled members (fused-admission.sql) and the generic owner join
// the canonical registry (76 members). Everything is source text: the generator
// writes it into 8289 and the installation authenticator compiles the same text into
// pg_temp references. Nothing is derived from a target catalog and no authorization
// is stored.
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const arr = values => 'ARRAY[' + values.map(q).join(',') + ']'

export const fusedSql = readFileSync(directory + 'fused-admission.sql', 'utf8')
export const wrapperBody = readFileSync(directory + 'fused-admission-capture.sql', 'utf8')
export const canonicalPins = Object.freeze(JSON.parse(readFileSync(directory + 'fused-admission-pins.json', 'utf8')))
export const captureSignature = 'capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)'
export const genericSignature = 'capture_conversation_evidence_generic(uuid,jsonb,jsonb,jsonb)'
export const genericDeclaration = 'CREATE FUNCTION public.capture_conversation_evidence_generic(w uuid,roots jsonb,authority jsonb,cohorts jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp'
export const fingerprintPlaceholder = '__CAPTURE_GUARD_FINGERPRINT__'
// sha256 of the 8287 capture body with its two guard fingerprint literals replaced by the placeholder.
export const predecessorCaptureTemplateSha = '94217da392eb7263a51f4e67dc4447f4aac8bf55b17b659724b60f14594fd223'
export const fusedType = Object.freeze({ name: 'fused_node_pre', attributes: Object.freeze(['resource:jsonb', 'observation:jsonb', 'review_held:boolean',
  'obs_sources:jsonb', 'domain_resource:jsonb', 'message_exists:boolean', 'derivations:jsonb', 'deriv_entities:jsonb', 'fields:text[]']) })
export const fusedMemberSignatures = Object.freeze([
  'fused_c_admits_point(jsonb,jsonb)',
  'fused_c_agent_read_scope(text,text[],uuid[])',
  'fused_c_agent_scope_grant(text,text[])',
  'fused_c_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)',
  'fused_c_decline(text,anyelement)',
  'fused_c_dept_grants()',
  'fused_c_dept_grants_for(uuid)',
  'fused_c_dept_row_allows(jsonb,uuid,text,text[],uuid)',
  'fused_c_dept_snapshot(uuid)',
  'fused_c_envelope_valid(jsonb)',
  'fused_c_facts4(uuid,boolean)',
  'fused_c_member_field_permissions(uuid,jsonb,uuid)',
  'fused_c_member_operation_grants(boolean,uuid)',
  'fused_c_member_principal_grants(uuid,boolean,uuid)',
  'fused_c_member_read(uuid,uuid)',
  'fused_c_member_row_allows(jsonb,uuid,text,text[])',
  'fused_c_member_team(uuid,uuid)',
  'fused_c_memory_catalog(uuid)',
  'fused_c_memory_context(uuid,jsonb)',
  'fused_c_memory_field_keys()',
  'fused_c_normalize(jsonb)',
  'fused_c_parent_from_row(uuid,sessions)',
  'fused_c_parent_precheck(uuid,uuid)',
  'fused_c_personal_audience(sessions)',
  'fused_c_placement_visible(uuid,uuid)',
  'fused_c_policy_epoch(uuid,uuid,uuid)',
  'fused_c_principal_facts(uuid)',
  'fused_c_principal_query_bounds(uuid,uuid,jsonb)',
  'fused_c_project_audience(sessions,boolean)',
  'fused_c_project_labels_allowed(jsonb,uuid,text[],boolean)',
  'fused_c_project_member_live(uuid,text,uuid)',
  'fused_c_query_parent(jsonb,uuid,boolean,sessions)',
  'fused_c_scope_cap(integer,jsonb,jsonb)',
  'fused_c_scope_valid(jsonb)',
  'fused_c_session_department_facts(uuid,uuid,uuid)',
  'fused_c_session_query_bounds(uuid,jsonb)',
  'fused_c_set_intersection(jsonb,jsonb)',
  'fused_c_union_contains(jsonb,jsonb,integer)',
  'fused_c_uuidp(text)',
  'fused_c_visible(jsonb,uuid,jsonb)',
  'fused_c_workspace_audience(sessions)',
  'fused_f_adjacent(uuid,jsonb)',
  'fused_f_agent_read_scope_allows(text,text[],uuid[])',
  'fused_f_capture(uuid,jsonb,jsonb,jsonb,text)',
  'fused_f_cohort_membership(jsonb,jsonb)',
  'fused_f_dag(jsonb,uuid,jsonb,jsonb,jsonb,boolean,jsonb,integer[],jsonb,jsonb,timestamp with time zone,bigint,jsonb,bigint,jsonb,boolean,fused_node_pre[])',
  'fused_f_deadline(uuid,jsonb)',
  'fused_f_dept_grants()',
  'fused_f_dept_grants_for(uuid)',
  'fused_f_dept_row_allows(jsonb,uuid,text,text[],uuid)',
  'fused_f_dept_snapshot(uuid)',
  'fused_f_digest(jsonb)',
  'fused_f_fence(text)',
  'fused_f_graph_t(uuid,jsonb)',
  'fused_f_member_operation_grants(boolean,uuid)',
  'fused_f_member_principal_grants(uuid,boolean,uuid)',
  'fused_f_member_row_allows(jsonb,uuid,text,text[])',
  'fused_f_prefetch(uuid,jsonb)',
  'fused_f_privacy(uuid,jsonb)',
  'fused_f_rank(text)',
  'fused_f_recording_candidates(uuid,jsonb)',
  'fused_f_sst(text)',
  'fused_f_sst_kv(text)',
  'fused_f_sst_media(text)',
  'fused_f_sst_pc(text)',
  'fused_f_structure(jsonb,jsonb)',
  'fused_f_turn_key(jsonb)',
  'fused_f_uuid(text)',
  'fused_f_visible(jsonb,uuid,jsonb)',
  'fused_l_domain(jsonb,uuid,text,uuid,text[],jsonb,jsonb,jsonb[])',
  'fused_l_envelope_memory(jsonb,uuid,text,uuid,text,text[],jsonb,jsonb)',
  'fused_l_envelope_session(jsonb,uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[],jsonb)',
  'fused_l_message_snapshot(jsonb,uuid,uuid,jsonb)',
  'fused_l_point(jsonb,uuid,text,uuid,text[],jsonb,jsonb,jsonb[])',
  'fused_l_transcript(uuid,uuid)'
])
export const fusedSignatures = Object.freeze([...fusedMemberSignatures, genericSignature])

// One CREATE statement per member, in source order, with its dollar-quoted body.
function members() {
  const out = [], re = /^CREATE FUNCTION (\w+)\(/gm
  let m
  while ((m = re.exec(fusedSql))) {
    const as = /\sAS (\$\w*\$)/g; as.lastIndex = m.index
    const a = as.exec(fusedSql), tag = a[1], bodyStart = a.index + a[0].length
    const close = fusedSql.indexOf(tag, bodyStart), end = fusedSql.indexOf(';', close) + 1
    const declaration = fusedSql.slice(m.index, a.index), body = fusedSql.slice(bodyStart, close)
    if (/CREATE FUNCTION/.test(declaration.slice(15)) || body.includes(tag)) throw Error('fused_admission_member_source_changed: ' + m[1])
    out.push({ name: m[1], declaration, body })
    re.lastIndex = end
  }
  return out
}
export const fusedMembers = Object.freeze(members())
{
  const names = fusedMembers.map(m => m.name), signed = fusedMemberSignatures.map(s => s.slice(0, s.indexOf('(')))
  if (names.length !== 75 || new Set(names).size !== names.length || [...names].sort().join() !== [...signed].sort().join()
    || !fusedSql.includes('\nCREATE TYPE fused_node_pre AS (') || fusedSql.split('CREATE TYPE').length !== 2
    || wrapperBody.split(fingerprintPlaceholder).length !== 3 || !wrapperBody.includes("fused_f_capture(w,roots,authority,cohorts,'" + fingerprintPlaceholder + "')")
    || !wrapperBody.includes("IS DISTINCT FROM '" + fingerprintPlaceholder + "' THEN RAISE EXCEPTION 'scope_source_changed'") || !wrapperBody.startsWith('\nDECLARE ') || !wrapperBody.endsWith('\nEND ')
    || /\b(fa_|pd_|proto_)\w*\(|fa\.strict|[0-9a-f]{64}/.test(fusedSql.replace(/^--.*$/gm, '')) || Object.keys(canonicalPins).length !== 86)
    throw Error('fused_admission_source_changed')
}
const signatureOf = name => fusedMemberSignatures.find(s => s.slice(0, s.indexOf('(')) === name)

// Installation statements: the type, the 75 members (public, owner-only) and their ACLs.
export const fusedInstallSql = fusedSql.replace('\nCREATE TYPE fused_node_pre AS (', '\nCREATE TYPE public.fused_node_pre AS (')
  .replace(/^CREATE FUNCTION (fused_\w+)\(/gm, 'CREATE FUNCTION public.$1(')
  + fusedMemberSignatures.map(s => `REVOKE ALL ON FUNCTION public.${s} FROM PUBLIC,app_user;`).join('\n') + '\n'

// The capture body must be the exact 8287 body: two equal guard fingerprint literals,
// and the rest byte-identical (sha of the body with the placeholder in their place).
const fingerprintPattern = "'IS DISTINCT FROM ''([0-9a-f]{64})'' THEN'"
const templateChanged = body => `(SELECT count(*) FROM regexp_matches(${body},${fingerprintPattern},'g'))<>2
  OR (SELECT count(DISTINCT m[1]) FROM regexp_matches(${body},${fingerprintPattern},'g') m)<>1
  OR encode(sha256(convert_to(regexp_replace(${body},${fingerprintPattern},${q("IS DISTINCT FROM '" + fingerprintPlaceholder + "' THEN")},'g'),'UTF8')),'hex')<>${q(predecessorCaptureTemplateSha)}`

// The generic owner is a template routine with the capture's parts: every guard
// re-render repins its fingerprint through the reviewed propagation.
export const genericTemplateSql = prefix => `INSERT INTO pg_temp.${prefix}publication_successor_templates SELECT ${q(genericSignature)},parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=${q(captureSignature)};
INSERT INTO pg_temp.${prefix}publication_expected_current SELECT ${q(genericSignature)},to_jsonb(p) FROM pg_proc p WHERE p.oid=to_regprocedure(${q('public.' + genericSignature)});`
// The generic owner: the exact installed predecessor body under a new owner-only name.
export const genericCreateSql = prefix => `DO $fused_generic$ DECLARE body text;BEGIN
 SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid=${q('public.' + captureSignature)}::regprocedure;
 IF ${templateChanged('body')} THEN RAISE EXCEPTION 'fused_admission_predecessor_changed';END IF;
 EXECUTE format(${q(genericDeclaration + ' AS %L')},body);
END $fused_generic$;
REVOKE ALL ON FUNCTION public.${genericSignature} FROM PUBLIC,app_user;
${genericTemplateSql(prefix)}`

// Wrap a predecessor body renderer: the guard roster gains the 76 members (re-sorted
// under the database default collation, as the runtime ORDER BY), and the capture body
// becomes the wrapper only when the predecessor renders the exact 8287 capture body.
// Every other routine, the generic owner included, renders unchanged.
export const fusedRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $fused_render$
DECLARE body text;anchor constant text:='array_agg(h.signature ORDER BY h.signature)=';start_at integer;end_at integer;old_array text;names text[];rendered text;fingerprint text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF strpos(body,'native_turn_contract_witness')=0 OR (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'fused_admission_root_source_changed';END IF;
  start_at:=strpos(body,anchor)+length(anchor);end_at:=strpos(substring(body FROM start_at),'::text[]')+start_at-1;
  old_array:=substring(body FROM start_at FOR end_at-start_at);
  SELECT array_agg(replace(m[1],'''''','''') ORDER BY o) INTO names FROM regexp_matches(old_array,'''((?:[^'']|'''')*)''','g') WITH ORDINALITY x(m,o);
  IF old_array IS DISTINCT FROM (SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' FROM unnest(names) s) OR names&&${arr(fusedSignatures)}::text[]
  THEN RAISE EXCEPTION 'fused_admission_root_roster_changed';END IF;
  SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' INTO rendered FROM unnest(names||${arr(fusedSignatures)}::text[]) s;
  body:=substring(body FROM 1 FOR start_at-1)||rendered||substring(body FROM end_at);
 ELSIF routine=${q(captureSignature)} THEN
  IF ${templateChanged('body')} THEN RAISE EXCEPTION 'fused_admission_capture_source_changed';END IF;
  SELECT m[1] INTO STRICT fingerprint FROM regexp_matches(body,${fingerprintPattern}) m;
  body:=replace(${q(wrapperBody)},${q(fingerprintPlaceholder)},fingerprint);
 END IF;
 RETURN body;
END $fused_render$;`

// Before installation: nothing of the successor exists yet.
export const fusedAbsentSql = `EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND (p.proname LIKE 'fused\\_%' OR p.proname='capture_conversation_evidence_generic'))
  OR to_regtype('public.fused_node_pre') IS NOT NULL
  OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=ANY(${arr(fusedSignatures)}::text[]))`

// Registry enrollment of the 76 members (exact typed records).
export const fusedEnrollSql = `DO $fused_enroll$ DECLARE p pg_proc;signature text;BEGIN
 FOREACH signature IN ARRAY ${arr(fusedSignatures)} LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  INSERT INTO native_turn_contract_helpers VALUES(signature,${executableProjection('p')});
 END LOOP;
END $fused_enroll$;`

// Canonical pins are installation-independent: fingerprint literals (64 hex digits)
// and object identifiers (an integer literal cast to oid) are normalized before hashing.
// Read-only source authentication: every compiled member compiled from the quoted
// source into pg_temp and compared field by field (identity fields excepted), with
// its owner-only ACL and registry record; the generic owner against the reference
// compiled from its declaration and the rendered predecessor body; the wrapper
// against the renderer; the prefetch type; the compiled canonical bodies; and no
// other fused member.
export function fusedAuthenticationSql(prefix, renderer, templates) {
  const references = fusedMembers.map(member => {
    const declaration = member.declaration.replace('CREATE FUNCTION ' + member.name + '(', 'CREATE FUNCTION pg_temp.' + prefix + 'r_' + member.name + '(')
    if (declaration === member.declaration) throw Error('fused_admission_member_source_changed: ' + member.name)
    return ' EXECUTE format(' + q(declaration + ' AS %L') + ',' + q(member.body) + ');'
  }).join('\n')
  const checks = fusedMembers.map(member => {
    const signature = signatureOf(member.name), args = signature.slice(signature.indexOf('('))
    return ` SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + signature)});
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure(${q('pg_temp.' + prefix + 'r_' + member.name + args)});
 IF actual.oid IS NULL OR (to_jsonb(actual)-identity) IS DISTINCT FROM (to_jsonb(reference)-identity) OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR actual.proname<>${q(member.name)} OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (reference.prosrc COLLATE "C")
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(signature)} AND ${executableProjection('actual')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_fused_admission_member_changed: ${signature}';END IF;`
  }).join('\n')
  const pins = Object.entries(canonicalPins).map(([signature, digest]) => `(${q(signature)},${q(digest)})`).join(',')
  const genericReference = genericDeclaration.replace('CREATE FUNCTION public.capture_conversation_evidence_generic(', 'CREATE FUNCTION pg_temp.' + prefix + 'r_generic(')
  return `DO $${prefix}fused_references$ BEGIN
${references}
 EXECUTE format(${q(genericReference + ' AS %L')},
  pg_temp.${renderer}(${q(genericSignature)},(SELECT parts FROM pg_temp.${templates} WHERE signature=${q(captureSignature)}),true));
END $${prefix}fused_references$;
DO $${prefix}fused_members$ DECLARE owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 actual pg_proc;reference pg_proc;identity constant text[]:=ARRAY['oid','proname','pronamespace','proowner','proacl'];unknown text;BEGIN
${checks}
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + genericSignature)});
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure(${q('pg_temp.' + prefix + 'r_generic(uuid,jsonb,jsonb,jsonb)')});
 IF actual.oid IS NULL OR (to_jsonb(actual)-identity) IS DISTINCT FROM (to_jsonb(reference)-identity) OR actual.proowner<>owner_id
  OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (reference.prosrc COLLATE "C") OR strpos(actual.prosrc,'fused_')>0
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(genericSignature)} AND ${executableProjection('actual')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_fused_admission_generic_changed';END IF;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + captureSignature)});
 IF actual.oid IS NULL OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (pg_temp.${renderer}(${q(captureSignature)},(SELECT parts FROM pg_temp.${templates} WHERE signature=${q(captureSignature)}),true) COLLATE "C")
  OR strpos(actual.prosrc,'fused_f_capture(')=0 OR NOT actual.prosecdef OR actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(captureSignature)} AND ${executableProjection('actual')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_fused_admission_capture_changed';END IF;
 SELECT p.oid::regprocedure::text INTO unknown FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'fused\\_%'
  AND NOT p.oid::regprocedure::text=ANY(${arr(fusedMemberSignatures)}::text[]) LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'installation_fused_admission_unreviewed_member: %',unknown;END IF;
 IF (SELECT array_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) FROM pg_attribute a
   WHERE a.attrelid=(SELECT t.typrelid FROM pg_type t WHERE t.oid=to_regtype('public.fused_node_pre')) AND a.attnum>0 AND NOT a.attisdropped)
  IS DISTINCT FROM ${arr(fusedType.attributes)}::text[]
  OR (SELECT t.typowner FROM pg_type t WHERE t.oid=to_regtype('public.fused_node_pre'))<>owner_id
 THEN RAISE EXCEPTION 'installation_fused_admission_type_changed';END IF;
 SELECT x.signature INTO unknown FROM (VALUES ${pins}) x(signature,digest)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||x.signature)
  WHERE p.oid IS NULL OR encode(sha256(convert_to(regexp_replace(regexp_replace(p.prosrc,'[0-9a-f]{64}',repeat('0',64),'g'),'[0-9]+::oid','0::oid','g'),'UTF8')),'hex')<>x.digest LIMIT 1;
 IF unknown IS NOT NULL THEN RAISE EXCEPTION 'installation_fused_admission_canonical_changed: %',unknown;END IF;
END $${prefix}fused_members$;`
}
export const fusedReferenceCleanup = prefix => fusedMembers.map(member => {
  const signature = signatureOf(member.name)
  return `DROP FUNCTION pg_temp.${prefix}r_${member.name}${signature.slice(signature.indexOf('('))};`
}).join('\n') + `\nDROP FUNCTION pg_temp.${prefix}r_generic(uuid,jsonb,jsonb,jsonb);`
