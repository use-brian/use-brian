-- Evidence projection only. No work, CRM terms, communications or schedules.
-- Spec: docs/architecture/features/client-delivery-oversight.md
-- [COMP:api/crm-delivery-oversight]
BEGIN;
CREATE TABLE crm_delivery_commitments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 candidate_key text NOT NULL CHECK(length(candidate_key) BETWEEN 1 AND 160),
 source_kind text NOT NULL CHECK(source_kind IN('episode','session_message','entity','file_segment')),
 source_id uuid NOT NULL, source_revision text NOT NULL, source_selector jsonb NOT NULL,
 outcome text NOT NULL CHECK(length(outcome) BETWEEN 1 AND 2000), due_date date,
 company_id uuid, deal_id uuid, task_ids uuid[] NOT NULL DEFAULT '{}', goal_ids uuid[] NOT NULL DEFAULT '{}',
 agreeing_user_id uuid, recognition_state text NOT NULL CHECK(recognition_state IN('recognised','needs_review','dismissed','superseded')),
 recognition_reason text NOT NULL, origin_chat_id uuid,
 user_id uuid, assistant_id uuid, sensitivity text NOT NULL, compartments text[] NOT NULL, project_ids uuid[] NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,source_kind,source_id,source_revision,candidate_key),
 CHECK(cardinality(task_ids)<=20 AND cardinality(goal_ids)<=20)
);
CREATE TABLE crm_delivery_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 commitment_id uuid NOT NULL, source_kind text NOT NULL CHECK(source_kind IN('episode','session_message','entity','file_segment')),
 source_id uuid NOT NULL, source_revision text NOT NULL, source_selector jsonb NOT NULL,
 kind text NOT NULL CHECK(kind IN('observed_fact','human_report','coverage_gap','conflict')),
 claim text NOT NULL CHECK(claim IN('progress','outcome_delivered','completed','delay','blocker','unknown')),
 statement text NOT NULL CHECK(length(statement) BETWEEN 1 AND 2000), work_id uuid, reporter_user_id uuid,
 occurred_at timestamptz NOT NULL, read_at timestamptz NOT NULL DEFAULT now(), withdrawn_at timestamptz,
 user_id uuid, assistant_id uuid, sensitivity text NOT NULL, compartments text[] NOT NULL, project_ids uuid[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,commitment_id) REFERENCES crm_delivery_commitments(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE crm_delivery_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, commitment_id uuid NOT NULL,
 version integer NOT NULL, operation_id uuid NOT NULL, action text NOT NULL,
 actor_kind text NOT NULL, actor_id text NOT NULL, reason text, source_revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(workspace_id,commitment_id) REFERENCES crm_delivery_commitments(workspace_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,commitment_id,version)
);
CREATE INDEX crm_delivery_pickup ON crm_delivery_commitments(workspace_id,created_at,id);
CREATE INDEX crm_delivery_evidence ON crm_delivery_observations(workspace_id,commitment_id,created_at,id);

