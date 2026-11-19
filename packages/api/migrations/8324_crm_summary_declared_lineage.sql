-- [COMP:crm/r2-store] Declared native lineage and retained host ceilings.
-- Translate an explicitly retained typed CRM observation into existing
-- canonical field lineage at the writer boundary, using the captured ceiling.
BEGIN;
CREATE FUNCTION public.materialize_crm_summary_native_evidence(w uuid,packet jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE retained jsonb;
DECLARE d public.crm_summary_source_descriptors;
DECLARE raw_previous text:=coalesce(current_setting('app.native_query_data_ceilings',true),'');
DECLARE stack jsonb:=coalesce(nullif(raw_previous,'')::jsonb,'[]');
DECLARE ceiling jsonb;
DECLARE k text;
DECLARE fields text[];
DECLARE observation jsonb;
DECLARE actual jsonb;
DECLARE original_ids jsonb;
DECLARE reenclosed jsonb;
DECLARE result jsonb:='[]';
BEGIN
  IF jsonb_typeof(stack) IS DISTINCT FROM 'array' OR jsonb_array_length(stack)>15 THEN RETURN NULL; END IF;
  retained:=public.retain_crm_summary_certificate(w,packet);
  IF retained IS NULL THEN RETURN NULL; END IF;
  SELECT q.* INTO d FROM public.crm_summary_source_descriptors q
    WHERE q.workspace_id=w AND q.id=(retained->0->>'resourceId')::uuid;
  IF NOT FOUND OR d.permission_mode NOT IN('legacy','department_v2') THEN RETURN NULL; END IF;
  FOREACH k IN ARRAY ARRAY['company','deal','person'] LOOP
    fields:=ARRAY(SELECT jsonb_array_elements_text(d.selected_fields->k) ORDER BY 1);
    ceiling:=jsonb_build_object('workspaceId',w,'typeKey',k,'ids',NULL,'tier',3,'compartments',NULL,
      'projectIds',NULL,'departmentRead',d.original_selector,
      'privateUserId',d.original_visibility->'userId','assistants',d.original_visibility->'assistants');
    PERFORM set_config('app.native_query_data_ceilings',(stack||jsonb_build_array(ceiling))::text,true);
    observation:=public.observe_native_application_query_domain(w,k,fields,fields);
    IF observation IS NULL THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_array(l.entity_id,l.record_version::text) ORDER BY l.entity_id),'[]')
      INTO original_ids
    FROM jsonb_array_elements(d.candidate_sets->k) AS e(group_epoch)
    JOIN public.crm_summary_partition_leaves l ON l.workspace_id=w AND l.kind=k
      AND l.scope_class_id=(e.group_epoch->>0)::uuid
      AND l.visible_from<=(e.group_epoch->>1)::bigint
      AND (l.visible_until IS NULL OR l.visible_until>(e.group_epoch->>1)::bigint);

    WITH rows AS MATERIALIZED (
      SELECT c.id,c.record_version,c.sources FROM public.read_native_application_query_candidates(w,k,fields,
        (observation#>>'{sources,0,resourceId}')::uuid,observation#>>'{sources,0,version}') c
    )
    SELECT coalesce(jsonb_agg(jsonb_build_array(r.id,r.record_version) ORDER BY r.id),'[]'),
      (SELECT coalesce(jsonb_agg(s.source),'[]') FROM rows x CROSS JOIN LATERAL jsonb_array_elements(x.sources) s(source))
      INTO actual,reenclosed FROM rows r;
    IF actual IS DISTINCT FROM original_ids THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
    result:=result||(observation->'sources')||reenclosed;
  END LOOP;
  PERFORM set_config('app.native_query_data_ceilings',raw_previous,true);
  IF public.crm_summary_replay_prepared_descriptor(w,d) IS NULL THEN
    RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT jsonb_agg(s.source ORDER BY s.source->>'resourceKind',s.source->>'resourceId',s.source->>'version')
    FROM (SELECT DISTINCT source FROM jsonb_array_elements(result) x(source)) s);
END $$;
REVOKE ALL ON FUNCTION public.materialize_crm_summary_native_evidence(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.materialize_crm_summary_native_evidence(uuid,jsonb) TO app_user;
CREATE OR REPLACE FUNCTION public.crm_summary_capture_initial_principal(w uuid,actor uuid,at_time timestamptz,reflector_tier integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE stamp jsonb:=public.crm_summary_initial_principal_stamp(w,actor);
DECLARE settings jsonb:=stamp->'settings';
DECLARE v2 boolean:=stamp->>'departmentReadV2'='true';
DECLARE assistant uuid:=(settings->>'v2Assistant')::uuid;
DECLARE role_key text:=stamp->>'role';
DECLARE member_tier int:=public.sensitivity_rank(CASE WHEN role_key IN('owner','admin') THEN 'confidential' ELSE stamp->>'clearance' END);
DECLARE bound_tier int:=CASE WHEN v2 THEN 3 ELSE coalesce(reflector_tier,3) END;
DECLARE legacy_ceiling boolean:=settings->>'clearance' IS NOT NULL AND (NOT v2 OR settings->>'v2Active'='false' AND assistant IS NULL);
DECLARE original_labels jsonb:=coalesce((settings->>'compartments')::jsonb,'null');
DECLARE allowed_labels jsonb;
DECLARE projects jsonb:=coalesce((settings->>'projects')::jsonb,'null');
DECLARE assistants jsonb:=coalesce((settings->>'assistants')::jsonb,'null');
DECLARE binding jsonb:=coalesce((settings->>'v2Binding')::jsonb,'null');
DECLARE context_department text:=settings->>'v2Department';
DECLARE base text[];
DECLARE departments jsonb;
DECLARE project_labels jsonb;
DECLARE other_labels jsonb;
DECLARE next_change timestamptz;
DECLARE department_expiry timestamptz;
DECLARE project_expiry timestamptz;
DECLARE scope jsonb;
DECLARE host_ceiling jsonb:=nullif(current_setting('app.crm_summary_host_ceiling',true),'')::jsonb;
BEGIN
  IF stamp IS NULL OR at_time IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(assistants) NOT IN ('array','null') OR jsonb_typeof(projects) NOT IN ('array','null') THEN RETURN NULL; END IF;
  IF legacy_ceiling THEN
    bound_tier:=least(bound_tier,public.sensitivity_rank(settings->>'clearance'));
    IF bound_tier IS NULL THEN RETURN NULL; END IF;
  END IF;
  IF NOT v2 THEN
    IF role_key NOT IN('owner','admin') THEN
      IF stamp->>'teamScopeMode'='legacy' THEN
        IF stamp->'compartments'<>'null' THEN
          base:=ARRAY(SELECT jsonb_array_elements_text(stamp->'compartments'));
        END IF;
      ELSE
        base:=public.effective_member_team_compartments(actor,w);
      END IF;
    END IF;
    IF base IS NOT NULL THEN
      -- Identical labels with adjacent or overlapping grants have one frontier.
      -- Ignore timelines already admitted through fixed membership or excluded
      -- by this execution's label ceiling.
      WITH beneficiary(kind,id) AS (
        SELECT 'member',actor UNION ALL
        SELECT 'team',g.id FROM public.workspace_group_members m JOIN public.workspace_groups g ON g.id=m.group_id
        WHERE m.user_id=actor AND g.workspace_id=w AND g.status='active'
      ), windows AS (
        SELECT t.compartment_key AS label,range_agg(tstzrange(g.starts_at,g.expires_at,'[)')) AS spans
        FROM beneficiary b JOIN public.workspace_access_grants g ON g.workspace_id=w AND g.beneficiary_kind=b.kind AND g.beneficiary_id=b.id
        JOIN public.workspace_groups t ON t.id=g.target_team_id AND t.workspace_id=w AND t.status='active'
        WHERE g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>at_time)
          AND NOT coalesce(t.compartment_key=ANY(base),false)
          AND (original_labels='null' OR original_labels ? t.compartment_key)
        GROUP BY t.compartment_key
      ), active_or_future AS (
        SELECT label,span@>at_time AS active,
          CASE WHEN span@>at_time THEN upper(span) ELSE lower(span) END AS transition
        FROM windows CROSS JOIN LATERAL unnest(spans) AS span
        WHERE span@>at_time OR lower(span)>at_time
      ) SELECT ARRAY(SELECT unnest(base) UNION SELECT label FROM active_or_future WHERE active),
        (SELECT min(transition) FROM active_or_future WHERE transition<'infinity')
      INTO base,next_change;
    END IF;
    allowed_labels:=public.application_query_set_intersection(coalesce(to_jsonb(base),'null'),original_labels);
    scope:=public.application_normalize_native_query_bounds(jsonb_build_object('kind','native_legacy',
      'tier',least(member_tier,bound_tier),'compartments',allowed_labels,'projectIds',projects));
    -- The original workflow treats malformed compartment grants as denying all rows.
    IF public.agent_scope_grant_allows('app.agent_compartments','{}') IS NOT TRUE THEN RETURN NULL; END IF;
  ELSE
    allowed_labels:=CASE WHEN legacy_ceiling THEN coalesce((settings->>'compartments')::jsonb,'[]') ELSE 'null' END;
    IF jsonb_typeof(allowed_labels) NOT IN('array','null') OR jsonb_typeof(binding) NOT IN('array','null')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN allowed_labels='null' THEN '[]' ELSE allowed_labels END) i WHERE jsonb_typeof(i)<>'string')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN binding='null' THEN '[]' ELSE binding END) i WHERE jsonb_typeof(i)<>'string') THEN RETURN NULL; END IF;
    bound_tier:=least(bound_tier,CASE WHEN settings->>'v2Cap' IS NULL THEN 3 ELSE coalesce(public.sensitivity_rank(settings->>'v2Cap'),0) END);
    IF assistant IS NOT NULL THEN
      member_tier:=least(member_tier,coalesce((SELECT public.sensitivity_rank(a.clearance) FROM public.assistants a WHERE a.id=assistant AND a.workspace_id=w),0));
    END IF;
    SELECT coalesce(jsonb_object_agg(e.department_id,least(public.sensitivity_rank(e.clearance),bound_tier,
             CASE WHEN assistant IS NULL THEN 3 ELSE public.sensitivity_rank(a.clearance) END)),'{}'),
           min(least(nullif(e.expires_at,'infinity'),nullif(a.expires_at,'infinity')))
      INTO departments,department_expiry
    FROM public.department_edges e LEFT JOIN public.department_edges a ON a.department_id=e.department_id AND a.assistant_id=assistant
      AND (a.expires_at IS NULL OR a.expires_at>at_time)
    WHERE e.workspace_id=w AND e.user_id=actor AND (e.expires_at IS NULL OR e.expires_at>at_time)
      AND (assistant IS NULL OR a.id IS NOT NULL) AND bound_tier>0
      AND (binding='null' OR binding ? e.department_id::text)
      AND (allowed_labels='null' OR allowed_labels ? ('team:'||e.department_id::text));
    project_labels:='[]';
    IF stamp->>'projectSharedSpaces'='true' THEN
      SELECT coalesce(jsonb_agg(s.project_id::text ORDER BY s.project_id),'[]'),
             min(least(CASE WHEN role_key<>'owner' THEN nullif(h.expires_at,'infinity') END,nullif(a.expires_at,'infinity')))
        INTO project_labels,project_expiry
      FROM public.project_shared_scopes s
      LEFT JOIN public.project_shared_members h ON h.project_id=s.project_id AND h.user_id=actor AND (h.expires_at IS NULL OR h.expires_at>at_time)
      LEFT JOIN public.project_shared_members a ON a.project_id=s.project_id AND a.assistant_id=assistant AND (a.expires_at IS NULL OR a.expires_at>at_time)
      WHERE s.workspace_id=w AND s.status='active' AND (role_key='owner' OR h.id IS NOT NULL)
        AND (assistant IS NULL OR a.id IS NOT NULL) AND (binding='null' OR binding ? s.project_id::text)
        AND (allowed_labels='null' OR allowed_labels ? ('project:'||s.project_id::text));
    END IF;
    other_labels:='null';
    IF allowed_labels<>'null' THEN
      SELECT coalesce(jsonb_agg(value ORDER BY value),'[]') INTO other_labels FROM (
        SELECT DISTINCT value FROM jsonb_array_elements(allowed_labels)
        WHERE value#>>'{}' NOT LIKE 'team:%' AND value#>>'{}' NOT LIKE 'project:%'
      ) labels;
    END IF;
    scope:=jsonb_build_object('kind','native_department_v2','tier',least(member_tier,bound_tier),
      'departments',departments,'contextDepartment',context_department,'projectLabels',project_labels,'otherLabels',other_labels,'projectIds',projects);
    next_change:=least(department_expiry,project_expiry);
  END IF;
  IF host_ceiling IS NOT NULL THEN
    IF public.application_query_scope_valid(host_ceiling) IS NOT TRUE THEN RETURN NULL; END IF;
    scope:=public.application_query_scope_intersection(scope,host_ceiling);
  END IF;
  IF public.application_query_scope_valid(scope) IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('mode',CASE WHEN v2 THEN 'department_v2' ELSE 'legacy' END,
    'nativeBounds',scope,'visibility',jsonb_build_object('userId',CASE WHEN settings->>'shared'='false' THEN actor END,'assistants',assistants),
    'principalStamp',stamp,'nextChange',next_change);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.crm_summary_capture_initial_principal(uuid,uuid,timestamptz,integer) FROM PUBLIC,app_user;


COMMIT;
