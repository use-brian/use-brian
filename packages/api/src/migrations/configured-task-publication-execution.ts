/** Historical predecessor compatibility for immutable 8296. [COMP:api/migration-execution-sql] */
import { historicalFunctionExecuteAcl } from './historical-function-acl.js'

export function configuredTaskPublicationExecutionSql(sql: string): string {
  const members = [
    { signature: 'application_recheck_native_task_sources()', acl: "ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]", publicGrant: false },
    { signature: 'check_programmatic_publication_commit()', acl: 'NULL', publicGrant: true },
  ] as const
  for (const [index, member] of members.entries()) {
    const tag = `$c8296_pre_member_${index}$`
    const start = sql.indexOf(`DO ${tag} `)
    const endTag = `END ${tag};`
    const end = sql.indexOf(endTag, start) + endTag.length
    if (start < 0 || end < start || sql.indexOf(`DO ${tag} `, start + 1) >= 0) {
      throw new Error('8296: unexpected historical predecessor block')
    }
    const block = sql.slice(start, end)
    const expected = `  OR actual.proacl IS DISTINCT FROM ${member.acl}\n`
    if (!block.includes(`to_regprocedure('public.${member.signature}')`) || block.split(expected).length !== 2) {
      throw new Error('8296: unexpected historical predecessor ACL check')
    }
    const older = historicalFunctionExecuteAcl("(SELECT oid FROM pg_roles WHERE rolname='app_user')", member.publicGrant)
    sql = sql.slice(0, start)
      + block.replace(expected, `  OR (actual.proacl IS DISTINCT FROM ${member.acl} AND actual.proacl IS DISTINCT FROM ${older})\n`)
      + sql.slice(end)
  }

  const boundary = 'END $c8296_pre_member_1$;'
  if (sql.split(boundary).length !== 2) throw new Error('8296: unexpected historical ACL boundary')
  // Both unchanged original metadata and pin guards have passed. The original
  // migration will revoke the second helper's application/PUBLIC privileges.
  return sql.replace(boundary, () => `${boundary}
DO $c8296_legacy_source_acl$
DECLARE
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 owner_grant aclitem:=makeaclitem(owner_id,owner_id,'EXECUTE',false);
 task_before pg_proc; task_after pg_proc; intake pg_proc;
BEGIN
 SELECT * INTO STRICT task_before FROM pg_proc
  WHERE oid='public.application_recheck_native_task_sources()'::regprocedure;
 SELECT * INTO STRICT intake FROM pg_proc
  WHERE oid='public.check_programmatic_publication_commit()'::regprocedure;
 IF task_before.proacl IS NOT DISTINCT FROM ARRAY[owner_grant] AND intake.proacl IS NULL THEN RETURN;END IF;
 IF current_user::regrole::oid<>owner_id OR runtime_id IS NULL OR runtime_id=owner_id
  OR task_before.proacl IS DISTINCT FROM ${historicalFunctionExecuteAcl('runtime_id', false)}
  OR intake.proacl IS DISTINCT FROM ${historicalFunctionExecuteAcl('runtime_id', true)}
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='81110_legacy_function_execute_privileges.sql')
  OR EXISTS(SELECT 1 FROM pg_default_acl WHERE defaclrole=owner_id AND defaclobjtype='f'
    AND defaclnamespace IN(0,'public'::regnamespace))
  OR EXISTS(SELECT 1 FROM public.native_retained_contract_helpers WHERE signature IN
    ('application_recheck_native_task_sources()','check_programmatic_publication_commit()'))
 THEN RAISE EXCEPTION 'configured_task_unverified_historical_source_acl';END IF;
 IF (SELECT count(*) FROM pg_depend d WHERE d.refclassid='pg_proc'::regclass
      AND d.refobjid IN(task_before.oid,intake.oid))<>3
  OR (SELECT count(*) FROM pg_depend d JOIN pg_trigger t ON t.oid=d.objid
      WHERE d.refclassid='pg_proc'::regclass AND d.classid='pg_trigger'::regclass AND d.refobjid=t.tgfoid
        AND d.deptype='n' AND d.objsubid=0 AND d.refobjsubid=0
        AND t.tgconstraint<>0 AND t.tgdeferrable AND t.tginitdeferred AND NOT t.tgisinternal
        AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
        AND ((t.tgfoid=task_before.oid AND t.tgrelid='public.tasks'::regclass
              AND t.tgname='application_native_task_source_commit' AND t.tgtype=21)
          OR (t.tgfoid=intake.oid AND t.tgrelid='public.episodes'::regclass
              AND t.tgname='programmatic_episode_commit' AND t.tgtype=5)
          OR (t.tgfoid=intake.oid AND t.tgrelid='public.pending_ingest_batches'::regclass
              AND t.tgname='programmatic_batch_commit' AND t.tgtype=17)))<>3
 THEN RAISE EXCEPTION 'configured_task_unverified_historical_source_dependencies';END IF;
 REVOKE EXECUTE ON FUNCTION public.application_recheck_native_task_sources() FROM app_user;
 SELECT * INTO STRICT task_after FROM pg_proc WHERE oid=task_before.oid;
 IF to_jsonb(task_before)-'proacl' IS DISTINCT FROM to_jsonb(task_after)-'proacl'
  OR task_after.proacl IS DISTINCT FROM ARRAY[owner_grant]
  OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid<>task_after.oid AND (
    strpos(p.prosrc,encode(sha256(convert_to(to_jsonb(task_after)::text,'UTF8')),'hex'))>0
    OR strpos(p.prosrc,encode(sha256(convert_to(ROW(
      task_after.oid,task_after.proname,task_after.pronamespace,task_after.proowner,task_after.prolang,
      task_after.procost,task_after.prorows,task_after.provariadic,task_after.prosupport,task_after.prokind,
      task_after.prosecdef,task_after.proleakproof,task_after.proisstrict,task_after.proretset,task_after.provolatile,
      task_after.proparallel,task_after.pronargs,task_after.pronargdefaults,task_after.prorettype,task_after.proargtypes,
      task_after.proallargtypes,task_after.proargmodes,task_after.proargnames,task_after.proargdefaults::text,
      task_after.protrftypes,task_after.prosrc,task_after.probin,task_after.prosqlbody::text,task_after.proconfig,task_after.proacl
    )::public.native_executable_contract_v1::text,'UTF8')),'hex'))>0))
 THEN RAISE EXCEPTION 'configured_task_historical_source_acl_changed';END IF;
END $c8296_legacy_source_acl$;`)
}
