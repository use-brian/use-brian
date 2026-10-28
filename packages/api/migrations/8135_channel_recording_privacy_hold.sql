-- [COMP:api/channel-recording] Legacy provider captures have no recorded sharing
-- consent or verified recording owner. Hold them without relabelling history.
BEGIN;
DO $$ BEGIN
 IF application_memory_statement_helpers_current() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Recording privacy canonical helper prerequisite changed';END IF;
END $$;
CREATE TEMP TABLE recording_privacy_helper_transition(function_oid oid PRIMARY KEY,old_source text NOT NULL,old_metadata jsonb NOT NULL) ON COMMIT DROP;
ALTER TABLE sessions ADD COLUMN recording_privacy_held boolean NOT NULL DEFAULT false;

-- A channel anchor is the durable evidence that this was a managed group room.
-- Do not depend on a still-present installation, its current owner, or its first
-- speaker. Telegram private conversations have positive provider chat ids.
UPDATE sessions SET recording_privacy_held=true
 WHERE channel_type='telegram' AND anchor_kind='channel' AND channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$'
   AND recording_revision IS NULL;

CREATE FUNCTION guard_session_recording_privacy() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.recording_privacy_held AND NOT NEW.recording_privacy_held THEN
  RAISE EXCEPTION 'recording_privacy_review_required' USING ERRCODE='42501';
 END IF;
 IF NEW.channel_type='telegram' AND NEW.anchor_kind='channel'
  AND NEW.channel_id ~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$' AND NEW.recording_revision IS NULL THEN
  NEW.recording_privacy_held:=true;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_session_recording_privacy() FROM PUBLIC;
-- derive_session_kind runs first, including when an old API omits the anchor.
CREATE TRIGGER aaab_session_recording_privacy BEFORE INSERT OR UPDATE ON sessions
 FOR EACH ROW EXECUTE FUNCTION guard_session_recording_privacy();

-- The sole session quarantine predicate. SECURITY DEFINER is necessary to avoid
-- recursively invoking sessions RLS. It reads only identity and the hold bit.
CREATE FUNCTION session_recording_read_allowed(i uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT NOT recording_privacy_held FROM sessions WHERE id=i),false)
$$;
REVOKE ALL ON FUNCTION session_recording_read_allowed(uuid) FROM PUBLIC;

