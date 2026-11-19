// [COMP:api/native-turn-frame] Source module for the durable completion header (8277).
// One immutable completion row per owned turn, for every lane and both editions.
// Everything here is source text: the generator writes it into 8277 and the
// installation authenticator compiles the same text into pg_temp references.
// Nothing is derived from a target catalog, and no authorization is stored.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const arr = values => 'ARRAY[' + values.map(q).join(',') + ']'
const sha = value => createHash('sha256').update(value).digest('hex')

export const completionTable = 'public.native_turn_completions'
export const completionSql = readFileSync(directory + 'turn-completion.sql', 'utf8')
// The new registry members, in source order. Two are application ports, two are owner-only.
export const completionMembers = Object.freeze([
  { signature: 'native_turn_completion_scope(uuid,uuid)', name: 'native_turn_completion_scope', application: false },
  { signature: 'record_native_turn_completion(uuid,uuid,uuid,jsonb)', name: 'record_native_turn_completion', application: true },
  { signature: 'read_native_turn_completion(uuid,uuid,uuid,jsonb)', name: 'read_native_turn_completion', application: true },
  { signature: 'native_turn_completion_immutable()', name: 'native_turn_completion_immutable', application: false },
])
export const completionSignatures = Object.freeze(completionMembers.map(member => member.signature))

// The expired-turn classifier is an existing registry member. Its successor body
// replaces only the immutable 8272 body below; the rest of its record is unchanged.
export const outcomeSignature = 'native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean)'
export const predecessorOutcomeSha = '7a4640ba740eb34854488d128598d5ab65ef26fdb965054bc3b0570c9f1790bd'
export const outcomeBody = readFileSync(directory + 'turn-completion-outcome.sql', 'utf8').replace(/\n$/, '')
if (!outcomeBody.startsWith('\nDECLARE ') || !outcomeBody.endsWith('\nEND ') || sha(outcomeBody) === predecessorOutcomeSha) throw Error('completion_outcome_source_changed')

/** The exact CREATE FUNCTION statement of one member, from source. */
export function memberCreate(name) {
  const marker = `CREATE FUNCTION public.${name}(`
  const start = completionSql.indexOf(marker), end = completionSql.indexOf('END $body$;', start)
  if (start < 0 || end < 0 || completionSql.indexOf(marker, start + 1) >= 0) throw Error('completion_member_source_changed: ' + name)
  return completionSql.slice(start, end + 'END $body$;'.length)
}

