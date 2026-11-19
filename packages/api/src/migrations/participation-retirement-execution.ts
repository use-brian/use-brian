/** Exact historical ACL accommodation for 8290. [COMP:api/migration-execution-sql] */
const archivedProfile = [
  {
    signature: 'create_source_derived_entity_before_capture(jsonb,jsonb)',
    reference: 'm6_entity_acl_reference(p jsonb,e jsonb) RETURNS SETOF public.entities',
    lookup: 'm6_entity_acl_reference(jsonb,jsonb)',
    config: 'public, pg_temp',
  },
  {
    signature: 'create_source_derived_file(jsonb,jsonb)',
    reference: 'm6_file_acl_reference(p jsonb,e jsonb) RETURNS SETOF public.workspace_files',
    lookup: 'm6_file_acl_reference(jsonb,jsonb)',
    config: 'public, pg_temp',
  },
  {
    signature: 'application_patch_canonical_task(uuid,uuid,jsonb,text,jsonb)',
    reference: 'm6_task_acl_reference(w uuid,p_id uuid,patch jsonb,expected_version text DEFAULT NULL,inherited jsonb DEFAULT NULL) RETURNS jsonb',
    lookup: 'm6_task_acl_reference(uuid,uuid,jsonb,text,jsonb)',
    config: 'pg_catalog, public, pg_temp',
    task: true,
  },
] as const

function once(source: string, before: string, after: string): string {
  if (source.split(before).length !== 2) throw new Error('8290: unexpected historical ACL anchor')
  return source.replace(before, () => after)
}

/**
 * The enclosing runner authenticates every input byte. The original guard
 * still checks predecessor bodies, registry absence and every original pin
 * before this block changes a privilege. Canonical databases never enter it.
 */
