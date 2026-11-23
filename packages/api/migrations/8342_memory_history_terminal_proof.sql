BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;

-- [COMP:corrections/row-history] Admit the bounded physical chain as a set.
-- Receipt, hold, role and independent ancestry proof remain canonical.
DO $history_terminal$
DECLARE
 member_signature constant text:='application_memory_history_status(uuid,uuid,text)';
 helper constant regprocedure:='public.application_memory_history_status(uuid,uuid,text)'::regprocedure;
 original pg_proc;
 changed text;
BEGIN
 LOCK TABLE public.native_turn_contract_helpers IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT original FROM pg_catalog.pg_proc WHERE oid=helper;
 IF public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
  OR encode(sha256(convert_to(original.prosrc,'UTF8')),'hex')<>'129079ae5b1096a988366358b0a45ca0d8da8102361a3df8e25d48d0e510c6ce'
  OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=member_signature
    AND (h.contract).oid=helper::oid AND (h.contract).prosrc=original.prosrc)
 THEN RAISE EXCEPTION 'memory_history_terminal_predecessor_changed';END IF;

 changed:=replace(original.prosrc,$before$ids uuid[]:=ARRAY[i];seen uuid[]:='{}';pending uuid;parents uuid[];forward_seen uuid[];cursor_id uuid;$before$,$after$seen uuid[];physical boolean;$after$);
 changed:=replace(changed,$before$ WHILE cardinality(ids)>0 LOOP
  pending:=ids[1];ids:=ids[2:];IF pending=ANY(seen) THEN CONTINUE;END IF;
  seen:=array_append(seen,pending);IF cardinality(seen)>100 THEN RETURN NULL;END IF;
  SELECT * INTO row_value FROM memories WHERE id=pending;
  IF NOT FOUND OR row_value.workspace_id IS DISTINCT FROM w THEN RETURN NULL;END IF;
  SELECT array_agg(id ORDER BY id) INTO parents FROM memories WHERE workspace_id=w AND superseded_by=pending;
  IF cardinality(parents)>1 THEN RETURN NULL;END IF;
  ids:=ids||coalesce(parents,'{}');
  IF row_value.superseded_by IS NOT NULL THEN
   IF row_value.valid_to IS NULL THEN RETURN NULL;END IF;
   ids:=array_append(ids,row_value.superseded_by);
  END IF;
  chain:=chain||jsonb_build_array(jsonb_build_object('id',row_value.id,'version',row_value.scope_version::text,
   'held',row_value.scope_held,'validTo',row_value.valid_to,'supersededBy',row_value.superseded_by,
   'retractedAt',row_value.retracted_at,'retractedBy',row_value.retracted_by,
   'scope',jsonb_build_object('workspaceId',w,'userId',row_value.user_id,'assistantId',row_value.assistant_id,
    'sensitivity',row_value.sensitivity,'compartments',row_value.compartments,'projectIds',row_value.project_ids)));
 END LOOP;$before$,$after$ -- The complete bounded component has at most one parent per row.
 -- With one successor per row it is a path or a cycle; a path has one end.
 WITH RECURSIVE component(id) AS (
  SELECT i
  UNION
  SELECT edge.id FROM component member
  JOIN public.memories m ON m.id=member.id AND m.workspace_id=w
  CROSS JOIN LATERAL (
   SELECT m.superseded_by AS id WHERE m.superseded_by IS NOT NULL
   UNION ALL
   SELECT parent.id FROM public.memories parent WHERE parent.workspace_id=w AND parent.superseded_by=member.id
  ) edge
 ), bounded AS MATERIALIZED (SELECT id FROM component LIMIT 101)
 SELECT array_agg(b.id),
  count(*)<=100 AND count(m.id)=count(*) AND count(*) FILTER(WHERE m.superseded_by IS NULL)=1
   AND count(m.superseded_by)=count(DISTINCT m.superseded_by)
   AND bool_and((m.superseded_by IS NULL OR m.valid_to IS NOT NULL)
    AND (b.id<>i OR m.scope_version::text=v)),
  jsonb_agg(jsonb_build_object('id',m.id,'version',m.scope_version::text,'held',m.scope_held,
   'validTo',m.valid_to,'supersededBy',m.superseded_by,'retractedAt',m.retracted_at,'retractedBy',m.retracted_by,
   'scope',jsonb_build_object('workspaceId',w,'userId',m.user_id,'assistantId',m.assistant_id,
    'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids)) ORDER BY m.id::text)
 INTO seen,physical,chain FROM bounded b LEFT JOIN public.memories m ON m.id=b.id AND m.workspace_id=w;
 IF physical IS NOT TRUE THEN RETURN NULL;END IF;$after$);
 changed:=replace(changed,$before$ FOR entry IN SELECT value FROM jsonb_array_elements(chain) ORDER BY value->>'id' LOOP$before$,$after$ -- A legacy component without protected provenance has no transition, receipt
 -- or independent roots. Keep the same proof and check all current holds.
 IF NOT protected THEN
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(chain) saved(value)
   LEFT JOIN public.memories m ON m.workspace_id=w AND m.id=(saved.value->>'id')::uuid
   WHERE m.id IS NULL OR m.scope_held OR m.retracted_at IS NOT NULL
    OR (m.superseded_by IS NULL) IS DISTINCT FROM (m.valid_to IS NULL)
    OR m.superseded_by::text IS DISTINCT FROM saved.value->>'supersededBy'
    OR m.scope_version::text IS DISTINCT FROM saved.value->>'version'
    OR m.source_session_id IS NOT NULL OR m.source_episode_id IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.scope_resource_states s
     WHERE s.resource_kind='memory' AND s.resource_id=m.id AND s.review_state='held'))
   OR EXISTS(SELECT 1 FROM public.scope_derivations d WHERE d.workspace_id=w AND d.resource_kind='memory' AND d.resource_id=ANY(seen))
   OR EXISTS(SELECT 1 FROM public.native_memory_successor_transitions t
    WHERE t.workspace_id=w AND (t.predecessor_id=ANY(seen) OR t.successor_id=ANY(seen)))
   OR EXISTS(SELECT 1 FROM public.correction_audit a WHERE a.workspace_id=w AND a.row_id=ANY(seen) AND a.native_memory_transition IS NOT NULL)
   THEN RETURN NULL;END IF;
  SELECT jsonb_agg(anchor ORDER BY anchor::text) INTO anchors FROM (
   SELECT jsonb_build_object('kind','memory','id',value->'id','version',value->'version') AS anchor
   FROM jsonb_array_elements(chain)) inherited;
  RETURN jsonb_build_object('kind','native-memory-history-status-v1','workspaceId',w,'id',i,'version',v,'protected',false,
   'chain',chain,'transitions','[]'::jsonb,'retirements','[]'::jsonb,'receipts','[]'::jsonb,'anchors',anchors,'ownFields','[]'::jsonb,
   'qualifiedAnchors',anchors,'independentRoots','[]'::jsonb,'independentNodes','[]'::jsonb,'roots','[]'::jsonb);
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(chain) ORDER BY value->>'id' LOOP$after$);
 changed:=replace(changed,$before$  cursor_id:=row_value.id;forward_seen:='{}';
  LOOP
   IF cursor_id=ANY(forward_seen) THEN RETURN NULL;END IF;
   forward_seen:=array_append(forward_seen,cursor_id);
   SELECT superseded_by INTO cursor_id FROM memories WHERE workspace_id=w AND id=cursor_id;
   IF NOT FOUND THEN RETURN NULL;END IF;EXIT WHEN cursor_id IS NULL;
  END LOOP;$before$,$after$  IF NOT FOUND OR row_value.superseded_by::text IS DISTINCT FROM entry->>'supersededBy' THEN RETURN NULL;END IF;$after$);
 IF encode(sha256(convert_to(changed,'UTF8')),'hex')<>'1013c73163439f258f2d6fbd943d958c2e8b032f99095c257371c5d095e158af'
 THEN RAISE EXCEPTION 'memory_history_terminal_successor_changed';END IF;

 EXECUTE replace(pg_get_functiondef(helper),original.prosrc,changed);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_catalog.pg_proc p WHERE p.oid=helper) IS DISTINCT FROM to_jsonb(original)-'prosrc'
 THEN RAISE EXCEPTION 'memory_history_terminal_metadata_changed';END IF;
 UPDATE public.native_turn_contract_helpers h
 SET contract=jsonb_populate_record(h.contract,jsonb_build_object('prosrc',changed))
 WHERE h.signature=member_signature;
 IF NOT FOUND OR public.native_turn_contract_witness_refresh() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'memory_history_terminal_witness_changed';END IF;
END $history_terminal$;

COMMIT;
