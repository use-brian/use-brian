-- [COMP:api/application-persistence] One native acquisition, explicit family adapters.
CREATE OR REPLACE FUNCTION read_native_session_field_snapshots(w uuid,ids uuid[],versions text[])
RETURNS TABLE(ord integer,snapshot jsonb) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $body$
DECLARE roots jsonb;memo jsonb;context jsonb;policy_revision jsonb;entry record;owner_login boolean;
BEGIN
 IF ids IS NULL OR versions IS NULL OR cardinality(ids) NOT BETWEEN 1 AND 4096 OR cardinality(ids)<>cardinality(versions)
  OR array_position(ids,NULL) IS NOT NULL OR array_position(versions,NULL) IS NOT NULL
  OR array_ndims(ids)<>1 OR array_lower(ids,1)<>1 OR array_ndims(versions)<>1 OR array_lower(versions,1)<>1
 THEN RAISE EXCEPTION 'scope_evidence_missing' USING ERRCODE='22023';END IF;
 SELECT EXISTS(SELECT 1 FROM pg_roles login JOIN pg_class owned ON owned.oid='public.session_messages'::regclass
  WHERE login.rolname=session_user AND(login.rolsuper OR login.rolbypassrls OR pg_has_role(login.oid,owned.relowner,'USAGE')))
 INTO owner_login;
 SELECT coalesce(jsonb_agg(root),'[]') INTO roots FROM (
  SELECT DISTINCT jsonb_build_object('kind','application_field','id',input.id,'version',input.version) root
  FROM unnest(ids,versions) input(id,version) JOIN application_field_resources f ON f.workspace_id=w AND f.id=input.id
  WHERE f.origin='{"kind":"native","moduleKey":"native"}' AND f.type_key IN('session_message','session_message_annotation')
 ) native;
 IF roots<>'[]' AND NOT owner_login THEN
  IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  context:=native_turn_context();
  SELECT jsonb_build_array(c.revision,p.revision) INTO policy_revision
  FROM application_policy_contract_epoch c CROSS JOIN application_policy_workspace_epochs p
  WHERE c.singleton AND p.workspace_id=w;
 IF NOT FOUND THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  memo:=conversation_dag(w,roots,'[]');
 END IF;
 FOR entry IN SELECT input.*,f.origin,f.type_key FROM unnest(ids,versions) WITH ORDINALITY input(id,version,position)
  LEFT JOIN application_field_resources f ON f.workspace_id=w AND f.id=input.id ORDER BY input.position LOOP
  IF entry.origin='{"kind":"native","moduleKey":"native"}'::jsonb AND entry.type_key IN('session_message','session_message_annotation') THEN
   snapshot:=coalesce(nullif(memo#>ARRAY['field:'||entry.id||':'||entry.version,'value'],'null'::jsonb),'{"held":true}'::jsonb);
  ELSE
   snapshot:=read_admitted_application_field_snapshot(w,entry.id,entry.version);
  END IF;
  ord:=entry.position;RETURN NEXT;
 END LOOP;
 -- PL/pgSQL buffers SETOF results: no row escapes before this final fence.
 IF memo IS NOT NULL AND (native_turn_helpers_current() IS NOT TRUE OR native_turn_context() IS DISTINCT FROM context
  OR policy_revision IS DISTINCT FROM (SELECT jsonb_build_array(c.revision,p.revision) FROM application_policy_contract_epoch c
   CROSS JOIN application_policy_workspace_epochs p WHERE c.singleton AND p.workspace_id=w)
  OR clock_timestamp()>=(memo->>'validUntil')::timestamptz)
 THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
END $body$;