-- Closed native provenance traversal. This reads metadata for security only,
-- never expands model retrieval. Cycle-safe UNION also includes native parents.
CREATE FUNCTION crm_delivery_operational_source(w uuid,k text,i uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE ancestry(kind,id) AS (
  SELECT k,i UNION
  SELECT parent.kind,parent.id FROM ancestry a CROSS JOIN LATERAL (
   SELECT s.source_kind AS kind,s.source_id AS id FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id
    WHERE d.workspace_id=w AND d.resource_kind=a.kind AND d.resource_id=a.id
   UNION ALL SELECT 'workspace_file',f.file_id FROM file_segments f WHERE a.kind='file_segment' AND f.workspace_id=w AND f.id=a.id
   UNION ALL SELECT 'episode',e.parent_episode_id FROM episodes e WHERE a.kind='episode' AND e.workspace_id=w AND e.id=a.id AND e.parent_episode_id IS NOT NULL
   UNION ALL SELECT 'workspace_file',f.id FROM episodes e JOIN workspace_files f ON f.workspace_id=e.workspace_id
    AND (f.id::text IN(e.content_ref->>'fileId',e.content_ref->>'file_id',e.source_ref->>'fileId',e.source_ref->>'file_id'))
    WHERE a.kind='episode' AND e.workspace_id=w AND e.id=a.id
  ) parent
 ) SELECT NOT EXISTS(SELECT 1 FROM ancestry a JOIN workspace_files f ON a.kind='workspace_file' AND f.id=a.id AND f.workspace_id=w WHERE f.purpose='engineering_archive')
 AND NOT EXISTS(SELECT 1 FROM ancestry a JOIN episodes e ON a.kind='episode' AND e.id=a.id AND e.workspace_id=w
  WHERE e.source_kind IN('code_history','engineering_history','engineering_archive') OR e.source_ref->>'processingPurpose'='archive_only');
$$;
REVOKE ALL ON FUNCTION crm_delivery_operational_source(uuid,text,uuid) FROM PUBLIC;

-- Private owner-side snapshot. Returned content is consumed only after current
-- member/agent and destination audience admission, never as a public function.
CREATE FUNCTION crm_delivery_source_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; s jsonb; body text; author uuid; role_name text='unknown'; origin uuid; occurred timestamptz; decision jsonb;
BEGIN
 IF k NOT IN('episode','session_message','entity','file_segment') OR NOT crm_delivery_operational_source(w,k,i) THEN RETURN NULL; END IF;
 IF k='episode' THEN
  SELECT to_jsonb(e) INTO r FROM episodes e WHERE workspace_id=w AND id=i FOR SHARE;
  body:=coalesce(r->'content_ref'->>'text',r->'content_ref'->>'content','');
  occurred:=(r->>'occurred_at')::timestamptz;
 ELSIF k='session_message' THEN
  SELECT to_jsonb(m) INTO r FROM session_messages m WHERE workspace_id=w AND id=i FOR SHARE;
  IF r->>'role'='user' AND r->>'sender_user_id' IS NOT NULL THEN role_name:='human'; author:=(r->>'sender_user_id')::uuid;
  ELSIF r->>'role'='assistant' THEN role_name:='assistant'; END IF;
  origin:=(r->>'session_id')::uuid;
  body:=CASE WHEN jsonb_typeof(r->'content')='string' THEN r->>'content' ELSE
   (SELECT string_agg(v->>'text',E'\n' ORDER BY n) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r->'content')='array' THEN r->'content' ELSE '[]' END) WITH ORDINALITY t(v,n) WHERE v->>'type'='text') END;
  occurred:=(r->>'created_at')::timestamptz;
 ELSIF k='entity' THEN
  SELECT to_jsonb(e) INTO r FROM entities e WHERE workspace_id=w AND id=i AND kind='deal' FOR SHARE;
  SELECT jsonb_build_object('id',d.id,'actor',d.actor_user_id,'at',d.created_at,'changes',v.changes) INTO decision
   FROM crm_change_requests q JOIN crm_change_request_decisions d ON d.request_id=q.id AND d.workspace_id=q.workspace_id
   JOIN crm_change_request_revisions v ON v.request_id=q.id AND v.workspace_id=q.workspace_id AND v.revision=d.revision
   WHERE q.workspace_id=w AND coalesce(q.applied_target_id,q.target_id)=i AND q.state='approved' AND d.decision IN('approved','applied_direct')
   ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  body:=coalesce((decision->'changes')::text,''); role_name:='governed'; author:=(decision->>'actor')::uuid; occurred:=(decision->>'at')::timestamptz;
 ELSIF k='file_segment' THEN
  SELECT to_jsonb(f) INTO r FROM file_segments f WHERE workspace_id=w AND id=i FOR SHARE;
  body:=r->>'content'; role_name:='document'; occurred:=(r->>'created_at')::timestamptz;
 END IF;
 IF r IS NULL THEN RETURN NULL; END IF;
 s:=read_scope_review_source(w,k,i);
 IF s IS NULL OR s->>'held' IS DISTINCT FROM 'false' OR s->>'validTo' IS NOT NULL OR s->>'retractedAt' IS NOT NULL THEN RETURN NULL; END IF;
 IF k='entity' THEN s:=s||jsonb_build_object('version',(s->>'version')||':'||coalesce(decision->>'id','unaccepted')); END IF;
 RETURN s||jsonb_build_object('text',coalesce(body,''),'authorUserId',author,'role',role_name,'occurredAt',coalesce(occurred,(r->>'created_at')::timestamptz),
  'originChatId',origin,'governedAccepted',decision IS NOT NULL,'archive',false);
