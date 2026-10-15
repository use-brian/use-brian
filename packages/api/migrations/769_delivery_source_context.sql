-- Source floors and navigation, no content release through client/deal links.
-- [COMP:api/crm-delivery-oversight]
-- Spec: docs/architecture/features/client-delivery-oversight.md
BEGIN;
CREATE OR REPLACE FUNCTION crm_delivery_source_snapshot(w uuid,k text,i uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r jsonb; s jsonb; body text; author uuid; role_name text='unknown'; origin uuid; occurred timestamptz; decision jsonb; request_floor jsonb;
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
  SELECT jsonb_build_object('id',d.id,'actor',d.actor_user_id,'at',d.created_at,'changes',v.changes),jsonb_build_object('userId',q.user_id,'assistantId',q.assistant_id,'sensitivity',q.sensitivity,'compartments',q.compartments,'projectIds',q.project_ids) INTO decision,request_floor
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
 IF k='entity' THEN
  IF request_floor IS NULL THEN RETURN NULL; END IF;
  IF (s->>'userId' IS NOT NULL AND request_floor->>'userId' IS NOT NULL AND s->>'userId'<>request_floor->>'userId')
   OR (s->>'assistantId' IS NOT NULL AND request_floor->>'assistantId' IS NOT NULL AND s->>'assistantId'<>request_floor->>'assistantId') THEN RETURN NULL; END IF;
  s:=s||jsonb_build_object('version',(s->>'version')||':'||coalesce(decision->>'id','unaccepted')||':'||md5(request_floor::text),
   'userId',coalesce(request_floor->>'userId',s->>'userId'),'assistantId',coalesce(request_floor->>'assistantId',s->>'assistantId'),
   'sensitivity',CASE WHEN sensitivity_rank(s->>'sensitivity')>=sensitivity_rank(request_floor->>'sensitivity') THEN s->>'sensitivity' ELSE request_floor->>'sensitivity' END,
   'compartments',(SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT DISTINCT value AS v FROM jsonb_array_elements_text((s->'compartments')||(request_floor->'compartments'))) merged),
   'projectIds',(SELECT coalesce(jsonb_agg(v),'[]') FROM (SELECT DISTINCT value AS v FROM jsonb_array_elements_text((s->'projectIds')||(request_floor->'projectIds'))) merged));
 END IF;
 RETURN s||jsonb_build_object('text',coalesce(body,''),'authorUserId',author,'role',role_name,'occurredAt',coalesce(occurred,(r->>'created_at')::timestamptz),
  'originChatId',origin,'governedAccepted',decision IS NOT NULL,'archive',false);
END $$;

CREATE FUNCTION crm_delivery_source_navigation(w uuid,k text,i uuid,revision text,chat uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE nav jsonb;
BEGIN
 IF NOT crm_delivery_source_visible(w,k,i,revision,chat) THEN RETURN NULL; END IF;
 IF k='session_message' THEN
  SELECT jsonb_build_object('type','conversation','id',s.id,'visibility',s.visibility) INTO nav
   FROM session_messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=i AND m.workspace_id=w;
 ELSIF k='entity' THEN nav:=jsonb_build_object('type','brain','primitive','deals','id',i);
 ELSIF k='file_segment' THEN
  SELECT jsonb_build_object('type','brain','primitive','files','id',file_id) INTO nav FROM file_segments WHERE id=i AND workspace_id=w;
 END IF;
 RETURN nav;
END $$;
REVOKE ALL ON FUNCTION crm_delivery_source_navigation(uuid,text,uuid,text,uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
GRANT EXECUTE ON FUNCTION crm_delivery_source_navigation(uuid,text,uuid,text,uuid) TO app_user;
END IF; END $$;

COMMIT;