// Wrap a predecessor body renderer: the guard roster gains the four members
// (re-sorted under the database default collation, as the runtime ORDER BY), and
// the classifier body is replaced only when the predecessor renders the exact 8272
// body. Every other routine renders unchanged.
export const completionRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $completion_render$
DECLARE body text;anchor constant text:='array_agg(h.signature ORDER BY h.signature)=';start_at integer;end_at integer;old_array text;names text[];rendered text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF strpos(body,'native_turn_contract_witness')=0 OR (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'completion_root_source_changed';END IF;
  start_at:=strpos(body,anchor)+length(anchor);end_at:=strpos(substring(body FROM start_at),'::text[]')+start_at-1;
  old_array:=substring(body FROM start_at FOR end_at-start_at);
  SELECT array_agg(replace(m[1],'''''','''') ORDER BY o) INTO names FROM regexp_matches(old_array,'''((?:[^'']|'''')*)''','g') WITH ORDINALITY x(m,o);
  IF old_array IS DISTINCT FROM (SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' FROM unnest(names) s) OR names&&${arr(completionSignatures)}::text[]
  THEN RAISE EXCEPTION 'completion_root_roster_changed';END IF;
  SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' INTO rendered FROM unnest(names||${arr(completionSignatures)}::text[]) s;
  body:=substring(body FROM 1 FOR start_at-1)||rendered||substring(body FROM end_at);
 ELSIF routine=${q(outcomeSignature)} THEN
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${q(predecessorOutcomeSha)} THEN RAISE EXCEPTION 'completion_outcome_predecessor_changed';END IF;
  body:=${q(outcomeBody)};
 END IF;
 RETURN body;
END $completion_render$;`

// Read-only source authentication of the four members: each is compiled from the
// quoted source text into pg_temp and compared field by field (identity fields
// excepted), with its exact owner/application ACL and its registry record.
export function completionAuthenticationSql(prefix) {
  const references = completionMembers.map(member => {
    const create = memberCreate(member.name)
    const head = create.slice(0, create.indexOf(' AS $body$'))
    const body = create.slice(create.indexOf(' AS $body$') + ' AS $body$'.length, create.lastIndexOf('$body$;'))
    const declaration = head.replace(`CREATE FUNCTION public.${member.name}(`, `CREATE FUNCTION pg_temp.${prefix}ref_${member.name}(`)
    if (declaration === head || body.includes('$body$')) throw Error('completion_member_source_changed: ' + member.name)
    return ` EXECUTE format(${q(declaration + ' AS %L')},${q(body)});`
  }).join('\n')
  const checks = completionMembers.map(member => {
    const args = member.signature.slice(member.signature.indexOf('('))
    return ` SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + member.signature)});
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure(${q('pg_temp.' + prefix + 'ref_' + member.name + args)});
 IF actual.oid IS NULL OR (to_jsonb(actual)-identity) IS DISTINCT FROM (to_jsonb(reference)-identity) OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR actual.proname<>${q(member.name)} OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (reference.prosrc COLLATE "C")
  OR actual.proacl IS DISTINCT FROM ${member.application ? "ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime,owner_id,'EXECUTE',false)]" : "ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]"}
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(member.signature)} AND ${executableProjection('actual')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_completion_member_changed: ${member.signature}';END IF;`
  }).join('\n')
  return `DO $${prefix}completion_references$ BEGIN
${references}
END $${prefix}completion_references$;
DO $${prefix}completion_members$ DECLARE owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 actual pg_proc;reference pg_proc;identity constant text[]:=ARRAY['oid','proname','pronamespace','proowner','proacl'];BEGIN
${checks}
END $${prefix}completion_members$;
${completionRelationCheckSql(prefix)}`
}
export const completionReferenceCleanup = prefix => completionMembers.map(member =>
  `DROP FUNCTION pg_temp.${prefix}ref_${member.name}${member.signature.slice(member.signature.indexOf('('))};`).join('\n')

// The relation contract, from source: exact columns, constraints, index, triggers,
// owner-only ACL, RLS without policies and the reviewed recovery capture target.
export const completionColumns = Object.freeze(['id:uuid:true:false:', 'workspace_id:uuid:false:false:', 'session_id:uuid:true:false:',
  'turn_token:uuid:true:false:', 'turn_id:text:false:false:', 'lane:text:true:false:', 'assistant_id:uuid:true:false:', 'input_kind:text:false:false:',
  'input_ref:text:false:false:', 'stopped:boolean:true:false:', 'published_reply:boolean:true:false:', 'outputs:jsonb:true:false:',
  'created_at:timestamp with time zone:true:true:'])
export const completionTriggers = Object.freeze(['crm_recovery_capture:crm_capture_erasure_effect():29:O:false',
  'native_turn_completion_immutable:native_turn_completion_immutable():19:O:false'])
export const completionRelationCheckSql = prefix => `DO $${prefix}completion_relation$ DECLARE rel pg_class;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);saved text:=current_setting('search_path');BEGIN
 -- Catalog deparsing qualifies names by visibility: render under the reviewed path.
 PERFORM set_config('search_path','pg_catalog,public,pg_temp',true);
 SELECT * INTO rel FROM pg_class WHERE oid=to_regclass('${completionTable}');
 IF rel.oid IS NULL OR rel.relkind<>'r' OR rel.relpersistence<>'p' OR rel.relowner<>owner_id OR NOT rel.relrowsecurity OR rel.relforcerowsecurity
  OR coalesce(rel.relacl,acldefault('r',rel.relowner)) IS DISTINCT FROM acldefault('r',rel.relowner)
  OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=rel.oid) OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=rel.oid)
  OR EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=rel.oid OR inhparent=rel.oid)
  OR (SELECT array_agg(a.attname::text||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text||':'||a.atthasdef::text||':'||coalesce(a.attacl::text,'') ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=rel.oid AND a.attnum>0 AND NOT a.attisdropped)
   IS DISTINCT FROM ${arr(completionColumns)}
  OR (SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid=rel.oid AND a.attname='created_at') IS DISTINCT FROM 'clock_timestamp()'
  OR (SELECT array_agg(c.conname::text||':'||c.contype::text||':'||pg_get_constraintdef(c.oid) ORDER BY c.conname COLLATE "C") FROM pg_constraint c WHERE c.conrelid=rel.oid AND c.contype<>'n')
   IS DISTINCT FROM (SELECT array_agg(x ORDER BY x COLLATE "C") FROM unnest(${arr(completionConstraintDefinitions())}::text[]) x)
  OR (SELECT array_agg(pg_get_indexdef(i.indexrelid) ORDER BY pg_get_indexdef(i.indexrelid) COLLATE "C") FROM pg_index i WHERE i.indrelid=rel.oid)
   IS DISTINCT FROM ARRAY['CREATE INDEX native_turn_completion_discovery ON public.native_turn_completions USING btree (session_id, input_kind, input_ref, created_at)',
    'CREATE UNIQUE INDEX native_turn_completion_turn ON public.native_turn_completions USING btree (session_id, turn_token)',
    'CREATE UNIQUE INDEX native_turn_completions_pkey ON public.native_turn_completions USING btree (id)']
  OR (SELECT array_agg(g.tgname::text||':'||g.tgfoid::regprocedure::text||':'||g.tgtype||':'||g.tgenabled::text||':'||g.tgisinternal::text ORDER BY g.tgname COLLATE "C") FROM pg_trigger g WHERE g.tgrelid=rel.oid AND NOT g.tgisinternal)
   IS DISTINCT FROM ${arr(completionTriggers)}
  OR NOT EXISTS(SELECT 1 FROM public.crm_erasure_journal_targets t WHERE t.table_name='native_turn_completions' AND t.key_columns='{id}' AND NOT t.capture_inserts)
 THEN RAISE EXCEPTION 'installation_completion_relation_changed';END IF;
 PERFORM set_config('search_path',saved,true);
END $${prefix}completion_relation$;`
export function completionConstraintDefinitions() {
  return ['native_turn_completion_input:c:CHECK ((((input_kind IS NULL) AND (input_ref IS NULL)) OR ((input_kind = ANY (ARRAY[\'session_message\'::text, \'approval\'::text, \'delegation\'::text])) AND ((length(input_ref) >= 1) AND (length(input_ref) <= 200)))))',
    'native_turn_completion_lane:c:CHECK ((lane = ANY (ARRAY[\'web_shared\'::text, \'web_private\'::text, \'channel\'::text, \'public\'::text, \'callee\'::text, \'resume\'::text])))',
    'native_turn_completion_outputs:c:CHECK (((jsonb_typeof(outputs) = \'array\'::text) AND ((jsonb_array_length(outputs) >= 1) AND (jsonb_array_length(outputs) <= 512))))',
    'native_turn_completion_reply:c:CHECK ((NOT (stopped AND published_reply)))',
    'native_turn_completion_turn:u:UNIQUE (session_id, turn_token)',
    'native_turn_completion_turn_id:c:CHECK ((((turn_id ~ \'^[a-f0-9]{64}$\'::text) AND (workspace_id IS NOT NULL)) OR ((turn_id IS NULL) AND (workspace_id IS NULL))))',
    'native_turn_completions_assistant_id_fkey:f:FOREIGN KEY (assistant_id) REFERENCES assistants(id) ON DELETE CASCADE',
    'native_turn_completions_pkey:p:PRIMARY KEY (id)',
    'native_turn_completions_session_id_fkey:f:FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE',
    'native_turn_completions_workspace_id_fkey:f:FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE']
}

// Registry enrollment of the four members (exact typed records).
export const completionEnrollSql = `DO $completion_enroll$ DECLARE p pg_proc;signature text;BEGIN
 FOREACH signature IN ARRAY ${arr(completionSignatures)} LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  INSERT INTO native_turn_contract_helpers VALUES(signature,${executableProjection('p')});
 END LOOP;
END $completion_enroll$;`
