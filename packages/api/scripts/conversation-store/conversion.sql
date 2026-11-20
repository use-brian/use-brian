-- [COMP:api/native-turn-frame] Source-owned historical requirement conversion.
-- Forward-installation fragment only. Never concatenate into an applied migration.
-- No runtime reader is activated by installing this module or reconciling a run.
-- Source-derived executable/table/trigger contracts must enroll this exact module
-- through the authenticated successor installer before ordinary callers use it.

CREATE TYPE public.native_conversation_requirement_source AS (workspace_id uuid,user_id uuid,assistant_id uuid,sensitivity text,compartments text[],project_ids uuid[],kind text,id uuid,version text);
CREATE TABLE public.native_conversation_frame_requirements(
 workspace_id uuid NOT NULL,id uuid NOT NULL,format smallint NOT NULL CHECK(format IN(1,2)),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 originals public.native_conversation_requirement_source[] NOT NULL,
 declared public.native_conversation_requirement_source[] NOT NULL,PRIMARY KEY(workspace_id,id)
);
CREATE FUNCTION public.native_conversation_frame_requirement_input(w uuid,i uuid) RETURNS public.native_conversation_frame_requirements LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE f native_turn_frames;r session_context_scope_revisions;declaration scope_derivations;p jsonb;o public.native_conversation_requirement_source[];d public.native_conversation_requirement_source[];actual_edges jsonb;expected_edges jsonb;
BEGIN
 -- Hold the original identity and bytes until descriptor insertion commits.
 PERFORM 1 FROM public.native_turn_frames WHERE workspace_id=w AND id=i FOR KEY SHARE;
 PERFORM 1 FROM public.session_context_revision_contents WHERE workspace_id=w AND revision_id=i FOR KEY SHARE;
 SELECT * INTO f FROM native_turn_frames WHERE workspace_id=w AND id=i;
 IF f.id IS NULL THEN RAISE EXCEPTION 'conversion_missing_frame';END IF;
 IF NOT EXISTS(SELECT 1 FROM session_context_scope_revisions WHERE workspace_id=w AND id=i) THEN RAISE EXCEPTION 'conversion_missing_revision';END IF;
 SELECT content INTO p FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=i;
 IF p IS NULL THEN RAISE EXCEPTION 'conversion_missing_payload';END IF;
 IF native_turn_frame_payload_shape(p) IS NOT TRUE THEN RAISE EXCEPTION 'conversion_unsupported_payload';END IF;
 IF NOT EXISTS(SELECT 1 FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_context_revision' AND resource_id=i AND resource_version='1') THEN RAISE EXCEPTION 'conversion_missing_declaration';END IF;
 -- Compile immutable shape/binding only. Current holds, grants and parent audience are not compilation inputs.
 SELECT * INTO r FROM session_context_scope_revisions WHERE workspace_id=w AND id=i;
 SELECT * INTO declaration FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_context_revision' AND resource_id=i AND resource_version='1';
 SELECT coalesce(jsonb_agg(jsonb_build_array(s.source_kind,s.source_id,s.source_version) ORDER BY s.source_kind,s.source_id,s.source_version),'[]') INTO actual_edges FROM scope_derivation_sources s WHERE s.workspace_id=w AND s.derivation_id=declaration.id;
 SELECT coalesce(jsonb_agg(jsonb_build_array(n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version') ORDER BY n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version'),'[]') INTO expected_edges FROM jsonb_array_elements(p->'declaredSources') n;
 IF native_turn_frame_payload_shape(p) IS NOT TRUE OR f.format NOT IN(1,2) OR (f.format=1) IS DISTINCT FROM (p->>'kind'='native_turn_frame_v1')
  OR r.parent_kind IS DISTINCT FROM 'turn_frame' OR r.parent_id IS DISTINCT FROM i OR r.session_id IS DISTINCT FROM f.session_id OR r.scope_version<>1
  OR r.payload_sha256 IS DISTINCT FROM encode(sha256(convert_to(p::text,'UTF8')),'hex') OR f.manifest_digest IS DISTINCT FROM r.payload_sha256
  OR (declaration.user_id,declaration.assistant_id,declaration.sensitivity,declaration.compartments,declaration.project_ids) IS DISTINCT FROM (r.user_id,r.assistant_id,r.sensitivity,r.compartments,r.project_ids)
  OR actual_edges IS DISTINCT FROM expected_edges OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'originalSources')||(p->'declaredSources')) n WHERE n->>'workspaceId' IS DISTINCT FROM w::text OR n->>'resourceKind'='session_context_revision' AND n->>'resourceId'=i::text
   OR n->>'userId' IS NOT NULL AND n->>'userId' IS DISTINCT FROM r.user_id::text OR sensitivity_rank(n->>'sensitivity')>sensitivity_rank(r.sensitivity)
   OR NOT to_jsonb(r.compartments) @> (n->'compartments') OR NOT to_jsonb(r.project_ids) @> (n->'projectIds'))
 THEN RAISE EXCEPTION 'conversion_invalid_original_pair';END IF;
 IF pg_column_size(p)>16777216 THEN RAISE EXCEPTION 'conversion_unit_too_large';END IF;
 SELECT array_agg(ROW((n->>'workspaceId')::uuid,(n->>'userId')::uuid,(n->>'assistantId')::uuid,n->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(n->'compartments')),ARRAY(SELECT jsonb_array_elements_text(n->'projectIds')::uuid),n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version')::public.native_conversation_requirement_source ORDER BY ord) INTO o FROM jsonb_array_elements(p->'originalSources') WITH ORDINALITY a(n,ord);
 SELECT array_agg(ROW((n->>'workspaceId')::uuid,(n->>'userId')::uuid,(n->>'assistantId')::uuid,n->>'sensitivity',ARRAY(SELECT jsonb_array_elements_text(n->'compartments')),ARRAY(SELECT jsonb_array_elements_text(n->'projectIds')::uuid),n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version')::public.native_conversation_requirement_source ORDER BY ord) INTO d FROM jsonb_array_elements(p->'declaredSources') WITH ORDINALITY a(n,ord);
 IF pg_column_size(o)+coalesce(pg_column_size(d),0)>16777216 THEN RAISE EXCEPTION 'conversion_unit_too_large';END IF;
 RETURN ROW(w,i,f.format,f.manifest_digest,o,coalesce(d,'{}'))::public.native_conversation_frame_requirements;
END $$;
CREATE FUNCTION public.native_conversation_compile_frame_requirements(w uuid,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected public.native_conversation_frame_requirements;actual public.native_conversation_frame_requirements;
BEGIN
 expected:=public.native_conversation_frame_requirement_input(w,i);
 SELECT * INTO actual FROM public.native_conversation_frame_requirements WHERE workspace_id=w AND id=i;
 IF actual.id IS NOT NULL AND actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'conversion_original_or_descriptor_mismatch';END IF;
 INSERT INTO public.native_conversation_frame_requirements SELECT (expected).* ON CONFLICT(workspace_id,id) DO NOTHING;
 RETURN jsonb_build_object('format',expected.format,'originals',cardinality(expected.originals),'declared',cardinality(expected.declared),
  'bytes',pg_column_size(expected),'payloadDigest',expected.payload_digest);
END $$;
CREATE FUNCTION public.native_conversation_frame_requirement_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected public.native_conversation_frame_requirements;
BEGIN
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM public.native_turn_frames WHERE id=OLD.id)
   OR NOT EXISTS(SELECT 1 FROM public.session_context_revision_contents WHERE revision_id=OLD.id)) THEN RETURN OLD;END IF;
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'conversion_requirement_immutable';END IF;
 expected:=public.native_conversation_frame_requirement_input(NEW.workspace_id,NEW.id);
 IF NEW IS DISTINCT FROM expected THEN RAISE EXCEPTION 'conversion_original_or_descriptor_mismatch';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_conversation_frame_requirement_guard BEFORE INSERT OR UPDATE OR DELETE ON public.native_conversation_frame_requirements
 FOR EACH ROW EXECUTE FUNCTION public.native_conversation_frame_requirement_guard();

-- A finite frame input only. All current facts below are fetched again. No allow result is stored.
CREATE FUNCTION public.native_conversation_compiled_frame_pair(w uuid,i uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE cert public.native_conversation_frame_requirements;f native_turn_frames;r session_context_scope_revisions;d scope_derivations;parent sessions;p jsonb;edges jsonb;declared jsonb;n public.native_conversation_requirement_source;
BEGIN
 SELECT * INTO cert FROM public.native_conversation_frame_requirements WHERE workspace_id=w AND id=i;
 IF cert.id IS NULL THEN RAISE EXCEPTION 'conversion_missing_certificate';END IF;
 SELECT * INTO f FROM native_turn_frames WHERE workspace_id=w AND id=i;
 SELECT * INTO r FROM session_context_scope_revisions WHERE workspace_id=w AND id=i;
 SELECT id,visibility,user_id INTO parent.id,parent.visibility,parent.user_id FROM sessions WHERE workspace_id=w AND id=r.session_id;
 SELECT content INTO p FROM session_context_revision_contents WHERE workspace_id=w AND revision_id=i;
 IF f.id IS NULL OR r.id IS NULL OR parent.id IS NULL OR r.scope_held OR scope_review_state_held('session_context_revision',i)
  OR parent.visibility='personal' AND r.user_id IS DISTINCT FROM parent.user_id
  OR f.format=1 AND parent.visibility<>'personal' AND r.user_id IS NOT NULL
  OR r.assistant_id IS NOT NULL OR f.format NOT IN(1,2) OR f.format IS DISTINCT FROM cert.format OR r.parent_kind IS DISTINCT FROM 'turn_frame'
  OR r.parent_id IS DISTINCT FROM i OR r.session_id IS DISTINCT FROM f.session_id OR r.scope_version<>1
  OR p IS NULL OR encode(sha256(convert_to(p::text,'UTF8')),'hex') IS DISTINCT FROM cert.payload_digest
  OR r.payload_sha256 IS DISTINCT FROM cert.payload_digest OR f.manifest_digest IS DISTINCT FROM cert.payload_digest
 THEN RETURN false;END IF;
 -- Dynamic source vocabulary remains fresh, as in payload_shape. Scalar shape and V1 subset were compiled from the hash-bound immutable payload.
 FOREACH n IN ARRAY cert.originals||cert.declared LOOP
  IF n.workspace_id IS DISTINCT FROM w OR n.kind='session_context_revision' AND n.id=i
   OR (CASE WHEN cert.format=1 THEN n.kind NOT IN('session_message','session_context_revision','application_field','workspace_file')
    ELSE n.kind NOT IN('application_field','external_source','crm_event','private_transcript','page_event_changed','page_event_destination','page_live_changed','page_live_destination') AND scope_source_table(n.kind) IS NULL END)
  THEN RETURN false;END IF;
 END LOOP;
 SELECT * INTO d FROM scope_derivations WHERE workspace_id=w AND resource_kind='session_context_revision' AND resource_id=i AND resource_version='1';
 IF d.id IS NULL OR (d.user_id,d.assistant_id,d.sensitivity,d.compartments,d.project_ids) IS DISTINCT FROM (r.user_id,r.assistant_id,r.sensitivity,r.compartments,r.project_ids) THEN RETURN false;END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_array(source_kind,source_id,source_version) ORDER BY source_kind,source_id,source_version),'[]') INTO edges FROM scope_derivation_sources WHERE workspace_id=w AND derivation_id=d.id;
 SELECT coalesce(jsonb_agg(jsonb_build_array(decl.kind,decl.id,decl.version) ORDER BY decl.kind,decl.id,decl.version),'[]') INTO declared FROM unnest(cert.declared) decl;
 IF edges IS DISTINCT FROM declared THEN RETURN false;END IF;
 FOREACH n IN ARRAY cert.originals||cert.declared LOOP
  IF n.user_id IS NOT NULL AND n.user_id IS DISTINCT FROM r.user_id OR sensitivity_rank(n.sensitivity)>sensitivity_rank(r.sensitivity)
    OR NOT r.compartments @> n.compartments OR NOT r.project_ids @> n.project_ids THEN RETURN false;END IF;
 END LOOP;
 RETURN true;
END $$;
ALTER TABLE public.native_conversation_frame_requirements ADD CONSTRAINT native_conversation_frame_requirement_frame_fk
 FOREIGN KEY(id) REFERENCES public.native_turn_frames(id) ON DELETE CASCADE;
ALTER TABLE public.native_conversation_frame_requirements ADD CONSTRAINT native_conversation_frame_requirement_payload_fk
 FOREIGN KEY(id) REFERENCES public.session_context_revision_contents(revision_id) ON DELETE CASCADE;

CREATE TYPE public.native_conversation_conversion_unit_kind AS ENUM('frame','field_observation','query_domain','derivation');
CREATE TABLE public.native_conversation_conversion_runs(
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 compiler_digest text NOT NULL CHECK(compiler_digest ~ '^[a-f0-9]{64}$'),
 phase text NOT NULL DEFAULT 'scan' CHECK(phase IN('scan','delta','audit','reconciled')),
 cursor_kind public.native_conversation_conversion_unit_kind, cursor_id uuid,cursor_version text,
 page bigint NOT NULL DEFAULT 0,chain_digest text NOT NULL DEFAULT repeat('0',64),
 UNIQUE(workspace_id,compiler_digest)
);
-- Metadata receipts reference existing typed owners. They are not requirement programs.
CREATE TABLE public.native_conversation_conversion_inputs(
 run_id uuid NOT NULL REFERENCES public.native_conversation_conversion_runs(id) ON DELETE CASCADE,
 kind public.native_conversation_conversion_unit_kind NOT NULL,id uuid NOT NULL,version text NOT NULL,
 original_digest text NOT NULL,compiler_digest text NOT NULL,bytes integer NOT NULL,
 PRIMARY KEY(run_id,kind,id,version)
);
CREATE TABLE public.native_conversation_conversion_pending(
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind public.native_conversation_conversion_unit_kind NOT NULL,id uuid NOT NULL,version text NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(workspace_id,kind,id,version)
);
CREATE TABLE public.native_conversation_conversion_pages(
 run_id uuid NOT NULL REFERENCES public.native_conversation_conversion_runs(id) ON DELETE CASCADE,
 page bigint NOT NULL,phase text NOT NULL,units integer NOT NULL,bytes integer NOT NULL,
 before_cursor jsonb,after_cursor jsonb,chain_digest text NOT NULL,
 PRIMARY KEY(run_id,page)
);
CREATE FUNCTION public.native_conversation_conversion_keys(w uuid)
RETURNS TABLE(kind public.native_conversation_conversion_unit_kind,id uuid,version text)
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT 'frame'::public.native_conversation_conversion_unit_kind,id,format::text FROM native_turn_frames WHERE workspace_id=w
 UNION ALL SELECT 'field_observation',resource_id,version FROM application_field_observations WHERE workspace_id=w
 UNION ALL SELECT 'query_domain',id,identity FROM application_query_domains WHERE workspace_id=w
 UNION ALL SELECT 'derivation',id,resource_version FROM scope_derivations WHERE workspace_id=w
$$;
-- Only immutable scalar witnesses are hashed. Appended source links, all-version
-- ancestry, live policy, holds, authority, candidate scans NEVER enter this hash.
CREATE FUNCTION public.native_conversation_conversion_witness(w uuid,k public.native_conversation_conversion_unit_kind,i uuid,v text)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE fact jsonb;
BEGIN
 CASE k
 WHEN 'frame' THEN
  SELECT jsonb_build_object('frame',to_jsonb(f),'revision',to_jsonb(r)-'scope_held'-'created_at','payload',c.content)
  INTO fact FROM native_turn_frames f JOIN session_context_scope_revisions r ON r.workspace_id=f.workspace_id AND r.id=f.id
  JOIN session_context_revision_contents c ON c.workspace_id=f.workspace_id AND c.revision_id=f.id
  WHERE f.workspace_id=w AND f.id=i AND f.format::text=v;
 WHEN 'field_observation' THEN
  SELECT jsonb_build_object('resource',to_jsonb(r)-'created_at','observation',to_jsonb(o)-'created_at') INTO fact
  FROM application_field_resources r JOIN application_field_observations o ON o.workspace_id=r.workspace_id AND o.resource_id=r.id
  WHERE r.workspace_id=w AND r.id=i AND o.version=v;
 WHEN 'query_domain' THEN
  SELECT to_jsonb(q)-'created_at' INTO fact FROM application_query_domains q WHERE q.workspace_id=w AND q.id=i AND q.identity=v;
 WHEN 'derivation' THEN
  SELECT to_jsonb(d)-'created_at' INTO fact FROM scope_derivations d WHERE d.workspace_id=w AND d.id=i AND d.resource_version=v;
 END CASE;
 RETURN fact;
END $$;
CREATE FUNCTION public.native_conversation_conversion_validate_witness(k public.native_conversation_conversion_unit_kind,fact jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE d jsonb;
BEGIN
 IF fact IS NULL THEN RAISE EXCEPTION 'conversion_missing_original';END IF;

 IF k='frame' THEN
  IF fact#>>'{frame,format}' NOT IN('1','2') THEN RAISE EXCEPTION 'conversion_unsupported_frame';END IF;
 ELSIF k='field_observation' THEN
  IF fact#>>'{resource,selection}' NOT IN('read','query','history','identity','query_domain')
   OR fact#>'{resource,fields}' IS NULL OR fact#>'{observation,record_version}' IS NULL
   OR fact#>'{observation,policy_version}' IS NULL OR fact#>'{observation,source_scope}' IS NULL
  THEN RAISE EXCEPTION 'conversion_missing_field_witness';END IF;
 ELSIF k='query_domain' THEN
  d:=fact->'domain';
  IF fact->'origin'='{"kind":"native","moduleKey":"native"}'::jsonb THEN
   CASE d->>'kind'
   WHEN 'session_query_domain_v1' THEN
    IF fact->>'type_key' NOT IN('session_message','session_message_annotation') OR NOT d ?& ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']
     OR d-ARRAY['kind','sessionId','throughSequence','fields','bounds','visibility','parentFingerprint','candidates','points']<>'{}'
    THEN RAISE EXCEPTION 'conversion_missing_session_domain_witness';END IF;
   WHEN 'memory_query_domain_v1' THEN
    IF fact->>'type_key'<>'memory' OR NOT d ?& ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']
     OR d-ARRAY['kind','fields','bounds','visibility','includeRetained','candidates','policies']<>'{}'
    THEN RAISE EXCEPTION 'conversion_missing_memory_domain_witness';END IF;
   WHEN 'memory_outcome_domain_v1' THEN
    IF fact->>'type_key'<>'feedback_event' OR NOT d ?& ARRAY['kind','fields','bounds','visibility','memoryIds','windowStart','windowEnd','memoryCandidates','associations','feedback','policies']
     OR d-ARRAY['kind','fields','bounds','visibility','memoryIds','windowStart','windowEnd','memoryCandidates','associations','feedback','policies']<>'{}'
    THEN RAISE EXCEPTION 'conversion_missing_outcome_domain_witness';END IF;
   ELSE RAISE EXCEPTION 'conversion_unsupported_native_domain';
   END CASE;
  ELSIF fact#>>'{origin,kind}'='generic' AND d->>'kind'='native_legacy' THEN
   -- Typed original owner stays with its explicit application adapter.
   NULL;
  ELSE RAISE EXCEPTION 'conversion_unsupported_domain_adapter';END IF;
 END IF;
END $$;
CREATE FUNCTION public.native_conversation_conversion_enroll() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid; k public.native_conversation_conversion_unit_kind;i uuid;v text;
BEGIN
 w:=NEW.workspace_id;
 CASE TG_TABLE_NAME
 WHEN 'native_turn_frames' THEN k:='frame';i:=NEW.id;v:=NEW.format::text;
 WHEN 'session_context_revision_contents' THEN
  SELECT 'frame'::public.native_conversation_conversion_unit_kind,f.id,f.format::text INTO k,i,v FROM public.native_turn_frames f WHERE f.workspace_id=w AND f.id=NEW.revision_id;
 WHEN 'application_field_resources' THEN RETURN NEW; -- observations are complete units
 WHEN 'application_field_observations' THEN k:='field_observation';i:=NEW.resource_id;v:=NEW.version;
 WHEN 'application_field_observation_sources' THEN k:='field_observation';i:=NEW.resource_id;v:=NEW.version;
 WHEN 'application_query_domains' THEN k:='query_domain';i:=NEW.id;v:=NEW.identity;
 WHEN 'scope_derivations' THEN k:='derivation';i:=NEW.id;v:=NEW.resource_version;
 WHEN 'scope_derivation_sources' THEN
  SELECT 'derivation'::public.native_conversation_conversion_unit_kind,d.id,d.resource_version INTO k,i,v FROM public.scope_derivations d WHERE d.workspace_id=w AND d.id=NEW.derivation_id;
 END CASE;
 IF i IS NOT NULL THEN
  INSERT INTO public.native_conversation_conversion_pending VALUES(w,k,i,v,1)
  ON CONFLICT(workspace_id,kind,id,version) DO UPDATE SET generation=public.native_conversation_conversion_pending.generation+1;
 END IF;
 RETURN NEW;
END $$;
-- Installed before the initial scan. Inserts with random ids before a cursor enroll.
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON native_turn_frames FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON session_context_revision_contents FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON application_field_observations FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON application_field_observation_sources FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON application_query_domains FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON scope_derivations FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
CREATE TRIGGER native_conversation_conversion_enroll AFTER INSERT ON scope_derivation_sources FOR EACH ROW EXECUTE FUNCTION public.native_conversation_conversion_enroll();
-- Original source dispatch/privacy remains unchanged. Enrollment does not authorize.
ALTER TABLE public.native_conversation_conversion_runs ADD COLUMN audit_done boolean NOT NULL DEFAULT false;
ALTER TABLE public.native_conversation_conversion_inputs ADD COLUMN descriptor_digest text;

-- Protocol v1 is maintenance metadata. It never activates a reader or grants data.
ALTER TABLE public.native_conversation_conversion_runs ADD COLUMN protocol_version smallint NOT NULL DEFAULT 1 CHECK(protocol_version=1);
ALTER TABLE public.native_conversation_conversion_inputs ADD COLUMN processing_mode text NOT NULL DEFAULT 'original_adapter'
 CHECK(processing_mode IN('compiled_frame','original_adapter'));
ALTER TABLE public.native_conversation_conversion_pages ADD COLUMN source_bytes bigint NOT NULL DEFAULT 0;

CREATE FUNCTION public.native_conversation_conversion_start(w uuid,compiler text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result uuid;
BEGIN
 IF compiler IS NULL OR compiler !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'conversion_invalid_compiler_digest';END IF;
 PERFORM 1 FROM public.workspaces WHERE id=w FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversion_workspace_absent';END IF;
 INSERT INTO public.native_conversation_conversion_runs(id,workspace_id,compiler_digest)
 VALUES(gen_random_uuid(),w,compiler) ON CONFLICT(workspace_id,compiler_digest) DO NOTHING;
 SELECT id INTO result FROM public.native_conversation_conversion_runs WHERE workspace_id=w AND compiler_digest=compiler;
 IF result IS NULL THEN RAISE EXCEPTION 'conversion_run_absent';END IF;
 RETURN result;
END $$;

-- One call is one atomic page. The maintained worker commits before its next
-- call; no transaction is kept across process waits or a reconciliation retry.
CREATE FUNCTION public.native_conversation_conversion_page(run uuid,unit_limit integer,byte_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid;r public.native_conversation_conversion_runs;unit record;acquired jsonb;original_digest text;
 descriptor public.native_conversation_frame_requirements;descriptor_digest text;prior public.native_conversation_conversion_inputs;mode text;
 source_bytes bigint:=0;written_bytes integer:=0;unit_bytes integer;receipt_bytes integer;counted integer:=0;
 units jsonb:='[]';before_cursor jsonb;after_cursor jsonb;next_page bigint;chain text;
 last_kind public.native_conversation_conversion_unit_kind;last_id uuid;last_version text;
BEGIN
 IF unit_limit IS NULL OR unit_limit NOT BETWEEN 1 AND 32 OR byte_limit IS NULL OR byte_limit NOT BETWEEN 1 AND 16777216
 THEN RAISE EXCEPTION 'conversion_invalid_page_budget';END IF;
 SELECT workspace_id INTO w FROM public.native_conversation_conversion_runs WHERE id=run;
 IF w IS NULL THEN RETURN jsonb_build_object('state','absent');END IF;
 -- Workspace precedes the run row, matching parent cascade lock order.
 PERFORM 1 FROM public.workspaces WHERE id=w FOR KEY SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','absent');END IF;
 SELECT * INTO r FROM public.native_conversation_conversion_runs WHERE id=run FOR UPDATE;
 IF r.id IS NULL THEN RETURN jsonb_build_object('state','absent');END IF;
 IF r.protocol_version<>1 THEN RAISE EXCEPTION 'conversion_unsupported_protocol';END IF;
 IF r.phase='reconciled' THEN
  IF NOT EXISTS(SELECT 1 FROM public.native_conversation_conversion_pending WHERE workspace_id=w)
  THEN RETURN jsonb_build_object('state','reconciled','page',r.page);END IF;
  UPDATE public.native_conversation_conversion_runs SET phase='delta' WHERE id=run;
  r.phase:='delta';
 END IF;
 before_cursor:=CASE WHEN r.cursor_kind IS NULL THEN 'null'::jsonb ELSE jsonb_build_array(r.cursor_kind,r.cursor_id,r.cursor_version) END;
 last_kind:=r.cursor_kind;last_id:=r.cursor_id;last_version:=r.cursor_version;
 FOR unit IN
  SELECT candidates.* FROM (
   SELECT p.kind,p.id,p.version,p.generation FROM public.native_conversation_conversion_pending p
    WHERE r.phase='delta' AND p.workspace_id=w
   UNION ALL
   SELECT k.kind,k.id,k.version,NULL::bigint FROM public.native_conversation_conversion_keys(w) k
    WHERE r.phase<>'delta' AND (r.cursor_kind IS NULL OR (k.kind,k.id,k.version)>(r.cursor_kind,r.cursor_id,r.cursor_version))
  ) candidates ORDER BY kind,id,version LIMIT unit_limit
 LOOP
  -- Acquire once: validation and the digest consume this same SQL value. No
  -- JavaScript parse/reserialization changes numeric values or ordered arrays.
  acquired:=public.native_conversation_conversion_witness(w,unit.kind,unit.id,unit.version);
  PERFORM public.native_conversation_conversion_validate_witness(unit.kind,acquired);
  unit_bytes:=pg_column_size(acquired);
  source_bytes:=source_bytes+unit_bytes;
  original_digest:=encode(sha256(convert_to(acquired::text,'UTF8')),'hex');
  descriptor:=NULL;descriptor_digest:=NULL;mode:='original_adapter';
  -- These are native conversion eligibility bounds only. Other valid original
  -- units retain their complete adapter; no new content limit or truncation.
  IF unit.kind='frame' AND unit_bytes<=16777216
   AND (CASE WHEN jsonb_typeof(acquired#>'{payload,originalSources}')='array'
     THEN jsonb_array_length(acquired#>'{payload,originalSources}')<=4096 ELSE true END)
   AND (CASE WHEN jsonb_typeof(acquired#>'{payload,declaredSources}')='array'
     THEN jsonb_array_length(acquired#>'{payload,declaredSources}')<=4096 ELSE true END) THEN
   -- Validation acquires immutable originals but writes no descriptor. Budget
   -- eligibility is decided before the counted unit may materialize anything.
   BEGIN
    descriptor:=public.native_conversation_frame_requirement_input(w,unit.id);
    descriptor_digest:=encode(sha256(convert_to(to_jsonb(descriptor)::text,'UTF8')),'hex');
    mode:='compiled_frame';
   EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'conversion_unit_too_large' THEN RAISE;END IF;
    descriptor:=NULL;descriptor_digest:=NULL;mode:='original_adapter';
   END;
  END IF;
  receipt_bytes:=pg_column_size(jsonb_build_array(unit.kind,unit.id,unit.version,original_digest,descriptor_digest,mode))
   +coalesce(pg_column_size(descriptor),0);
  IF written_bytes+receipt_bytes>byte_limit THEN
   IF counted=0 THEN RAISE EXCEPTION 'conversion_page_budget_too_small';END IF;
   EXIT;
  END IF;
  IF mode='compiled_frame' THEN
   PERFORM public.native_conversation_compile_frame_requirements(w,unit.id);
  END IF;
  SELECT * INTO prior FROM public.native_conversation_conversion_inputs
   WHERE run_id=run AND kind=unit.kind AND id=unit.id AND version=unit.version;
  IF prior.run_id IS NOT NULL AND (prior.original_digest,prior.compiler_digest,prior.descriptor_digest,prior.processing_mode)
   IS DISTINCT FROM (original_digest,r.compiler_digest,descriptor_digest,mode)
  THEN RAISE EXCEPTION 'conversion_original_or_descriptor_mismatch';END IF;
  IF prior.run_id IS NULL THEN
   INSERT INTO public.native_conversation_conversion_inputs(run_id,kind,id,version,original_digest,compiler_digest,bytes,descriptor_digest,processing_mode)
    VALUES(run,unit.kind,unit.id,unit.version,original_digest,r.compiler_digest,unit_bytes,descriptor_digest,mode);
  END IF;
  -- Never lock pending ahead of its source owner. A concurrent generation3
  -- survives the generation2 delete even when the delete waited for its writer.
  IF r.phase='delta' THEN
   DELETE FROM public.native_conversation_conversion_pending p WHERE p.workspace_id=w AND p.kind=unit.kind
    AND p.id=unit.id AND p.version=unit.version AND p.generation=unit.generation;
  END IF;
  written_bytes:=written_bytes+receipt_bytes;counted:=counted+1;
  last_kind:=unit.kind;last_id:=unit.id;last_version:=unit.version;
  units:=units||jsonb_build_array(jsonb_build_array(unit.kind,unit.id,unit.version,original_digest,descriptor_digest,mode));
 END LOOP;
 IF counted=0 THEN
  IF r.phase IN('scan','audit') THEN
   UPDATE public.native_conversation_conversion_runs SET phase='delta',cursor_kind=NULL,cursor_id=NULL,cursor_version=NULL,
    audit_done=audit_done OR r.phase='audit' WHERE id=run;
  ELSIF NOT r.audit_done THEN
   UPDATE public.native_conversation_conversion_runs SET phase='audit',cursor_kind=NULL,cursor_id=NULL,cursor_version=NULL WHERE id=run;
  END IF;
  RETURN jsonb_build_object('state',CASE WHEN r.phase='delta' AND r.audit_done THEN 'await_barrier' ELSE 'phase_advanced' END,'phase',r.phase);
 END IF;
 next_page:=r.page+1;
 chain:=encode(sha256(convert_to(jsonb_build_array(r.chain_digest,next_page,r.phase,units)::text,'UTF8')),'hex');
 after_cursor:=jsonb_build_array(last_kind,last_id,last_version);
 INSERT INTO public.native_conversation_conversion_pages(run_id,page,phase,units,bytes,before_cursor,after_cursor,chain_digest,source_bytes)
 VALUES(run,next_page,r.phase,counted,written_bytes,before_cursor,after_cursor,chain,source_bytes);
 UPDATE public.native_conversation_conversion_runs SET page=next_page,chain_digest=chain,
  cursor_kind=CASE WHEN r.phase='delta' THEN r.cursor_kind ELSE last_kind END,
  cursor_id=CASE WHEN r.phase='delta' THEN r.cursor_id ELSE last_id END,
  cursor_version=CASE WHEN r.phase='delta' THEN r.cursor_version ELSE last_version END WHERE id=run;
 RETURN jsonb_build_object('state','committed','page',next_page,'phase',r.phase,'units',counted,'bytes',written_bytes,'sourceBytes',source_bytes,'chain',chain);
END $$;

CREATE FUNCTION public.native_conversation_conversion_reconcile(run uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w uuid;r public.native_conversation_conversion_runs;
BEGIN
 SELECT workspace_id INTO w FROM public.native_conversation_conversion_runs WHERE id=run;
 IF w IS NULL THEN RETURN jsonb_build_object('state','absent');END IF;
 PERFORM 1 FROM public.workspaces WHERE id=w FOR KEY SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('state','absent');END IF;
 -- The barrier checks only indexed pending existence, never a full inventory
 -- scan or digest while holding this brief source-enrollment lock.
 LOCK TABLE public.native_turn_frames,public.session_context_revision_contents,public.application_field_observations,
  public.application_field_observation_sources,public.application_query_domains,public.scope_derivations,public.scope_derivation_sources IN SHARE MODE NOWAIT;
 SELECT * INTO r FROM public.native_conversation_conversion_runs WHERE id=run FOR UPDATE;
 IF r.id IS NULL THEN RETURN jsonb_build_object('state','absent');END IF;
 IF r.protocol_version<>1 OR NOT r.audit_done OR r.phase<>'delta' THEN RETURN jsonb_build_object('state','not_reconciled');END IF;
 IF EXISTS(SELECT 1 FROM public.native_conversation_conversion_pending WHERE workspace_id=w) THEN RETURN jsonb_build_object('state','pending');END IF;
 UPDATE public.native_conversation_conversion_runs SET phase='reconciled' WHERE id=run;
 RETURN jsonb_build_object('state','reconciled','page',r.page,'chain',r.chain_digest);
END $$;

REVOKE ALL ON TYPE public.native_conversation_requirement_source,public.native_conversation_conversion_unit_kind FROM PUBLIC,app_user;
REVOKE ALL ON public.native_conversation_frame_requirements,public.native_conversation_conversion_runs,
 public.native_conversation_conversion_inputs,public.native_conversation_conversion_pending,public.native_conversation_conversion_pages FROM PUBLIC,app_user;
REVOKE ALL ON FUNCTION public.native_conversation_frame_requirement_input(uuid,uuid),
 public.native_conversation_compile_frame_requirements(uuid,uuid),public.native_conversation_frame_requirement_guard(),
 public.native_conversation_compiled_frame_pair(uuid,uuid),public.native_conversation_conversion_keys(uuid),
 public.native_conversation_conversion_witness(uuid,public.native_conversation_conversion_unit_kind,uuid,text),
 public.native_conversation_conversion_validate_witness(public.native_conversation_conversion_unit_kind,jsonb),
 public.native_conversation_conversion_enroll(),public.native_conversation_conversion_start(uuid,text),
 public.native_conversation_conversion_page(uuid,integer,integer),public.native_conversation_conversion_reconcile(uuid) FROM PUBLIC,app_user;
