// [COMP:api/fused-admission] Source module for the fused admission plan-size successor (8294).
// The compiled helpers of 8289 are inlinable SQL: every call site expands the helper's
// whole body into the calling statement's plan, and PostgreSQL initializes every node of
// a cached generic plan at each execution, taken or not. On the fixed-20 chats about half
// of a fused release's backend time was that executor start-up (4,600 plan nodes per
// shared release). This successor gives the 17 largest compiled helpers the same
// search_path their callers run with as a function-level setting, which stops the planner
// from inlining them: each becomes one call, planned once per backend and started only
// when its branch is evaluated. Bodies, owners, ACLs and every other catalog field stay
// as 8289 installed them; nothing is stored and no member is added or removed.
import {executableProjection} from './executable-record.mjs'
import {fusedMembers} from './fused-admission.mjs'

const q = value => "'" + value.replaceAll("'", "''") + "'"
const arr = values => 'ARRAY[' + values.map(q).join(',') + ']'

export const tunedSignatures = Object.freeze([
  'fused_c_admits_point(jsonb,jsonb)',
  'fused_c_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)',
  'fused_c_dept_row_allows(jsonb,uuid,text,text[],uuid)',
  'fused_c_dept_snapshot(uuid)',
  'fused_c_envelope_valid(jsonb)',
  'fused_c_member_field_permissions(uuid,jsonb,uuid)',
  'fused_c_member_read(uuid,uuid)',
  'fused_c_member_team(uuid,uuid)',
  'fused_c_memory_context(uuid,jsonb)',
  'fused_c_normalize(jsonb)',
  'fused_c_parent_from_row(uuid,sessions)',
  'fused_c_policy_epoch(uuid,uuid,uuid)',
  'fused_c_principal_query_bounds(uuid,uuid,jsonb)',
  'fused_c_scope_cap(integer,jsonb,jsonb)',
  'fused_c_scope_valid(jsonb)',
  'fused_c_session_department_facts(uuid,uuid,uuid)',
  'fused_c_visible(jsonb,uuid,jsonb)'
])
export const tunedSetting = 'search_path=pg_catalog, public, pg_temp'
const tunedClause = ' SET search_path=pg_catalog,public,pg_temp'
const nameOf = signature => signature.slice(0, signature.indexOf('('))
const bodyOf = signature => {
  const member = fusedMembers.find(m => m.name === nameOf(signature))
  if (!member || !/LANGUAGE sql/.test(member.declaration) || /\bSET\b/.test(member.declaration)) throw Error('fused_tuning_member_source_changed: ' + signature)
  return member.body
}
if (tunedSignatures.length !== 17 || new Set(tunedSignatures).size !== 17 || tunedSignatures.some(s => !s.startsWith('fused_c_'))) throw Error('fused_tuning_source_changed')
const memberCheck = (signature, config, error) => ` SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(${q('public.' + signature)});
 IF p.oid IS NULL OR p.proowner<>owner_id OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql') OR p.prosecdef
  OR (p.prosrc COLLATE "C") IS DISTINCT FROM (${q(bodyOf(signature))} COLLATE "C") OR p.proconfig IS DISTINCT FROM ${config}
  OR p.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=${q(signature)} AND ${executableProjection('p')} IS NOT DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION '${error}: ${signature}';END IF;`
const declare = "DECLARE p pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);"

// Before installation: each helper is the exact 8289 member (body from source, no setting, its record).
export const tuningPredecessorSql = `DO $fused_tuning_predecessor$ ${declare}BEGIN
${tunedSignatures.map(s => memberCheck(s, 'NULL', 'fused_tuning_predecessor_changed')).join('\n')}
END $fused_tuning_predecessor$;`
// The setting, then the typed registry record of each changed member.
export const tuningInstallSql = tunedSignatures.map(s => `ALTER FUNCTION public.${s}${tunedClause};`).join('\n') + `
DO $fused_tuning_record$ DECLARE p pg_proc;member_signature text;BEGIN
 FOREACH member_signature IN ARRAY ${arr(tunedSignatures)} LOOP
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure('public.'||member_signature);
  UPDATE native_turn_contract_helpers h SET contract=${executableProjection('p')} WHERE h.signature=member_signature;
  IF NOT FOUND THEN RAISE EXCEPTION 'fused_tuning_member_missing: %',member_signature;END IF;
 END LOOP;
END $fused_tuning_record$;`
// After installation (and on every authentication): body, setting, ACL and record.
export const tuningCheckSql = prefix => `DO $${prefix}fused_tuning$ ${declare}BEGIN
${tunedSignatures.map(s => memberCheck(s, q('{"' + tunedSetting + '"}') + '::text[]', 'installation_fused_tuning_changed')).join('\n')}
END $${prefix}fused_tuning$;`
// The predecessor recipe compiles each member's reference from the 8289 source; the
// successor compiles the tuned helpers with the same setting.
export function tuneReferenceSql(sql, prefix) {
  for (const signature of tunedSignatures) {
    const marker = 'CREATE FUNCTION pg_temp.' + prefix + 'r_' + nameOf(signature) + '('
    const at = sql.indexOf(marker), end = sql.indexOf(" AS %L'", at)
    if (at < 0 || sql.indexOf(marker, at + 1) >= 0 || end < 0 || sql.slice(at, end).includes('EXECUTE')) throw Error('fused_tuning_reference_changed: ' + signature)
    sql = sql.slice(0, end) + tunedClause + sql.slice(end)
  }
  return sql
}
