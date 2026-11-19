// [COMP:api/native-turn-frame] Source module for the Page source-family adapter (8278).
// One new registry member, `capture_page_closure_evidence`, and the row-lock
// successor of migration 725's `read_page_event_authority` (not a registry
// member). Everything here is source text: the generator writes it into 8278 and
// the installation authenticator compiles the same text into pg_temp references.
// Nothing is derived from a target catalog, and no authorization is stored.
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {executableProjection} from './executable-record.mjs'

const directory = fileURLToPath(new URL('./', import.meta.url))
const q = value => "'" + value.replaceAll("'", "''") + "'"
const arr = values => 'ARRAY[' + values.map(q).join(',') + ']'
const sha = value => createHash('sha256').update(value).digest('hex')

export const pageClosureSql = readFileSync(directory + 'page-closure.sql', 'utf8')
export const pageClosureMembers = Object.freeze([
  { signature: 'capture_page_closure_evidence(uuid,jsonb,uuid)', name: 'capture_page_closure_evidence', application: true },
])
export const pageClosureSignatures = Object.freeze(pageClosureMembers.map(member => member.signature))

// The Page principal reader of migration 725 (body unchanged through 8277; 8013
// normalized its search_path). Its successor replaces only that exact body.
export const pageAuthoritySignature = 'read_page_event_authority(uuid,uuid,uuid)'
export const predecessorPageAuthoritySha = '454fb6f2dc1dd89dbf7cc8d46c0ceb3e8ac11fa19eb25c4053fcb153f024e79b'

/** The exact CREATE FUNCTION statement of one member, from source. */
export function memberCreate(name) {
  const marker = `CREATE FUNCTION public.${name}(`
  const start = pageClosureSql.indexOf(marker), end = pageClosureSql.indexOf('END $body$;', start)
  if (start < 0 || end < 0 || pageClosureSql.indexOf(marker, start + 1) >= 0) throw Error('page_closure_member_source_changed: ' + name)
  return pageClosureSql.slice(start, end + 'END $body$;'.length)
}
/** The member statements (with their ACL) and the successor, as separate source slices. */
export function pageClosureParts() {
  const marker = '-- Successor of migration 725', successorAt = pageClosureSql.indexOf(marker)
  if (successorAt < 0 || pageClosureSql.indexOf(marker, successorAt + 1) >= 0
    || pageClosureSql.indexOf('CREATE OR REPLACE FUNCTION', successorAt) !== pageClosureSql.lastIndexOf('CREATE OR REPLACE FUNCTION')) throw Error('page_closure_successor_source_changed')
  const members = pageClosureSql.slice(0, successorAt), successor = pageClosureSql.slice(successorAt)
  const create = successor.slice(successor.indexOf('CREATE OR REPLACE'))
  const body = create.slice(create.indexOf(' AS $body$') + ' AS $body$'.length, create.indexOf('END $body$;') + 'END '.length)
  if (!body.startsWith('\nDECLARE ') || sha(body) === predecessorPageAuthoritySha || successor.includes('LOCK TABLE')) throw Error('page_closure_successor_source_changed')
  return { members, successor, successorBody: body }
}

// Wrap a predecessor body renderer: the guard roster gains the member (re-sorted
// under the database default collation, as the runtime ORDER BY). Every other
// routine renders unchanged.
export const pageClosureRendererSql = (name, predecessor) => `CREATE FUNCTION pg_temp.${name}(routine text,parts jsonb,successor boolean) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $page_closure_render$
DECLARE body text;anchor constant text:='array_agg(h.signature ORDER BY h.signature)=';start_at integer;end_at integer;old_array text;names text[];rendered text;
BEGIN
 body:=pg_temp.${predecessor}(routine,parts,successor);
 IF routine='native_turn_helpers_current()' THEN
  IF strpos(body,'native_turn_contract_witness')=0 OR (length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 THEN RAISE EXCEPTION 'page_closure_root_source_changed';END IF;
  start_at:=strpos(body,anchor)+length(anchor);end_at:=strpos(substring(body FROM start_at),'::text[]')+start_at-1;
  old_array:=substring(body FROM start_at FOR end_at-start_at);
  SELECT array_agg(replace(m[1],'''''','''') ORDER BY o) INTO names FROM regexp_matches(old_array,'''((?:[^'']|'''')*)''','g') WITH ORDINALITY x(m,o);
  IF old_array IS DISTINCT FROM (SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' FROM unnest(names) s) OR names&&${arr(pageClosureSignatures)}::text[]
  THEN RAISE EXCEPTION 'page_closure_root_roster_changed';END IF;
  SELECT 'ARRAY['||string_agg(quote_literal(s),',' ORDER BY s)||']' INTO rendered FROM unnest(names||${arr(pageClosureSignatures)}::text[]) s;
  body:=substring(body FROM 1 FOR start_at-1)||rendered||substring(body FROM end_at);
 END IF;
 RETURN body;
END $page_closure_render$;`

