-- [COMP:api/conversation-visibility] Immutable dialogue capture, not an ancestry
-- proof. This source is uninstalled until its authenticated successor also
-- transfers admission, publication, downstream derivation and invalidation.

-- Indexed maintenance maxima, not a second audience or a copied dependency
-- inventory. The authenticated successor installs these additions atomically.
ALTER TABLE public.conversation_envelopes
 ADD COLUMN record_captured_through integer NOT NULL DEFAULT 0 CHECK(record_captured_through>=0),
 ADD COLUMN record_topic_captured_through integer NOT NULL DEFAULT 0 CHECK(record_topic_captured_through>=0),
 ADD COLUMN record_data_revision bigint NOT NULL DEFAULT 1 CHECK(record_data_revision>0),
 ADD COLUMN record_dirty_from integer DEFAULT 0 CHECK(record_dirty_from>=0);

CREATE FUNCTION public.guard_conversation_record_capture() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $immutable$
BEGIN
 IF (OLD.binding->>'kind'='conversation_record_v1' OR NEW.binding->>'kind'='conversation_record_v1')
  AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'conversation_record_immutable' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $immutable$;
REVOKE ALL ON FUNCTION public.guard_conversation_record_capture() FROM PUBLIC,app_user;
CREATE TRIGGER conversation_record_capture_immutable BEFORE UPDATE ON public.private_transcript_observations
 FOR EACH ROW EXECUTE FUNCTION public.guard_conversation_record_capture();

CREATE FUNCTION public.withdraw_conversation_record_targets(targets jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $withdraw$
DECLARE target record;
BEGIN
 -- Lock even if an earlier snapshot showed no captures. A concurrent first
 -- capture may be advancing its maximum: checking before this lock would let
 -- an edit commit without withdrawing the snapshot that just read old bytes.
 FOR target IN SELECT e.session_id FROM public.conversation_envelopes e
  WHERE e.session_id IN(SELECT (value->>'sessionId')::uuid FROM jsonb_array_elements(targets))
  ORDER BY e.session_id FOR UPDATE OF e
 LOOP
  UPDATE public.conversation_envelopes e SET record_data_revision=e.record_data_revision+1,
   record_dirty_from=least(e.record_dirty_from,(SELECT min((item->>'sequence')::integer) FROM jsonb_array_elements(targets) item
    WHERE (item->>'sessionId')::uuid=e.session_id)),
   version=e.version+CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(targets) item
    WHERE (item->>'sessionId')::uuid=e.session_id
     AND coalesce((item->>'withdraw')::boolean,true)
     AND (item->>'sequence')::integer<=CASE WHEN (item->>'topicOnly')::boolean
      THEN e.record_topic_captured_through ELSE e.record_captured_through END
     AND CASE WHEN (item->>'topicOnly')::boolean THEN e.record_topic_captured_through ELSE e.record_captured_through END>0)
    THEN 1 ELSE 0 END WHERE e.session_id=target.session_id;
 END LOOP;
END $withdraw$;
REVOKE ALL ON FUNCTION public.withdraw_conversation_record_targets(jsonb) FROM PUBLIC,app_user;