END $$;
REVOKE ALL ON FUNCTION crm_delivery_source_snapshot(uuid,text,uuid) FROM PUBLIC;

-- Current source + saved audience floor apply even to CRM owner-pool queries.
CREATE FUNCTION crm_delivery_envelope_visible(w uuid,owner uuid,aid uuid,tier text,labels text[],projects uuid[],chat uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid; room sessions;
BEGIN
 IF actor IS NULL OR (owner IS NOT NULL AND owner<>actor) OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor)
 OR NOT member_operation_scope_allows(w,tier,labels,false) OR NOT agent_read_scope_allows(tier,labels,projects)
 OR NOT agent_visibility_allows(w,owner,aid) THEN RETURN false; END IF;
 IF chat IS NULL THEN RETURN true; END IF;
 SELECT * INTO room FROM sessions WHERE id=chat AND workspace_id=w;
 IF room.id IS NULL THEN RETURN false; END IF;
 IF room.visibility<>'workspace' THEN RETURN room.user_id=actor; END IF;
 RETURN owner IS NULL AND (aid IS NULL OR aid=room.assistant_id) AND sensitivity_rank(room.effective_clearance)>=sensitivity_rank(tier)
 AND coalesce(room.context_compartments,'{}') @> labels
 AND projects <@ CASE WHEN room.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[room.context_project_id] END
 AND member_operation_scope_allows(w,room.effective_clearance,coalesce(room.context_compartments,'{}'),false);