// The successor replaces only the exact predecessor body with its reviewed
// metadata (SECURITY DEFINER, normalized search_path, owner-only EXECUTE).
export const pageAuthorityPredecessorSql = `DO $page_authority_predecessor$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + pageAuthoritySignature)});
 IF p.oid IS NULL OR encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')<>${q(predecessorPageAuthoritySha)} OR NOT p.prosecdef OR p.proowner<>owner_id
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
 THEN RAISE EXCEPTION 'page_authority_predecessor_changed';END IF;
END $page_authority_predecessor$;`
// After installation (and on every authentication): the exact successor body and metadata.
export const pageAuthorityCheckSql = (prefix, body) => `DO $${prefix}page_authority$ DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + pageAuthoritySignature)});
 IF p.oid IS NULL OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(body)} COLLATE "C") OR NOT p.prosecdef OR p.proowner<>owner_id
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp'] OR p.provolatile<>'v' OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR EXISTS(SELECT 1 FROM pg_proc x WHERE x.proname='read_page_event_authority' AND x.oid<>p.oid)
 THEN RAISE EXCEPTION 'installation_page_authority_changed';END IF;
END $${prefix}page_authority$;`

// Read-only source authentication of the member: compiled from the quoted source
// text into pg_temp and compared field by field (identity fields excepted), with
// its exact owner/application ACL and its registry record.
export function pageClosureAuthenticationSql(prefix) {
  const references = pageClosureMembers.map(member => {
    const create = memberCreate(member.name)
    const head = create.slice(0, create.indexOf(' AS $body$'))
    const body = create.slice(create.indexOf(' AS $body$') + ' AS $body$'.length, create.lastIndexOf('$body$;'))
    const declaration = head.replace(`CREATE FUNCTION public.${member.name}(`, `CREATE FUNCTION pg_temp.${prefix}ref_${member.name}(`)
    if (declaration === head || body.includes('$body$')) throw Error('page_closure_member_source_changed: ' + member.name)
    return ` EXECUTE format(${q(declaration + ' AS %L')},${q(body)});`
  }).join('\n')
  const checks = pageClosureMembers.map(member => {
    const args = member.signature.slice(member.signature.indexOf('('))
    return ` SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + member.signature)});
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid=to_regprocedure(${q('pg_temp.' + prefix + 'ref_' + member.name + args)});
 IF actual.oid IS NULL OR (to_jsonb(actual)-identity) IS DISTINCT FROM (to_jsonb(reference)-identity) OR actual.pronamespace<>'public'::regnamespace OR actual.proowner<>owner_id
  OR actual.proname<>${q(member.name)} OR (actual.prosrc COLLATE "C") IS DISTINCT FROM (reference.prosrc COLLATE "C")
  OR actual.proacl IS DISTINCT FROM ${member.application ? "ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(runtime,owner_id,'EXECUTE',false)]" : "ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]"}
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(member.signature)} AND ${executableProjection('actual')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'installation_page_closure_member_changed: ${member.signature}';END IF;`
  }).join('\n')
  return `DO $${prefix}page_closure_references$ BEGIN
${references}
END $${prefix}page_closure_references$;
DO $${prefix}page_closure_members$ DECLARE owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 actual pg_proc;reference pg_proc;identity constant text[]:=ARRAY['oid','proname','pronamespace','proowner','proacl'];BEGIN
${checks}
END $${prefix}page_closure_members$;
${pageAuthorityCheckSql(prefix, pageClosureParts().successorBody)}`
}
export const pageClosureReferenceCleanup = prefix => pageClosureMembers.map(member =>
  `DROP FUNCTION pg_temp.${prefix}ref_${member.name}${member.signature.slice(member.signature.indexOf('('))};`).join('\n')

// Registry enrollment of the member (exact typed record).
export const pageClosureEnrollSql = `DO $page_closure_enroll$ DECLARE p pg_proc;signature text;BEGIN
 FOREACH signature IN ARRAY ${arr(pageClosureSignatures)} LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  INSERT INTO native_turn_contract_helpers VALUES(signature,${executableProjection('p')});
 END LOOP;
END $page_closure_enroll$;`