CREATE FUNCTION public.withdraw_conversation_record_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $withdraw_rows$
DECLARE previous jsonb;following jsonb;targets jsonb:='[]';item jsonb;sid uuid;position integer;withdraw boolean:=true;
BEGIN
 IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
 IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW); END IF;
 IF TG_OP='UPDATE' AND previous=following THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='session_messages' THEN
  IF TG_OP='UPDATE' AND (previous-ARRAY['workspace_id','sensitivity','compartments','project_ids','scope_version',
    'channel_message_id','topic_label','topic_confidence','reply_to_text'])
   IS NOT DISTINCT FROM (following-ARRAY['workspace_id','sensitivity','compartments','project_ids','scope_version',
    'channel_message_id','topic_label','topic_confidence','reply_to_text']) THEN withdraw:=false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(previous,following)) WHERE value<>'null'
  LOOP
   targets:=targets||jsonb_build_array(jsonb_build_object('sessionId',item->>'session_id','sequence',item->'sequence_num','topicOnly',false,'withdraw',withdraw));
  END LOOP;
 ELSIF TG_TABLE_NAME='session_message_annotation_heads' THEN
  IF TG_OP='UPDATE' AND previous=following THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',m.session_id,'sequence',m.sequence_num,'topicOnly',true,'withdraw',TG_OP<>'INSERT')),'[]') INTO targets
   FROM public.session_messages m WHERE m.id IN(SELECT (value->>'message_id')::uuid
    FROM jsonb_array_elements(jsonb_build_array(previous,following)) WHERE value<>'null');
 ELSIF TG_TABLE_NAME='conversation_message_quarantine' THEN
  IF TG_OP='UPDATE' AND previous=following THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',m.session_id,'sequence',m.sequence_num,'topicOnly',false)),'[]') INTO targets
   FROM public.session_messages m WHERE m.id IN(SELECT (value->>'message_id')::uuid
    FROM jsonb_array_elements(jsonb_build_array(previous,following)) WHERE value<>'null');
 ELSIF TG_TABLE_NAME='scope_resource_states' THEN
  IF TG_OP='UPDATE' AND previous->'review_state' IS NOT DISTINCT FROM following->'review_state'
   AND previous->'resource_kind' IS NOT DISTINCT FROM following->'resource_kind'
   AND previous->'resource_id' IS NOT DISTINCT FROM following->'resource_id' THEN RETURN NULL; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(jsonb_build_array(previous,following))
   WHERE value->>'review_state'='held'
  LOOP
   IF item->>'resource_kind'='session' THEN
    targets:=targets||jsonb_build_array(jsonb_build_object('sessionId',item->>'resource_id','sequence',0,'topicOnly',false));
   ELSIF item->>'resource_kind'='session_message' THEN
    SELECT session_id,sequence_num INTO sid,position FROM public.session_messages WHERE id=(item->>'resource_id')::uuid;
    IF FOUND THEN targets:=targets||jsonb_build_array(jsonb_build_object('sessionId',sid,'sequence',position,'topicOnly',false)); END IF;
   ELSIF item->>'resource_kind'='session_context_revision' THEN
    SELECT m.session_id,m.sequence_num INTO sid,position FROM public.session_message_annotation_heads h
     JOIN public.session_messages m ON m.id=h.message_id WHERE h.scope_revision_id=(item->>'resource_id')::uuid;
    IF FOUND THEN targets:=targets||jsonb_build_array(jsonb_build_object('sessionId',sid,'sequence',position,'topicOnly',true)); END IF;
   END IF;
  END LOOP;
 ELSIF TG_TABLE_NAME='session_context_scope_revisions' THEN
  withdraw:=TG_OP='DELETE' OR previous->'scope_held' IS DISTINCT FROM following->'scope_held';
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',m.session_id,'sequence',m.sequence_num,'topicOnly',true,'withdraw',withdraw)),'[]') INTO targets
   FROM public.session_message_annotation_heads h JOIN public.session_messages m ON m.id=h.message_id
   WHERE h.scope_revision_id IN(SELECT (value->>'id')::uuid FROM jsonb_array_elements(jsonb_build_array(previous,following)) WHERE value<>'null');
 ELSIF TG_TABLE_NAME='session_context_revision_contents' THEN
  IF TG_OP='UPDATE' AND previous=following THEN RETURN NULL; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('sessionId',m.session_id,'sequence',m.sequence_num,'topicOnly',true)),'[]') INTO targets
   FROM public.session_message_annotation_heads h JOIN public.session_messages m ON m.id=h.message_id
   WHERE h.scope_revision_id IN(SELECT (value->>'revision_id')::uuid FROM jsonb_array_elements(jsonb_build_array(previous,following)) WHERE value<>'null');
 END IF;
 PERFORM public.withdraw_conversation_record_targets(targets);
 RETURN NULL;
