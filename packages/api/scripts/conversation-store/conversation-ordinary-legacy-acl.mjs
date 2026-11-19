// [COMP:api/migration-owner-role] Normalize the exact historical 8298 predecessor profile.
import { bypassOrdinaryFunctionsSql } from './legacy-bypass-functions.mjs'

const quote = value => value === null ? 'NULL' : "'" + value.replaceAll("'", "''") + "'"
const ownerAcl = "makeaclitem(owner_role,owner_role,'EXECUTE',false)"
const runtimeAcl = "makeaclitem('app_user'::regrole,owner_role,'EXECUTE',false)"
const publicAcl = "makeaclitem(0,owner_role,'EXECUTE',false)"
const defaultAcl = 'NULL'
const privateAcl = `ARRAY[${ownerAcl}]`
const appAcl = `ARRAY[${ownerAcl},${runtimeAcl}]`
const historicalAppAcl = `ARRAY[${runtimeAcl},${ownerAcl}]`
const historicalPublicAcl = `ARRAY[${publicAcl},${runtimeAcl},${ownerAcl}]`
const department = 'can_view_department_directory(uuid,uuid)'
const crm = 'crm_activity_scope_allows(crm_activities,boolean)'
const publicRoutines = [department, crm]
const policies = [
  [0, 'workspace_groups', 'workspace_groups_directory', 'r', 'can_view_department_directory(workspace_id, id)', null],
  [0, 'workspace_compartments', 'workspace_compartments_directory', 'r',
    "((managed_by IS DISTINCT FROM 'team'::text) OR can_view_department_directory(workspace_id, managed_ref_id))", null],
  [1, 'crm_activities', 'crm_activities_scope_read', 'r', 'crm_activity_scope_allows(crm_activities.*, false)', null],
  [1, 'crm_activities', 'crm_activities_scope_insert', 'a', null, 'crm_activity_scope_allows(crm_activities.*, true)'],
  [1, 'crm_activities', 'crm_activities_scope_update', 'w',
    'crm_activity_scope_allows(crm_activities.*, true)', 'crm_activity_scope_allows(crm_activities.*, true)'],
  [1, 'crm_activities', 'crm_activities_scope_delete', 'd', 'crm_activity_scope_allows(crm_activities.*, true)', null],
]
const slots = [
  ['application_native_configuration_operations', 'apply_handler'],
  ['application_native_field_contracts', 'catalog_reader'],
  ['application_native_field_contracts', 'configuration_reader'],
  ['application_native_field_contracts', 'metadata_reader'],
]

function sqlLiteral(label, text) {
  const marker = `$ordinary_acl_${label}$`
  if (text.includes(marker)) throw new Error('legacy_ordinary_acl_delimiter_changed')
  return marker + '\n' + text + '\n' + marker
}