END $$;
CREATE FUNCTION crm_delivery_source_visible(w uuid,k text,i uuid,revision text,chat uuid DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s jsonb; parent jsonb;
BEGIN
 s:=crm_delivery_source_snapshot(w,k,i);
 IF s IS NULL OR s->>'version' IS DISTINCT FROM revision THEN RETURN false; END IF;
 IF k='file_segment' THEN
  SELECT read_scope_source(w,'workspace_file',file_id) INTO parent FROM file_segments WHERE id=i AND workspace_id=w;
  IF parent IS NULL OR parent->>'held' IS DISTINCT FROM 'false' OR parent->>'retractedAt' IS NOT NULL
  OR NOT crm_delivery_envelope_visible(w,(parent->>'userId')::uuid,(parent->>'assistantId')::uuid,parent->>'sensitivity',
   ARRAY(SELECT jsonb_array_elements_text(parent->'compartments')),ARRAY(SELECT jsonb_array_elements_text(parent->'projectIds'))::uuid[],chat) THEN RETURN false; END IF;
 END IF;
 RETURN crm_delivery_envelope_visible(w,(s->>'userId')::uuid,(s->>'assistantId')::uuid,s->>'sensitivity',
  ARRAY(SELECT jsonb_array_elements_text(s->'compartments')),ARRAY(SELECT jsonb_array_elements_text(s->'projectIds'))::uuid[],chat);
END $$;
REVOKE ALL ON FUNCTION crm_delivery_source_visible(uuid,text,uuid,text,uuid),crm_delivery_envelope_visible(uuid,uuid,uuid,text,text[],uuid[],uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
GRANT EXECUTE ON FUNCTION crm_delivery_source_visible(uuid,text,uuid,text,uuid),crm_delivery_envelope_visible(uuid,uuid,uuid,text,text[],uuid[],uuid) TO app_user;
END IF; END $$;

ALTER TABLE crm_delivery_commitments ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_delivery_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_delivery_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY delivery_commitment_read ON crm_delivery_commitments FOR SELECT USING(
 crm_delivery_source_visible(workspace_id,source_kind,source_id,source_revision)
 AND crm_delivery_envelope_visible(workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids));
CREATE POLICY delivery_observation_read ON crm_delivery_observations FOR SELECT USING(withdrawn_at IS NULL AND
 EXISTS(SELECT 1 FROM crm_delivery_commitments c WHERE c.id=commitment_id AND c.workspace_id=crm_delivery_observations.workspace_id)
 AND crm_delivery_source_visible(workspace_id,source_kind,source_id,source_revision)
 AND crm_delivery_envelope_visible(workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids));
CREATE POLICY delivery_history_read ON crm_delivery_history FOR SELECT USING(
 EXISTS(SELECT 1 FROM crm_delivery_commitments c WHERE c.id=commitment_id AND c.workspace_id=crm_delivery_history.workspace_id));
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['crm_delivery_commitments','crm_delivery_observations','crm_delivery_history'] LOOP
  EXECUTE format('CREATE TRIGGER crm_privacy_write_admission BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_privacy_guard_write()',tab);
 END LOOP;
END $$;
-- Restrictive reads cannot be bypassed by a write receipt GUC on the app role.
CREATE POLICY delivery_commitment_current ON crm_delivery_commitments AS RESTRICTIVE FOR SELECT USING(crm_delivery_source_visible(workspace_id,source_kind,source_id,source_revision));
CREATE POLICY delivery_observation_current ON crm_delivery_observations AS RESTRICTIVE FOR SELECT USING(crm_delivery_source_visible(workspace_id,source_kind,source_id,source_revision));

-- Generic receipt readers cannot expose protected commitment ids either.
CREATE POLICY delivery_receipt_current ON crm_operation_receipts AS RESTRICTIVE FOR SELECT USING(
 command_kind NOT IN('record_delivery_recognition','review_delivery_recognition','append_delivery_observation','withdraw_delivery_observation','refresh_delivery_assessment')
 OR EXISTS(SELECT 1 FROM crm_delivery_commitments c WHERE c.workspace_id=crm_operation_receipts.workspace_id AND c.id::text=result->'record'->>'id'));
CREATE POLICY delivery_audit_current ON association_audit_log AS RESTRICTIVE FOR SELECT USING(subject_kind<>'delivery_commitment'
 OR EXISTS(SELECT 1 FROM crm_delivery_commitments c WHERE c.workspace_id=association_audit_log.workspace_id AND c.id=subject_id));
CREATE POLICY delivery_workspace_audit_current ON workspace_audit_log AS RESTRICTIVE FOR SELECT USING(event_type NOT LIKE 'crm.delivery_projection.%'
 OR EXISTS(SELECT 1 FROM crm_delivery_commitments c WHERE c.workspace_id=workspace_audit_log.workspace_id AND c.id=subject_id));
CREATE POLICY delivery_event_current ON crm_domain_event_outbox AS RESTRICTIVE FOR SELECT USING(event_type<>'crm.delivery_projection.changed'
 OR EXISTS(SELECT 1 FROM crm_delivery_commitments c WHERE c.workspace_id=crm_domain_event_outbox.workspace_id AND c.id=subject_id));

-- Reclassification/version/retraction invalidates output on the next statement;
-- deletion removes projection content, leaving only native receipt tombstones.
CREATE FUNCTION crm_delivery_source_deleted() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k text:=CASE TG_TABLE_NAME WHEN 'episodes' THEN 'episode' WHEN 'session_messages' THEN 'session_message' WHEN 'entities' THEN 'entity' WHEN 'file_segments' THEN 'file_segment' END;
BEGIN
 DELETE FROM crm_delivery_observations WHERE source_kind=k AND source_id=OLD.id;
 DELETE FROM crm_delivery_commitments WHERE source_kind=k AND source_id=OLD.id;
 RETURN OLD;
END $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['episodes','session_messages','entities','file_segments'] LOOP
  EXECUTE format('CREATE TRIGGER delivery_source_deleted BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION crm_delivery_source_deleted()',tab);
 END LOOP;
END $$;
-- Extend the existing committed outbox, preserving its installed vocabulary.
DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
  WHERE conrelid='crm_domain_event_outbox'::regclass AND conname='crm_domain_event_outbox_event_type_check';
 ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_event_type_check;
 EXECUTE 'ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_event_type_check CHECK ('
  || substr(previous,8,length(previous)-8) || ' OR event_type = ''crm.delivery_projection.changed'')';
END $$;
DO $$ DECLARE previous text; BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
  WHERE conrelid='crm_domain_event_outbox'::regclass AND conname='crm_domain_event_outbox_subject_kind_check';
 ALTER TABLE crm_domain_event_outbox DROP CONSTRAINT crm_domain_event_outbox_subject_kind_check;
 EXECUTE 'ALTER TABLE crm_domain_event_outbox ADD CONSTRAINT crm_domain_event_outbox_subject_kind_check CHECK ('
  || substr(previous,8,length(previous)-8) || ' OR subject_kind = ''delivery_commitment'')';
END $$;
SELECT crm_install_erasure_capture();
COMMIT;