END $withdraw_rows$;
REVOKE ALL ON FUNCTION public.withdraw_conversation_record_rows() FROM PUBLIC,app_user;
CREATE TRIGGER conversation_record_message_withdrawal AFTER INSERT OR UPDATE OR DELETE ON public.session_messages
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_record_rows();
CREATE TRIGGER conversation_record_annotation_withdrawal AFTER INSERT OR UPDATE OR DELETE ON public.session_message_annotation_heads
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_record_rows();
CREATE TRIGGER conversation_record_quarantine_withdrawal AFTER INSERT OR UPDATE OR DELETE ON public.conversation_message_quarantine
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_record_rows();
CREATE TRIGGER conversation_record_review_withdrawal AFTER INSERT OR UPDATE OR DELETE ON public.scope_resource_states
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_record_rows();
CREATE TRIGGER conversation_record_revision_withdrawal AFTER UPDATE OR DELETE ON public.session_context_scope_revisions
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_record_rows();
CREATE TRIGGER conversation_record_revision_content_withdrawal AFTER UPDATE OR DELETE ON public.session_context_revision_contents
 FOR EACH ROW EXECUTE FUNCTION public.withdraw_conversation_record_rows();

CREATE FUNCTION public.read_conversation_record_source(w uuid,capture_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $source$
DECLARE o public.private_transcript_observations;e public.conversation_envelopes;s public.sessions;
BEGIN
 SELECT * INTO o FROM public.private_transcript_observations WHERE workspace_id=w AND id=capture_id;
 IF NOT FOUND OR o.binding->>'kind' IS DISTINCT FROM 'conversation_record_v1' THEN RETURN '{"held":true}'; END IF;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=o.session_id AND workspace_id=w;
 IF NOT FOUND OR o.binding->>'generation' IS DISTINCT FROM e.version::text
  OR public.session_recording_read_allowed(o.session_id) IS NOT TRUE
  OR public.scope_review_state_held('session',o.session_id) THEN RETURN '{"held":true}'; END IF;
 IF o.binding->'legacyRowsSelected'='true'::jsonb THEN
  SELECT * INTO s FROM public.sessions WHERE id=o.session_id;
  IF NOT FOUND OR public.conversation_legacy_enrolled(s.id,w,s.user_id,s.assistant_id) IS NOT TRUE THEN
   RETURN '{"held":true}';END IF;
 END IF;
 -- A descriptor is metadata, never a reader/destination authorization. The
 -- admission owner checks current conversation audience; external derivatives
 -- additionally prove their selected lineage/current floor at the real write.
 RETURN jsonb_build_object('workspaceId',w,'resourceKind','conversation_record','resourceId',o.id,'version','1',
  'userId',NULL,'assistantId',NULL,'sensitivity',o.sensitivity,'compartments',o.compartments,'projectIds',o.project_ids,
  'held',false,'validTo',NULL,'retractedAt',NULL);
END $source$;
REVOKE ALL ON FUNCTION public.read_conversation_record_source(uuid,uuid) FROM PUBLIC,app_user;

CREATE FUNCTION public.conversation_record_member_allowed(w uuid,capture_id uuid,actor uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $record_member$
DECLARE o public.private_transcript_observations;source jsonb;
BEGIN
 source:=public.read_conversation_record_source(w,capture_id);
 IF source->>'held' IS DISTINCT FROM 'false' THEN RETURN false; END IF;
 SELECT * INTO o FROM public.private_transcript_observations WHERE workspace_id=w AND id=capture_id;
 RETURN public.conversation_member_read_allowed(w,o.session_id,actor) IS TRUE;
END $record_member$;
REVOKE ALL ON FUNCTION public.conversation_record_member_allowed(uuid,uuid,uuid) FROM PUBLIC,app_user;

-- Shared payload selector. Reader and capture authority are proved by its
-- callers; this owner-only routine selects their already-admitted record.
CREATE FUNCTION public.conversation_record_rows(e public.conversation_envelopes,after_sequence integer,through_sequence integer,
 legacy_allowed boolean,viewer uuid,visual boolean) RETURNS SETOF public.session_messages
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $rows$
 SELECT m.* FROM public.session_messages m
 LEFT JOIN public.session_legacy_history_messages frozen ON legacy_allowed AND frozen.message_id=m.id AND frozen.session_id=m.session_id
 WHERE m.session_id=e.session_id AND m.sequence_num>after_sequence AND (through_sequence IS NULL OR m.sequence_num<=through_sequence)
  AND m.role IN ('user','assistant') AND m.scope_held IS NOT TRUE
  AND NOT EXISTS(SELECT 1 FROM public.scope_resource_states state WHERE state.resource_kind='session_message'
   AND state.resource_id=m.id AND state.review_state='held')
  AND (m.user_id IS NULL OR m.user_id=e.starter_user_id)
  AND (m.user_id IS NULL OR e.visibility='private_by_kind' OR e.visibility='configured_private' AND (visual OR m.user_id=viewer)
   OR e.classification='legacy_personal' AND public.conversation_consent_current(e.session_id) AND (visual OR m.user_id=viewer))
  AND (
   (e.workspace_id IS NULL AND e.starter_user_id=viewer AND m.workspace_id IS NULL)
   OR (m.workspace_id=e.workspace_id AND m.scope_version IS NOT NULL AND m.sensitivity IN ('public','internal','confidential')
    AND m.compartments IS NOT NULL AND m.project_ids IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM public.conversation_message_quarantine q WHERE q.message_id=m.id))
   OR (legacy_allowed AND e.visibility='private_by_kind'
    AND m.workspace_id IS NULL AND m.user_id IS NULL AND m.assistant_id IS NULL AND m.sensitivity IS NULL
    AND m.compartments IS NULL AND m.project_ids IS NULL AND m.scope_version IS NULL
    AND (m.sender_user_id IS NULL OR m.sender_user_id=e.starter_user_id)
    AND frozen.sequence_num=m.sequence_num AND frozen.fingerprint=encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex')
    AND NOT EXISTS(SELECT 1 FROM public.scope_derivations d WHERE d.resource_kind='session_message' AND d.resource_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM public.scope_resource_states state WHERE state.resource_kind='session_message' AND state.resource_id=m.id)
    AND NOT EXISTS(SELECT 1 FROM public.conversation_message_quarantine q WHERE q.message_id=m.id AND q.reason<>'missing_stamp')
    AND octet_length(m.content::text)<=131072)
  )
$rows$;
REVOKE ALL ON FUNCTION public.conversation_record_rows(public.conversation_envelopes,integer,integer,boolean,uuid,boolean) FROM PUBLIC,app_user;

-- One canonical model payload projection serves ordinary capture and the exact-copy compiler.
-- Its callers already own admission. This source has no authority-result cache.
CREATE FUNCTION public.project_conversation_record(e public.conversation_envelopes,after_sequence integer,through_sequence integer,
 topic_through integer,legacy_allowed boolean,viewer uuid,exact_visual_rows jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $project_record$
DECLARE rows jsonb;annotations jsonb;row_identity text;annotation_identity text;manifest jsonb;legacy_rows_selected boolean;
BEGIN
 WITH selected AS MATERIALIZED(
  SELECT source.* FROM public.conversation_record_rows(e,after_sequence,through_sequence,legacy_allowed,viewer,false) source
   WHERE exact_visual_rows IS NULL
  UNION ALL
  SELECT source.* FROM jsonb_populate_recordset(NULL::public.session_messages,coalesce(exact_visual_rows,'[]'::jsonb)) source
   WHERE exact_visual_rows IS NOT NULL AND (source.user_id IS NULL OR e.visibility='private_by_kind' OR source.user_id=viewer)
 ), payload AS MATERIALIZED(
  SELECT m.sequence_num,jsonb_build_object('id',m.id,'sessionId',m.session_id,'role',m.role,'content',m.content,
   'sequenceNum',m.sequence_num,'createdAt',m.created_at,'senderUserId',m.sender_user_id,
   'senderAssistantId',m.sender_assistant_id,'channelMessageId',m.channel_message_id,'attachments',m.attachments) value
  FROM selected m
 ), selected_annotations AS MATERIALIZED(
  SELECT m.sequence_num,jsonb_build_object('id',m.id,'sequenceNum',m.sequence_num,'revisionId',r.id,
   'version',r.scope_version::text,'content',revision_content.content) value,
   jsonb_build_array(to_jsonb(head),to_jsonb(r),to_jsonb(revision_content)) original
  FROM selected m
  JOIN public.session_message_annotation_heads head ON head.message_id=m.id AND head.session_id=m.session_id AND head.workspace_id=e.workspace_id
  JOIN public.session_context_scope_revisions r ON r.id=head.scope_revision_id AND r.workspace_id=head.workspace_id
  JOIN public.session_context_revision_contents revision_content ON revision_content.revision_id=r.id AND revision_content.workspace_id=r.workspace_id
  WHERE m.sequence_num<=topic_through AND r.scope_held IS FALSE
   AND NOT EXISTS(SELECT 1 FROM public.scope_resource_states state
    WHERE state.resource_kind='session_context_revision' AND state.resource_id=r.id AND state.review_state='held')
 ) SELECT
  (SELECT coalesce(jsonb_agg(value ORDER BY sequence_num),'[]') FROM payload),
  (SELECT coalesce(jsonb_agg(value ORDER BY sequence_num),'[]') FROM selected_annotations),
  (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.sequence_num),'[]')::text,'UTF8')),'hex') FROM selected m),
  (SELECT encode(sha256(convert_to(coalesce(jsonb_agg(original ORDER BY sequence_num),'[]')::text,'UTF8')),'hex') FROM selected_annotations),
  EXISTS(SELECT 1 FROM selected m WHERE m.workspace_id IS NULL)
 INTO rows,annotations,row_identity,annotation_identity,legacy_rows_selected;
 manifest:=jsonb_build_object('afterSequence',after_sequence,'throughSequence',through_sequence,'topicThroughSequence',topic_through,
  'modelRecipe','dialogue_text_v1',
  'rowCount',jsonb_array_length(rows),'annotationCount',jsonb_array_length(annotations),
  'rowIdentityDigest',row_identity,'annotationIdentityDigest',annotation_identity,
  'payloadDigest',encode(sha256(convert_to(jsonb_build_array(rows,annotations)::text,'UTF8')),'hex'));
 RETURN jsonb_build_object('rows',rows,'annotations',annotations,'manifest',manifest,'legacyRowsSelected',legacy_rows_selected);