export function historicalOrdinaryAclSql(sourceRoot, installedSuccessor) {
  const ordinary = bypassOrdinaryFunctionsSql(sourceRoot)
  if (!installedSuccessor.includes('\n'+ordinary.auth+'\n')) throw new Error('legacy_ordinary_auth_not_in_numbered_source')
  const blocks = ordinary.auth.split(/(?=^CREATE FUNCTION pg_temp\.legacy_bypass_predecessor_)/m).filter(Boolean)
  if (blocks.length !== 8 || ordinary.ordinarySignatures.length !== 8) throw new Error('legacy_ordinary_auth_roster_changed')
  const roster = ordinary.ordinarySignatures.map((signature, index) => {
    const block = blocks[index]
    const routine = signature.slice(0, signature.indexOf('('))
    const canonical = publicRoutines.includes(signature) ? defaultAcl
      : signature === 'application_native_task_review_current(uuid,uuid)' ? privateAcl : appAcl
    const legacy = canonical === defaultAcl ? historicalPublicAcl : canonical === appAcl ? historicalAppAcl : canonical
    const gate = 'actual.proacl IS DISTINCT FROM ' + canonical
    const delimiter = '\n DO $legacy_bypass_predecessor$'
    if (block.split(gate).length !== 2 || !block.includes(quote('public.' + signature)) || block.split(delimiter).length !== 2) {
      throw new Error('legacy_ordinary_auth_source_changed: ' + signature)
    }
    const declaration = block.split(delimiter)[0].replace(/^CREATE FUNCTION pg_temp\.legacy_bypass_predecessor_\d+/, 'CREATE FUNCTION public.' + routine)
    return { signature, declaration, historical: block.replace(gate, 'actual.proacl IS DISTINCT FROM ' + legacy), canonical, legacy }
  })
  const aclFacts = roster.map(item => `(${quote('public.'+item.signature)},${item.legacy})`).join(',\n   ')
  const app = roster.filter(item => item.canonical === appAcl).map(item => 'public.'+item.signature).join(', ')
  const policyValues = policies.map(([index, table, name, cmd, using, check]) =>
    `(old_routines[${index+1}],${quote('public.'+table)}::regclass,${quote(name)},${quote(cmd)},${quote(using)},${quote(check)})`).join(',\n   ')
  const slotValues = slots.map(slot => `(${slot.map(quote).join(',')})`).join(',')
  const policySql = (restore) => policies.map(([,table,name,,using,check]) =>
    `ALTER POLICY ${name} ON public.${table}${using === null ? '' : ` USING (${restore ? using : 'false'})`}${check === null ? '' : ` WITH CHECK (${restore ? check : 'false'})`};`).join('\n ')
  const publicDefinitions = publicRoutines.map(signature => roster.find(item => item.signature === signature).declaration)

  return `DO $legacy_ordinary_acl$
DECLARE item record; policy pg_policy; relation pg_class; routine oid;
 owner_role constant oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
 runtime_role constant oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 old_routines constant oid[]:=ARRAY[${publicRoutines.map(signature=>`to_regprocedure(${quote('public.'+signature)})::oid`).join(',')}];
 saved_policies oid[]:='{}'; checked_policies oid[]:='{}'; legacy_profile boolean; occupied boolean;
BEGIN
 IF EXISTS(SELECT 1 FROM public._migrations WHERE name='8298_legacy_bypass_retirement.sql') THEN
  EXECUTE ${sqlLiteral('installed',ordinary.successorAuth)};
  RETURN;
 END IF;
 SELECT bool_and(p.oid IS NOT NULL AND p.proacl IS NOT DISTINCT FROM reviewed.acl) INTO legacy_profile
 FROM (VALUES
   ${aclFacts}
 ) AS reviewed(signature,acl) LEFT JOIN pg_proc p ON p.oid=to_regprocedure(reviewed.signature);
 IF legacy_profile IS NOT TRUE THEN
  EXECUTE ${sqlLiteral('current',ordinary.auth)};
  RETURN;
 END IF;
 EXECUTE ${sqlLiteral('historic',roster.map(item=>item.historical).join('\n'))};

 -- Lock only the three tables whose six existing policies consume the old OIDs.
 LOCK TABLE public.crm_activities,public.workspace_compartments,public.workspace_groups IN ACCESS EXCLUSIVE MODE;
 FOR item IN SELECT * FROM (VALUES
   ${policyValues}
 ) AS reviewed(fn,relation,name,command,using_expr,check_expr) LOOP
  SELECT * INTO STRICT relation FROM pg_class WHERE oid=item.relation;
  SELECT * INTO policy FROM pg_policy WHERE polrelid=relation.oid AND polname=item.name;
  IF NOT relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relowner<>owner_role
   OR policy.oid IS NULL OR policy.polpermissive OR policy.polcmd::text<>item.command OR policy.polroles<>ARRAY[0::oid]
   OR pg_get_expr(policy.polqual,relation.oid) IS DISTINCT FROM item.using_expr
   OR pg_get_expr(policy.polwithcheck,relation.oid) IS DISTINCT FROM item.check_expr
   OR (SELECT count(*) FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=policy.oid
      AND d.objsubid=0 AND d.refclassid='pg_proc'::regclass AND d.refobjid=item.fn AND d.refobjsubid=0 AND d.deptype='n')
      <> (item.using_expr IS NOT NULL)::integer + (item.check_expr IS NOT NULL)::integer
  THEN RAISE EXCEPTION 'legacy_ordinary_acl_policy_changed: %',item.name;END IF;
  saved_policies:=array_append(saved_policies,policy.oid);
 END LOOP;

 IF (SELECT count(*) FROM pg_depend d WHERE d.refclassid='pg_proc'::regclass AND d.refobjid=ANY(old_routines))<>7
 THEN RAISE EXCEPTION 'legacy_ordinary_acl_unreviewed_inbound_dependency';END IF;
 FOR item IN SELECT * FROM (VALUES
  (old_routines[1],'pg_language'::regclass::oid,(SELECT oid FROM pg_language WHERE lanname='plpgsql')),
  (old_routines[2],'pg_type'::regclass::oid,'public.crm_activities'::regtype::oid)
 ) AS reviewed(fn,dependency_class,dependency) LOOP
  routine:=item.fn;
  IF (SELECT count(*) FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=routine)<>2
   OR NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=routine AND d.objsubid=0
     AND d.refclassid='pg_namespace'::regclass AND d.refobjid='public'::regnamespace AND d.refobjsubid=0 AND d.deptype='n')
   OR NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=routine AND d.objsubid=0
     AND d.refclassid=item.dependency_class AND d.refobjid=item.dependency AND d.refobjsubid=0 AND d.deptype='n')
   OR (SELECT count(*) FROM pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND d.classid='pg_proc'::regclass AND d.objid=routine)<>2
   OR (SELECT count(*) FROM pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND d.classid='pg_proc'::regclass AND d.objid=routine AND d.objsubid=0 AND d.refclassid='pg_authid'::regclass
        AND ((d.refobjid=owner_role AND d.deptype='o') OR (d.refobjid=runtime_role AND d.deptype='a')))<>2
  THEN RAISE EXCEPTION 'legacy_ordinary_acl_outbound_dependency_changed: %',routine::regprocedure;END IF;
 END LOOP;

 IF (SELECT count(*) FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
     WHERE c.relnamespace='public'::regnamespace AND c.relkind IN('r','p')
       AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='regprocedure'::regtype)<>4
 THEN RAISE EXCEPTION 'legacy_ordinary_acl_registry_shape_changed';END IF;
 FOR item IN SELECT * FROM (VALUES ${slotValues}) AS reviewed(relation_name,column_name) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
     WHERE c.oid=to_regclass('public.'||item.relation_name) AND a.attname=item.column_name
       AND a.attnum>0 AND NOT a.attisdropped AND a.atttypid='regprocedure'::regtype)
  THEN RAISE EXCEPTION 'legacy_ordinary_acl_registry_shape_changed';END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I::oid=ANY($1))',item.relation_name,item.column_name)
   INTO occupied USING old_routines;
  IF occupied THEN RAISE EXCEPTION 'legacy_ordinary_acl_registered_reference';END IF;
 END LOOP;

 -- Reorder only the previously authenticated, owner-issued app grants.
 REVOKE EXECUTE ON FUNCTION ${app} FROM app_user;
 GRANT EXECUTE ON FUNCTION ${app} TO app_user;

 -- No other session can observe the temporary deny predicates. Keep the
 -- policy OIDs so only their references to the two default-ACL routines change.
 ${policySql(false)}
 DROP FUNCTION ${publicRoutines.map(signature=>'public.'+signature).join(', ')} RESTRICT;
 ${publicDefinitions.join('\n ')}
 ${policySql(true)}
 FOR item IN SELECT * FROM (VALUES
   ${policyValues}
 ) AS reviewed(old_fn,relation,name,command,using_expr,check_expr) LOOP
  SELECT * INTO STRICT relation FROM pg_class WHERE oid=item.relation;
  SELECT * INTO STRICT policy FROM pg_policy WHERE polrelid=relation.oid AND polname=item.name;
  routine:=CASE WHEN item.old_fn=old_routines[1] THEN 'public.${department}'::regprocedure::oid
                ELSE 'public.${crm}'::regprocedure::oid END;
  IF NOT relation.relrowsecurity OR relation.relforcerowsecurity OR relation.relowner<>owner_role
   OR policy.polpermissive OR policy.polcmd::text<>item.command OR policy.polroles<>ARRAY[0::oid]
   OR pg_get_expr(policy.polqual,relation.oid) IS DISTINCT FROM item.using_expr
   OR pg_get_expr(policy.polwithcheck,relation.oid) IS DISTINCT FROM item.check_expr
   OR (SELECT count(*) FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=policy.oid
      AND d.objsubid=0 AND d.refclassid='pg_proc'::regclass AND d.refobjid=routine AND d.refobjsubid=0 AND d.deptype='n')
      <> (item.using_expr IS NOT NULL)::integer + (item.check_expr IS NOT NULL)::integer
  THEN RAISE EXCEPTION 'legacy_ordinary_acl_rebind_changed: %',item.name;END IF;
  checked_policies:=array_append(checked_policies,policy.oid);
 END LOOP;
 IF checked_policies IS DISTINCT FROM saved_policies
 THEN RAISE EXCEPTION 'legacy_ordinary_acl_policy_identity_changed';END IF;

 EXECUTE ${sqlLiteral('repaired',ordinary.auth)};
END $legacy_ordinary_acl$;`
}
