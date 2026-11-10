-- [COMP:api/channel-recording] Explicit review releases provider-visible text only.
-- The historical source's recorded user authorizes release to the CURRENT
-- exact bot/assistant/conversation route and original group audience. This
-- review never manufactures historical connector provenance.
BEGIN;
CREATE TABLE channel_recording_recovery_receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL,
 source_session_id uuid NOT NULL, target_session_id uuid NOT NULL,
 policy_id uuid NOT NULL, snapshot_token text NOT NULL, snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(source_session_id), UNIQUE(target_session_id)
);
REVOKE ALL ON channel_recording_recovery_receipts FROM PUBLIC;
CREATE FUNCTION refuse_recording_recovery_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'recording_recovery_receipt_immutable' USING ERRCODE='42501'; END $$;
CREATE TRIGGER recording_recovery_receipt_immutable BEFORE UPDATE OR DELETE ON channel_recording_recovery_receipts
 FOR EACH ROW EXECUTE FUNCTION refuse_recording_recovery_receipt_mutation();

CREATE FUNCTION telegram_recording_recovery_text(body jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN jsonb_typeof(body)='string' THEN CASE WHEN length(trim(body#>>'{}'))>0
 THEN jsonb_build_array(jsonb_build_object('type','text','text',body#>>'{}')) ELSE NULL END
 WHEN jsonb_typeof(body)='array' THEN CASE WHEN jsonb_array_length(body)>0
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(body) b WHERE jsonb_typeof(b)<>'object'
   OR b->>'type' IS DISTINCT FROM 'text' OR jsonb_typeof(b->'text') IS DISTINCT FROM 'string')
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(body) b WHERE length(trim(b->>'text'))>0)
 THEN (SELECT jsonb_agg(jsonb_build_object('type','text','text',b->>'text') ORDER BY n)
 FROM jsonb_array_elements(body) WITH ORDINALITY a(b,n)) ELSE NULL END ELSE NULL END
$$;

-- A provider id alone does not release a more restricted field. Only public
-- text already inside this exact stored group audience is eligible.
CREATE FUNCTION telegram_recording_recovery_projection(source uuid) RETURNS SETOF session_messages
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT DISTINCT ON(m.role,m.channel_message_id) m.* FROM session_messages m JOIN sessions s ON s.id=m.session_id WHERE s.id=source
 AND m.role IN('user','assistant') AND nullif(m.channel_message_id,'') IS NOT NULL
 AND telegram_recording_recovery_text(m.content) IS NOT NULL
 AND (m.attachments IS NULL OR m.attachments='[]'::jsonb) AND NOT m.scope_held
 AND m.workspace_id=s.workspace_id AND m.user_id IS NULL AND m.assistant_id IS NULL
 AND sensitivity_rank(m.sensitivity)<=sensitivity_rank(s.effective_clearance)
 AND m.compartments <@ s.context_compartments
 AND m.project_ids <@ CASE WHEN s.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[s.context_project_id] END
 AND office_labels_scope_allows(m.workspace_id,m.sensitivity,m.compartments,m.project_ids,NULL,NULL,false)
 ORDER BY m.role,m.channel_message_id,m.sequence_num,m.id
$$;

CREATE FUNCTION telegram_recording_recovery_snapshot(actor uuid,w uuid,ch uuid,source uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE s sessions; ci channel_integrations; a assistants; binding jsonb; facts jsonb; chosen jsonb;
 chat text; total bigint; projected bigint;
BEGIN
 IF actor IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')::uuid THEN RETURN NULL; END IF;
 SELECT * INTO s FROM sessions WHERE id=source;
 SELECT i.* INTO ci FROM channel_integrations i JOIN channels c ON c.id=i.channel_id
 WHERE c.id=ch AND c.workspace_id=w AND c.status='active' AND i.status='active' AND i.channel_type='telegram';
 SELECT * INTO a FROM assistants WHERE id=s.assistant_id AND workspace_id=w;
 IF s.id IS NULL OR ci.id IS NULL OR a.id IS NULL OR ci.bot_user_id IS NULL
 OR s.workspace_id IS DISTINCT FROM w OR s.user_id IS DISTINCT FROM actor OR s.visibility<>'workspace'
 OR s.channel_type<>'telegram' OR s.anchor_kind<>'channel' OR s.channel_id !~ '^-[0-9]+(:topic:[0-9]+|:discussion:[0-9]+)?$'
 OR NOT s.recording_privacy_held OR s.recording_revision IS NOT NULL OR s.recording_policy_id IS NOT NULL
 OR (ci.recording_owner_user_id IS NOT NULL AND ci.recording_owner_user_id<>actor)
 OR NOT EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=actor AND role IN ('owner','admin'))
 OR NOT office_labels_scope_allows(w,s.effective_clearance,s.context_compartments,
   CASE WHEN s.context_project_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[s.context_project_id] END,NULL,NULL,false)
 OR sensitivity_rank(s.effective_clearance)>sensitivity_rank(a.clearance)
 OR (a.compartments IS NOT NULL AND NOT s.context_compartments <@ a.compartments)
 THEN RETURN NULL; END IF;
 chat:=split_part(s.channel_id,':',1);
 -- Same precedence as pickTelegramRoutingForSurface: exact topic/discussion,
 -- then parent chat, then default. A shadowed parent route grants nothing.
 IF (SELECT ca.assistant_id FROM channel_assistants ca WHERE ca.channel_id=ch
 AND (ca.external_surface_id IN(s.channel_id,chat) OR ca.external_surface_id IS NULL)
 ORDER BY CASE WHEN ca.external_surface_id=s.channel_id THEN 1 WHEN ca.external_surface_id=chat THEN 2 ELSE 3 END LIMIT 1)
 IS DISTINCT FROM a.id THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(ci.config->'requireMentionOverrides','[]')) scope
 WHERE scope->>'chatId'=chat AND (scope->>'topicId' IS NULL OR s.channel_id=chat||':topic:'||(scope->>'topicId')))
 AND NOT EXISTS(SELECT 1 FROM channel_assistants ca WHERE ca.channel_id=ch AND ca.external_surface_id=s.channel_id AND ca.assistant_id=a.id)
 THEN RETURN NULL; END IF;
 SELECT b INTO binding FROM jsonb_array_elements(coalesce(ci.config->'deliveryAudienceBindings','[]')) b
 WHERE b->>'version'='1' AND b->>'audienceType'='group' AND b->>'channelId' IN(s.channel_id,chat)
 AND b->>'recipientUserId' IS NULL AND (b->>'expiresAt' IS NULL OR (b->>'expiresAt')::timestamptz>now())
 AND (b->>'channelId'=s.channel_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(ci.config->'deliveryAudienceBindings','[]')) exact_binding WHERE exact_binding->>'channelId'=s.channel_id))
 AND EXISTS(SELECT 1 FROM workspace_members WHERE workspace_id=w AND user_id=(b->>'approvedByUserId')::uuid AND role IN('owner','admin'))
 AND sensitivity_rank(b->>'clearance')>=sensitivity_rank(s.effective_clearance)
 AND to_jsonb(s.context_compartments)<@coalesce(b->'compartments','[]')
 AND (s.context_project_id IS NULL OR coalesce(b->'projectIds','[]') ? s.context_project_id::text) LIMIT 1;
 IF binding IS NULL OR EXISTS(SELECT 1 FROM channel_recording_policies p WHERE workspace_id=w AND bot_id=ci.bot_user_id AND conversation_id=s.channel_id
 AND NOT EXISTS(SELECT 1 FROM channel_recording_recovery_receipts r WHERE r.source_session_id=s.id AND r.actor_id=actor
 AND r.policy_id=p.id AND r.target_session_id=p.session_id AND p.enabled AND p.destination='workspace'
 AND p.revision=1 AND p.owner_user_id=actor AND p.integration_id=ci.id AND p.project_id IS NOT DISTINCT FROM s.context_project_id
 AND EXISTS(SELECT 1 FROM sessions target WHERE target.id=r.target_session_id AND target.recording_policy_id=p.id
 AND target.recording_revision=1 AND NOT target.recording_privacy_held AND target.workspace_id=w AND target.user_id=actor
 AND target.assistant_id=s.assistant_id AND target.channel_id=s.channel_id AND target.visibility='workspace'
 AND target.effective_clearance=s.effective_clearance AND target.context_group_id IS NOT DISTINCT FROM s.context_group_id
 AND target.context_project_id IS NOT DISTINCT FROM s.context_project_id AND target.context_compartments=s.context_compartments))) THEN RETURN NULL; END IF;
 IF s.context_project_id IS NOT NULL AND (NOT project_member_live(s.context_project_id,'user',actor)
 OR NOT project_member_live(s.context_project_id,'assistant',a.id)
 OR NOT EXISTS(SELECT 1 FROM workspace_projects p JOIN project_shared_scopes ps ON ps.project_id=p.id
 WHERE p.id=s.context_project_id AND p.workspace_id=w AND p.status='active' AND ps.status='active')) THEN RETURN NULL; END IF;
 SELECT count(*) INTO total FROM session_messages m WHERE m.session_id=s.id;
 SELECT count(*) INTO projected FROM telegram_recording_recovery_projection(s.id);
 IF projected=0 THEN RETURN NULL; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.id,'sequence',m.sequence_num,'scopeVersion',m.scope_version,
 'scope',jsonb_build_object('workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,
 'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids),
 'hash',encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex')) ORDER BY m.sequence_num),'[]')
 INTO chosen FROM telegram_recording_recovery_projection(s.id) m;
 facts:=jsonb_build_object('source',to_jsonb(s),'integration',jsonb_build_object('id',ci.id,'bot',ci.bot_user_id,
 'config',jsonb_build_object('requireMention',ci.config->'requireMention','requireMentionOverrides',ci.config->'requireMentionOverrides',
 'deliveryAudienceBindings',ci.config->'deliveryAudienceBindings','userAccessMode',ci.config->'userAccessMode','allowedUserIds',ci.config->'allowedUserIds'),
 'owner',coalesce(ci.recording_owner_user_id,actor)),
 'routes',(SELECT coalesce(jsonb_agg(jsonb_build_object('assistantId',ca.assistant_id,'surface',ca.external_surface_id)
 ORDER BY ca.assistant_id,ca.external_surface_id),'[]') FROM channel_assistants ca WHERE ca.channel_id=ch),
 'assistant',to_jsonb(a)-'system_prompt','selected',chosen,'total',total,'actor',actor,'binding',binding);
 RETURN jsonb_build_object('sessionId',s.id,'conversationId',s.channel_id,'assistantId',a.id,'assistantName',a.name,'title',s.title,
 'messageCount',projected,'skippedMessageCount',total-projected,'sensitivity',s.effective_clearance,'compartments',s.context_compartments,
 'projectId',s.context_project_id,'projectName',(SELECT name FROM workspace_projects WHERE id=s.context_project_id),
 'snapshotToken',encode(sha256(convert_to(facts::text,'UTF8')),'hex'),'selected',chosen,'sourceSnapshot',jsonb_build_object(
 'workspaceId',s.workspace_id,'userId',s.user_id,'assistantId',s.assistant_id,'visibility',s.visibility,
 'channelType',s.channel_type,'channelId',s.channel_id,'appId',s.app_id,
 'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,'contextCompartments',s.context_compartments,
 'effectiveClearance',s.effective_clearance),
 'integrationId',ci.id,'botId',ci.bot_user_id);
END $$;

CREATE FUNCTION preview_telegram_recording_recovery(actor uuid,w uuid,ch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('candidates',coalesce(jsonb_agg(candidate-'selected'-'sourceSnapshot'-'integrationId'-'botId'),'[]')) FROM (
 SELECT telegram_recording_recovery_snapshot(actor,w,ch,s.id) candidate FROM sessions s
 WHERE s.workspace_id=w AND s.user_id=actor AND s.recording_privacy_held
 AND NOT EXISTS(SELECT 1 FROM channel_recording_recovery_receipts WHERE source_session_id=s.id)) q WHERE candidate IS NOT NULL
$$;

CREATE FUNCTION apply_telegram_recording_recovery(actor uuid,w uuid,ch uuid,source uuid,token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE snapshot jsonb; s sessions; ci channel_integrations; prior channel_recording_recovery_receipts; target uuid=gen_random_uuid(); policy uuid=gen_random_uuid(); receipt uuid=gen_random_uuid();
BEGIN
 PERFORM 1 FROM workspaces WHERE id=w FOR UPDATE;
 PERFORM 1 FROM sessions WHERE id=source FOR UPDATE;
 PERFORM 1 FROM session_messages WHERE session_id=source FOR SHARE;
 PERFORM 1 FROM assistants WHERE id=(SELECT assistant_id FROM sessions WHERE id=source) FOR SHARE;
 PERFORM 1 FROM channels WHERE id=ch FOR SHARE;
 PERFORM 1 FROM channel_integrations WHERE channel_id=ch FOR UPDATE;
 PERFORM 1 FROM workspace_members WHERE workspace_id=w FOR SHARE;
 PERFORM 1 FROM channel_assistants WHERE channel_id=ch FOR SHARE;
 PERFORM 1 FROM channel_recording_policies WHERE workspace_id=w FOR UPDATE;
 PERFORM 1 FROM workspace_projects WHERE id=(SELECT context_project_id FROM sessions WHERE id=source) FOR SHARE;
 PERFORM 1 FROM project_shared_scopes WHERE project_id=(SELECT context_project_id FROM sessions WHERE id=source) FOR SHARE;
 snapshot:=telegram_recording_recovery_snapshot(actor,w,ch,source);
 IF snapshot IS NULL OR snapshot->>'snapshotToken' IS DISTINCT FROM token THEN
 RAISE EXCEPTION 'recording_recovery_unavailable' USING ERRCODE='42501'; END IF;
 SELECT * INTO prior FROM channel_recording_recovery_receipts WHERE source_session_id=source AND actor_id=actor AND snapshot_token=token;
 IF prior.id IS NOT NULL THEN RETURN jsonb_build_object('sessionId',prior.target_session_id,'policyId',prior.policy_id,'revision',1); END IF;
 SELECT * INTO s FROM sessions WHERE id=source;
 SELECT * INTO ci FROM channel_integrations WHERE id=(snapshot->>'integrationId')::uuid;
 UPDATE channel_integrations SET recording_owner_user_id=actor WHERE id=ci.id AND recording_owner_user_id IS NULL;
 INSERT INTO channel_recording_policies(id,integration_id,workspace_id,bot_id,owner_user_id,conversation_id,destination,project_id,session_id)
 VALUES(policy,ci.id,w,ci.bot_user_id,actor,s.channel_id,'workspace',s.context_project_id,NULL);
 PERFORM set_config('app.recording_session_admission',jsonb_build_object('policyId',policy,'revision',1,'sessionId',target,
 'ownerId',actor,'workspaceId',w,'assistantId',s.assistant_id,'destination','workspace','conversationId',s.channel_id,
 'effectiveClearance',s.effective_clearance,'contextGroupId',s.context_group_id,'contextProjectId',s.context_project_id,'contextCompartments',s.context_compartments)::text,true);
 INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id,app_id,app_origin,visibility,anchor_kind,anchor_ref,
 effective_clearance,clearance_source,context_group_id,context_project_id,context_compartments,recording_policy_id,recording_revision,room_capture,title)
 VALUES(target,s.assistant_id,actor,w,'telegram',s.channel_id,'recording:'||target,'chat','workspace','channel',s.channel_id,
 s.effective_clearance,'anchor',s.context_group_id,s.context_project_id,s.context_compartments,policy,1,false,s.title);
 UPDATE channel_recording_policies SET session_id=target WHERE id=policy;
 -- Explicit reviewed publication of provider-visible text. No generic source
 -- derivation is created: held originals cannot authorize any other reads.
 INSERT INTO session_messages(session_id,role,content,sequence_num,created_at,channel_message_id,sender_user_id,sender_assistant_id,published_sender_name,
 workspace_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held)
 SELECT target,m.role,telegram_recording_recovery_text(m.content),row_number() OVER(ORDER BY m.sequence_num),m.created_at,m.channel_message_id,
 m.sender_user_id,CASE WHEN EXISTS(SELECT 1 FROM assistants sender WHERE sender.id=m.sender_assistant_id AND sender.workspace_id=w) THEN m.sender_assistant_id ELSE NULL END,
 m.published_sender_name,m.workspace_id,m.user_id,m.assistant_id,m.sensitivity,m.compartments,m.project_ids,1,false
 FROM telegram_recording_recovery_projection(source) m WHERE snapshot->'selected' @> jsonb_build_array(jsonb_build_object('id',m.id))
 ORDER BY m.sequence_num;
 INSERT INTO channel_recording_messages(policy_id,provider_message_id,session_id)
 SELECT policy,m.channel_message_id,target FROM session_messages m WHERE m.session_id=target ON CONFLICT DO NOTHING;
 INSERT INTO channel_recording_recovery_receipts(id,actor_id,source_session_id,target_session_id,policy_id,snapshot_token,snapshot)
 VALUES(receipt,actor,source,target,policy,token,snapshot||jsonb_build_object('projection',(
 SELECT jsonb_agg(jsonb_build_object('sourceMessageId',original.id,'targetMessageId',copied.id,
 'providerMessageId',copied.channel_message_id,'role',copied.role,'scope',jsonb_build_object('workspaceId',copied.workspace_id,
 'userId',copied.user_id,'assistantId',copied.assistant_id,'sensitivity',copied.sensitivity,'compartments',copied.compartments,'projectIds',copied.project_ids)) ORDER BY copied.sequence_num)
 FROM telegram_recording_recovery_projection(source) original JOIN session_messages copied
 ON copied.session_id=target AND copied.role=original.role AND copied.channel_message_id=original.channel_message_id)));
 RETURN jsonb_build_object('sessionId',target,'policyId',policy,'revision',1);
END $$;
REVOKE ALL ON FUNCTION telegram_recording_recovery_snapshot(uuid,uuid,uuid,uuid),
 telegram_recording_recovery_projection(uuid),
 telegram_recording_recovery_text(jsonb),preview_telegram_recording_recovery(uuid,uuid,uuid),
 apply_telegram_recording_recovery(uuid,uuid,uuid,uuid,text),refuse_recording_recovery_receipt_mutation() FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON channel_recording_recovery_receipts FROM app_user;
 GRANT EXECUTE ON FUNCTION telegram_recording_recovery_snapshot(uuid,uuid,uuid,uuid),preview_telegram_recording_recovery(uuid,uuid,uuid),apply_telegram_recording_recovery(uuid,uuid,uuid,uuid,text) TO app_user;
 END IF; END $$;
COMMIT;