-- Resolve source ancestry using immutable metadata only. Scope readers and
-- native field/history readers must refuse before selecting any protected body.
-- UNION terminates cycles; all retained versions are conservatively protected.
CREATE FUNCTION recording_source_read_allowed(w uuid,k text,i uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH RECURSIVE nodes(kind,id) AS (
  SELECT k,i
  UNION
  SELECT edge.kind,edge.id FROM nodes n CROSS JOIN LATERAL (
   SELECT s.source_kind AS kind,s.source_id AS id
    FROM scope_derivations d JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
    WHERE d.workspace_id=w AND d.resource_kind=n.kind AND d.resource_id=n.id
   UNION
   SELECT o.source_kind,o.source_id FROM application_field_observations o
    WHERE n.kind='application_field' AND o.workspace_id=w AND o.resource_id=n.id
   UNION
   SELECT s.source_kind,s.source_id FROM application_field_observation_sources s
    WHERE n.kind='application_field' AND s.workspace_id=w AND s.resource_id=n.id
   UNION
   SELECT 'session_message',f.resource_id FROM application_field_resources f
    WHERE n.kind='application_field' AND f.workspace_id=w AND f.id=n.id
     AND f.origin='{"kind":"native","moduleKey":"native"}'::jsonb
     AND f.type_key IN('session_message','session_message_annotation')
  ) edge
 ), parents AS (
  SELECT s.id FROM nodes n JOIN sessions s ON n.kind='session' AND s.id=n.id AND s.workspace_id=w
  UNION SELECT m.session_id FROM nodes n JOIN session_messages m ON n.kind='session_message' AND m.id=n.id
    JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=w
  UNION SELECT r.session_id FROM nodes n JOIN session_context_scope_revisions r ON n.kind='session_context_revision' AND r.id=n.id AND r.workspace_id=w
  UNION SELECT s.session_id FROM nodes n JOIN session_state s ON n.kind='session_state' AND s.id=n.id
  UNION SELECT e.session_id FROM nodes n JOIN episodic_memories e ON n.kind='episodic_memory' AND e.id=n.id
  UNION SELECT e.session_id FROM nodes n JOIN analytics_events e ON n.kind='feedback_event' AND e.id=n.id
 ) SELECT NOT EXISTS(SELECT 1 FROM parents WHERE id IS NOT NULL AND NOT session_recording_read_allowed(id))
$$;
REVOKE ALL ON FUNCTION recording_source_read_allowed(uuid,text,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 GRANT EXECUTE ON FUNCTION session_recording_read_allowed(uuid),recording_source_read_allowed(uuid,text,uuid) TO app_user;
END IF;END $$;

CREATE POLICY recording_privacy_read ON sessions AS RESTRICTIVE FOR SELECT
 USING(session_recording_read_allowed(id));
CREATE POLICY recording_privacy_read ON session_messages AS RESTRICTIVE FOR SELECT
 USING(session_recording_read_allowed(session_id));
-- These rows contain transcript-derived text, tool payloads, or title metadata.
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['session_state','episodic_memories','session_context_scope_revisions',
   'session_title_heads','session_message_annotation_heads','tool_result_cache','file_cache','turn_events','session_resume_points'] LOOP
  EXECUTE format('CREATE POLICY recording_privacy_read ON %I AS RESTRICTIVE FOR SELECT USING(session_id IS NULL OR session_recording_read_allowed(session_id))',tab);
 END LOOP;
END $$;
CREATE POLICY recording_privacy_read ON session_context_revision_contents AS RESTRICTIVE FOR SELECT
 USING(recording_source_read_allowed(workspace_id,'session_context_revision',revision_id));

CREATE FUNCTION refuse_quarantined_recording_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NOT session_recording_read_allowed(NEW.session_id) THEN
  RAISE EXCEPTION 'recording_privacy_review_required' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION refuse_quarantined_recording_message() FROM PUBLIC;
CREATE TRIGGER aaab_recording_privacy_message BEFORE INSERT ON session_messages
 FOR EACH ROW EXECUTE FUNCTION refuse_quarantined_recording_message();

-- Preserve function OIDs, attributes, grants and all existing authority checks.
-- A wrapper obtained by renaming could leave pre-bound SQL callers pointing at
-- the old unguarded OID. Insert the narrow early refusal into the existing body.
DO $$
DECLARE spec record; oid_value oid; definition text; body text; guarded text;
BEGIN
 FOR spec IN SELECT * FROM (VALUES
  ('read_scope_source(uuid,text,uuid)','IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;'),
  ('read_scope_review_source(uuid,text,uuid)','IF NOT recording_source_read_allowed(p_workspace,p_kind,p_id) THEN RETURN NULL;END IF;'),
  ('read_scope_review_content(uuid,text,uuid)','IF NOT recording_source_read_allowed(p_workspace,p_kind,p_id) THEN RETURN NULL;END IF;'),
  ('read_admitted_native_scope_snapshot(uuid,text,uuid)','IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;'),
  ('read_entity_derivation_source(uuid,text,uuid)','IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;'),
  ('crm_delivery_source_snapshot(uuid,text,uuid)','IF NOT recording_source_read_allowed(w,k,i) THEN RETURN NULL;END IF;'),
  ('session_context_parent_snapshot(uuid,uuid)','IF NOT session_recording_read_allowed(i) THEN RETURN NULL;END IF;'),
  ('session_context_revision_snapshot(uuid,uuid)','IF NOT recording_source_read_allowed(w,''session_context_revision'',i) THEN RETURN ''{"held":true}''::jsonb;END IF;'),
  ('session_context_revision_native(uuid,uuid)','IF NOT recording_source_read_allowed(w,''session_context_revision'',i) THEN RETURN NULL;END IF;'),
  ('session_context_revision_allowed(uuid,uuid)','IF NOT recording_source_read_allowed(w,''session_context_revision'',i) THEN RETURN false;END IF;'),
  ('read_session_context_revision(uuid,uuid)','IF NOT recording_source_read_allowed(w,''session_context_revision'',i) THEN RETURN NULL;END IF;'),
  ('read_session_title_revision(uuid,uuid,uuid)','IF NOT session_recording_read_allowed(s) THEN RETURN NULL;END IF;'),
  ('application_session_field_state(uuid,text,uuid,text[])','IF NOT recording_source_read_allowed(w,''session_message'',i) THEN RETURN NULL;END IF;'),
  ('application_session_eval_point_state(uuid,text,uuid,text[],jsonb)','IF NOT recording_source_read_allowed(w,''session_message'',i) THEN RETURN jsonb_build_object(''memo'',memo);END IF;'),
  ('application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)','IF NOT recording_source_read_allowed(w,k,i) THEN RETURN false;END IF;'),
  ('crm_delivery_envelope_visible(uuid,uuid,uuid,text,text[],uuid[],uuid)','IF chat IS NOT NULL AND NOT session_recording_read_allowed(chat) THEN RETURN false;END IF;')
 ) v(signature,guard) LOOP
  oid_value:=to_regprocedure('public.'||spec.signature);
  SELECT pg_get_functiondef(p.oid),p.prosrc INTO definition,body FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=oid_value AND l.lanname='plpgsql';
  IF definition IS NULL OR body !~ '\mBEGIN\M' THEN RAISE EXCEPTION 'Recording privacy reader changed: %',spec.signature;END IF;
  INSERT INTO recording_privacy_helper_transition SELECT p.oid,p.prosrc,to_jsonb(p) FROM pg_proc p WHERE p.oid=oid_value;
  guarded:=regexp_replace(body,'\mBEGIN\M','BEGIN'||E'\n -- Recording privacy admission precedes body selection.\n '||spec.guard);
  EXECUTE replace(definition,body,guarded);
 END LOOP;
END $$;

-- Advance only the reviewed early-refusal changes. Other existing helper pins,
-- owner/grant metadata, and special normalization checks remain exact. The new
-- predicates/guards join that same closed manifest so their drift also fails.
DO $privacy_pins$
DECLARE original text;changed text;definition text;metadata jsonb;pin record;prior record;
 old_literal text;new_literal text;fingerprint text;last_literal text;counted integer;added integer:=0;
 helper oid;helper_metadata jsonb;
BEGIN
 SELECT prosrc,pg_get_functiondef(oid),to_jsonb(p)-'prosrc' INTO original,definition,metadata
  FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure;
 changed:=original;
 FOR pin IN SELECT m[1]::oid AS function_oid,m[2] AS fingerprint
  FROM regexp_matches(original,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g') m LOOP
  SELECT * INTO prior FROM recording_privacy_helper_transition t WHERE t.function_oid=pin.function_oid;
  IF FOUND THEN
   -- The feedback-source branch deliberately normalizes this helper's original
   -- fingerprint while checking its complete reviewed body separately.
   IF position(format('p.oid=%s::oid',pin.function_oid) in original)>0 THEN
    old_literal:=quote_literal(prior.old_source);
    SELECT quote_literal(prosrc) INTO new_literal FROM pg_proc WHERE oid=pin.function_oid;
   ELSE
    old_literal:=format('(%s::oid,%L::text)',pin.function_oid,pin.fingerprint);
    SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO fingerprint FROM pg_proc p WHERE oid=pin.function_oid;
    new_literal:=format('(%s::oid,%L::text)',pin.function_oid,fingerprint);
   END IF;
   IF array_length(string_to_array(changed,old_literal),1)<>2 THEN
    RAISE EXCEPTION 'Recording privacy allocated helper pin changed: %',pin.function_oid::regprocedure;END IF;
   changed:=replace(changed,old_literal,new_literal);
  END IF;
  last_literal:=format('(%s::oid,%L::text)',pin.function_oid,pin.fingerprint);
 END LOOP;
 SELECT count(*) INTO counted FROM regexp_matches(original,'\(([0-9]+)::oid,''([0-9a-f]{64})''::text\)','g');
 IF counted<>122 OR array_length(string_to_array(changed,'SELECT count(*)=122'),1)<>2 THEN
  RAISE EXCEPTION 'Recording privacy predecessor helper manifest changed';END IF;
 -- Add new helpers after the final unchanged predecessor pin.
 FOREACH helper IN ARRAY ARRAY['public.session_recording_read_allowed(uuid)'::regprocedure::oid,
  'public.recording_source_read_allowed(uuid,text,uuid)'::regprocedure::oid,
  'public.guard_session_recording_privacy()'::regprocedure::oid,
  'public.refuse_quarantined_recording_message()'::regprocedure::oid] LOOP
  SELECT to_jsonb(p) INTO helper_metadata FROM pg_proc p WHERE p.oid=helper;
  fingerprint:=encode(sha256(convert_to(helper_metadata::text,'UTF8')),'hex');
  new_literal:=format('(%s::oid,%L::text)',helper,fingerprint);
  IF array_length(string_to_array(changed,last_literal),1)<>2 THEN RAISE EXCEPTION 'Recording privacy final helper pin changed';END IF;
  changed:=replace(changed,last_literal,last_literal||','||new_literal);last_literal:=new_literal;added:=added+1;
 END LOOP;
 changed:=replace(changed,'SELECT count(*)=122','SELECT count(*)='||(counted+added));
 EXECUTE replace(definition,original,changed);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE oid='public.application_memory_statement_helpers_current()'::regprocedure) IS DISTINCT FROM metadata
  OR application_memory_statement_helpers_current() IS DISTINCT FROM true THEN
  RAISE EXCEPTION 'Recording privacy helper pin transition failed';END IF;
END $privacy_pins$;
COMMIT;