export function participationRetirementExecutionSql(sql: string): string {
  const tag = '$participation_predecessor$'
  const opening = `DO ${tag}`
  const ending = `END ${tag};`
  const start = sql.indexOf(opening)
  const end = sql.indexOf(ending, start + opening.length)
  if (start < 0 || end < start || sql.indexOf(opening, start + opening.length) >= 0) {
    throw new Error('8290: unexpected participation predecessor block')
  }
  let block = sql.slice(start, end)
  block = once(block, `DO ${tag} DECLARE p pg_proc;BEGIN`, `DO ${tag}
DECLARE p pg_proc; installed pg_proc; reference pg_proc; repaired pg_proc; profile record;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 owner_grant aclitem:=makeaclitem(owner_id,owner_id,'EXECUTE',false);
 app_grant aclitem:=makeaclitem(runtime_id,owner_id,'EXECUTE',false);
 public_grant aclitem:=makeaclitem(0,owner_id,'EXECUTE',false);
 ordinary_legacy aclitem[]:=ARRAY[public_grant,app_grant,owner_grant];
 task_legacy aclitem[]:=ARRAY[app_grant,owner_grant];
 archived boolean:=false;
 identity_fields constant text[]:=ARRAY['oid','proname','pronamespace','proowner','proacl','prosrc'];
BEGIN`)

  for (const profile of archivedProfile) {
    const anchor = ` SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('public.${profile.signature}');`
    const routineStart = block.indexOf(anchor)
    const routineEnd = block.indexOf(
      ` THEN RAISE EXCEPTION 'participation_retirement_predecessor_changed: %','${profile.signature}';END IF;`,
      routineStart,
    )
    if (routineStart < 0 || routineEnd < routineStart) throw new Error('8290: missing historical ACL routine')
    const clause = block.slice(routineStart, routineEnd)
    const older = 'task' in profile ? 'task_legacy' : 'ordinary_legacy'
    const priorAclCheck = clause.match(/  OR p\.proacl IS DISTINCT FROM [^\n]+/g)
    if (priorAclCheck?.length !== 1) throw new Error('8290: unexpected routine ACL check')
    const guard = once(clause, priorAclCheck[0], `  OR (${priorAclCheck[0].trim().slice(3)} AND p.proacl IS DISTINCT FROM ${older})`)
    block = block.slice(0, routineStart) + guard + block.slice(routineEnd)
  }

  const names = archivedProfile.map(({ signature }) => `'public.${signature}'::regprocedure`).join(',')
  const references = archivedProfile.map(profile => ` CREATE FUNCTION pg_temp.${profile.reference}
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=${profile.config}
 AS $m6_acl_reference$BEGIN ${'task' in profile ? 'RETURN NULL;' : 'RETURN;'}END$m6_acl_reference$;`).join('\n')
  const profiles = archivedProfile.map(profile =>
    `('${profile.signature}','public.${profile.signature}'::regprocedure,'pg_temp.${profile.lookup}'::regprocedure,${'task' in profile})`,
  ).join(',\n   ')
  const drops = archivedProfile.map(profile => ` DROP FUNCTION pg_temp.${profile.lookup};`).join('\n')
  const repair = `
 SELECT EXISTS (SELECT 1 FROM pg_proc q WHERE q.oid=ANY(ARRAY[${names}])
  AND (q.proacl IS NOT DISTINCT FROM ordinary_legacy OR q.proacl IS NOT DISTINCT FROM task_legacy)) INTO archived;
 IF NOT archived THEN RETURN;END IF;
 IF current_user::regrole::oid<>owner_id OR runtime_id IS NULL OR runtime_id>=owner_id
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='81110_legacy_function_execute_privileges.sql')
  OR EXISTS(SELECT 1 FROM pg_default_acl d WHERE d.defaclrole=owner_id AND d.defaclobjtype='f'
    AND d.defaclnamespace IN(0,'public'::regnamespace))
 THEN RAISE EXCEPTION 'participation_retirement_unverified_historical_acl_profile';END IF;
${references}
 -- Check the complete pre-81110 tuples before changing any of the three ACLs.
 FOR profile IN SELECT * FROM (VALUES ${profiles}) AS v(signature,target,prototype,task) LOOP
  SELECT * INTO STRICT installed FROM pg_proc q WHERE q.oid=profile.target;
  SELECT * INTO STRICT reference FROM pg_proc q WHERE q.oid=profile.prototype;
  IF to_jsonb(installed)-identity_fields IS DISTINCT FROM to_jsonb(reference)-identity_fields
   OR installed.proacl IS DISTINCT FROM (CASE WHEN profile.task THEN task_legacy ELSE ordinary_legacy END)
   OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers h WHERE h.signature=profile.signature)
   OR EXISTS(SELECT 1 FROM pg_depend d WHERE d.refclassid='pg_proc'::regclass AND d.refobjid=installed.oid)
  THEN RAISE EXCEPTION 'participation_retirement_unverified_historical_acl_profile: %',profile.target;END IF;
 END LOOP;
 FOR profile IN SELECT * FROM (VALUES ${profiles}) AS v(signature,target,prototype,task) LOOP
  SELECT * INTO STRICT installed FROM pg_proc q WHERE q.oid=profile.target;
  EXECUTE format('REVOKE EXECUTE ON FUNCTION public.%s FROM app_user',profile.signature);
  IF profile.task THEN EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO app_user',profile.signature);END IF;
  SELECT * INTO STRICT repaired FROM pg_proc q WHERE q.oid=installed.oid;
  IF to_jsonb(repaired)-'proacl' IS DISTINCT FROM to_jsonb(installed)-'proacl'
   OR repaired.proacl IS DISTINCT FROM (CASE WHEN profile.task THEN ARRAY[owner_grant,app_grant] ELSE ARRAY[public_grant,owner_grant] END)
   OR EXISTS(SELECT 1 FROM pg_proc q WHERE q.oid<>repaired.oid
    AND strpos(q.prosrc,encode(sha256(convert_to(to_jsonb(repaired)::text,'UTF8')),'hex'))>0)
  THEN RAISE EXCEPTION 'participation_retirement_historical_acl_changed: %',profile.target;END IF;
 END LOOP;
${drops}
`
  return sql.slice(0, start) + block + repair + sql.slice(end)
}