END $project_record$;
REVOKE ALL ON FUNCTION public.project_conversation_record(public.conversation_envelopes,integer,integer,integer,boolean,uuid,jsonb) FROM PUBLIC,app_user;

CREATE FUNCTION public.capture_conversation_record_current(w uuid,sid uuid,after_sequence integer,through_sequence integer,topic_through integer,
 title_binding jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET timezone='UTC' AS $capture$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
 s public.sessions;e public.conversation_envelopes;legacy public.session_legacy_history;
 high integer;rows jsonb;annotations jsonb;projection jsonb;hard_projects uuid[];
 binding jsonb;manifest jsonb;capture_identity text;observed uuid;descriptor jsonb;legacy_rows_selected boolean;
BEGIN
 IF actor IS NULL OR after_sequence IS NULL OR through_sequence IS NULL OR topic_through IS NULL
  OR after_sequence<0 OR through_sequence<after_sequence OR topic_through<0 THEN
  RAISE EXCEPTION 'conversation_record_selection_invalid' USING ERRCODE='22023'; END IF;
 PERFORM id FROM public.workspaces WHERE id=w FOR SHARE;
 PERFORM user_id FROM public.workspace_members WHERE workspace_id=w AND user_id=actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM public.sessions WHERE id=sid FOR SHARE;
 SELECT * INTO e FROM public.conversation_envelopes WHERE session_id=sid AND workspace_id=w FOR UPDATE;
 IF NOT FOUND OR public.conversation_member_read_current(w,sid,actor) IS NOT TRUE THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 SELECT coalesce(max(sequence_num),0) INTO high FROM public.session_messages WHERE session_id=sid;
 IF through_sequence>high OR topic_through>high THEN RAISE EXCEPTION 'conversation_record_selection_invalid' USING ERRCODE='22023'; END IF;
 hard_projects:=public.conversation_hard_project_ids(e.compartments);
 IF through_sequence>e.record_captured_through OR topic_through>e.record_topic_captured_through THEN
  UPDATE public.conversation_envelopes SET record_captured_through=greatest(record_captured_through,through_sequence),
   record_topic_captured_through=greatest(record_topic_captured_through,topic_through) WHERE session_id=sid;
 END IF;
 -- Preserve the reviewed frozen legacy cohort. Its original descriptor and
 -- complete row fingerprint are authority/provenance, not a newly invented
 -- missing-envelope exemption. Any later mutation/hold still withdraws it.
 IF e.visibility='private_by_kind' AND public.enroll_conversation_legacy_history(sid) THEN
  SELECT * INTO legacy FROM public.session_legacy_history h WHERE h.session_id=sid
   AND h.user_id=s.user_id AND h.workspace_id=w AND public.conversation_legacy_enrolled(sid,w,s.user_id,s.assistant_id);
 END IF;
 IF to_regprocedure('public.read_compiled_conversation_payload(conversation_envelopes,integer,integer,integer,boolean,uuid,text)') IS NOT NULL THEN
  projection:=public.read_compiled_conversation_payload(e,after_sequence,through_sequence,topic_through,legacy.session_id IS NOT NULL,actor,'dialogue_text_v1');
  IF projection IS NULL THEN
   PERFORM public.enqueue_exact_conversation_record(e,after_sequence,through_sequence,topic_through,legacy.session_id IS NOT NULL);
  END IF;
 END IF;
 IF projection IS NULL THEN
  projection:=public.project_conversation_record(e,after_sequence,through_sequence,topic_through,legacy.session_id IS NOT NULL,actor);
 END IF;
 rows:=projection->'rows';annotations:=projection->'annotations';manifest:=projection->'manifest';
 legacy_rows_selected:=(projection->>'legacyRowsSelected')::boolean;
 binding:=jsonb_build_object('kind','conversation_record_v1','sessionId',sid,'generation',e.version::text,
  'readerUserId',actor,'purpose',CASE WHEN title_binding IS NULL THEN 'native_member_dialogue' ELSE 'native_session_title' END,
  'recipe','dialogue_text_v1','legacyRowsSelected',legacy_rows_selected)
  ||CASE WHEN title_binding IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('titleBinding',title_binding) END;
 -- Constant-size provenance per capture, independent of history depth. The
 -- selected row bytes/versions are hashed once during the already-required
 -- data acquisition; replay/read admission never walks that history again.
 capture_identity:=encode(sha256(convert_to(jsonb_build_array(w,sid,actor,binding,manifest,e.cap,e.compartments,hard_projects)::text,'UTF8')),'hex');
 INSERT INTO public.private_transcript_observations(workspace_id,session_id,user_id,binding,manifest,sensitivity,compartments,project_ids,identity)
 -- Retention belongs to the immutable conversation starter, not an incidental
 -- reader whose account deletion must not erase shared record provenance. The
 -- actual capturing reader remains bound above and in the capture identity.
 VALUES(w,sid,e.starter_user_id,binding,manifest,e.cap,e.compartments,hard_projects,capture_identity)
 ON CONFLICT(session_id,identity) DO NOTHING RETURNING id INTO observed;
 IF observed IS NULL THEN SELECT id INTO observed FROM public.private_transcript_observations o WHERE o.session_id=sid AND o.identity=capture_identity; END IF;
 descriptor:=public.read_conversation_record_source(w,observed);
 IF descriptor->>'held' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('source',descriptor-ARRAY['held','validTo','retractedAt'],'rows',rows,'annotations',annotations,
  'generation',e.version::text,'dataRevision',e.record_data_revision::text,'manifest',manifest);
END $capture$;
REVOKE ALL ON FUNCTION public.capture_conversation_record_current(uuid,uuid,integer,integer,integer,jsonb) FROM PUBLIC,app_user;

CREATE FUNCTION public.capture_native_conversation_record(w uuid,sid uuid,device uuid,native_version integer,
 after_sequence integer,through_sequence integer,topic_through integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $native$
DECLARE actor uuid:=nullif(current_setting('app.current_user_id',true),'')::uuid;
BEGIN
 IF actor IS NULL OR EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class rel ON rel.oid='public.sessions'::regclass
  WHERE role.rolname=session_user AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,rel.relowner,'USAGE'))) THEN
  RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 PERFORM a.id FROM public.auth_sessions a JOIN public.users u ON u.id=a.user_id
  WHERE a.id=device AND a.user_id=actor AND a.auth_version=native_version AND u.auth_version=native_version
   AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() FOR SHARE OF a,u;
 IF NOT FOUND THEN RAISE EXCEPTION 'conversation_access_denied' USING ERRCODE='42501'; END IF;
 RETURN public.capture_conversation_record_current(w,sid,after_sequence,through_sequence,topic_through);
END $native$;
REVOKE ALL ON FUNCTION public.capture_native_conversation_record(uuid,uuid,uuid,integer,integer,integer,integer) FROM PUBLIC,app_user;
-- The authenticated successor grants only the finite native wrapper. Verified
-- channel/visitor purposes require their separately bound host-owned port.
