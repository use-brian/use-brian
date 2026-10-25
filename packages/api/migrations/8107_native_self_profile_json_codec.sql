BEGIN;
-- [COMP:api/identity-context] Fixed, selection-scoped profile JSON codecs.
-- Values remain under their existing per-field authority and immutable evidence.
DO $migration$
DECLARE definition text;before text;replacement text;target oid;metadata jsonb;
BEGIN
 target:='public.application_native_field_keys(text)'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 before:=$source$'profile.role_or_company','profile.sources']$source$;
 replacement:=$source$'profile.role_or_company','profile.sources','profile.extra']$source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native self-profile codec anchor changed: application_native_field_keys(text)';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native self-profile function metadata changed: application_native_field_keys(text)';
 END IF;

 target:='public.application_native_entity_values(text,jsonb)'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 before:=$source$jsonb_build_object('profile.name',payload#>'{attributes,name}','profile.role',payload#>'{attributes,role}',
   'profile.company',payload#>'{attributes,company}','profile.location',payload#>'{attributes,location}',
   'profile.birthday',payload#>'{attributes,birthday}','profile.pronouns',payload#>'{attributes,pronouns}',
   'profile.role_or_company',payload#>'{attributes,role_or_company}','profile.sources',payload#>'{attributes,sources}')$source$;
 replacement:=$source$jsonb_build_object('tags',payload#>'{attributes,tags}','externalRef',payload#>'{attributes,external_ref}',
   'profile.name',CASE WHEN payload->'attributes' ? 'name' THEN jsonb_build_object('value',payload#>'{attributes,name}') END,
   'profile.role',CASE WHEN payload->'attributes' ? 'role' THEN jsonb_build_object('value',payload#>'{attributes,role}') END,
   'profile.company',CASE WHEN payload->'attributes' ? 'company' THEN jsonb_build_object('value',payload#>'{attributes,company}') END,
   'profile.location',CASE WHEN payload->'attributes' ? 'location' THEN jsonb_build_object('value',payload#>'{attributes,location}') END,
   'profile.birthday',CASE WHEN payload->'attributes' ? 'birthday' THEN jsonb_build_object('value',payload#>'{attributes,birthday}') END,
   'profile.pronouns',CASE WHEN payload->'attributes' ? 'pronouns' THEN jsonb_build_object('value',payload#>'{attributes,pronouns}') END,
   'profile.role_or_company',CASE WHEN payload->'attributes' ? 'role_or_company' THEN jsonb_build_object('value',payload#>'{attributes,role_or_company}') END,
   'profile.sources',CASE WHEN payload->'attributes' ? 'sources' THEN jsonb_build_object('value',payload#>'{attributes,sources}') END,
   'profile.extra',coalesce(payload->'attributes','{}'::jsonb)-ARRAY['self','email','phone','company_id','tags','external_ref','owner_id','crm_archived_at','custom_fields','name','role','company','location','birthday','pronouns','role_or_company','sources'])$source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native self-profile codec anchor changed: application_native_entity_values(text,jsonb)';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native self-profile function metadata changed: application_native_entity_values(text,jsonb)';
 END IF;

 target:='public.application_native_entity_values(text,jsonb,text[])'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 before:=$source$ SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO custom_values$source$;
 replacement:=$source$ IF p_type='person' AND 'profile.extra'=ANY(p_fields) THEN
  selected_attrs:=selected_attrs||(attrs-ARRAY['self','email','phone','company_id','tags','external_ref','owner_id','crm_archived_at','custom_fields','name','role','company','location','birthday','pronouns','role_or_company','sources']);
 END IF;
 SELECT coalesce(jsonb_object_agg(key,value),'{}') INTO custom_values$source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native self-profile codec anchor changed: application_native_entity_values(text,jsonb,text[])';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native self-profile function metadata changed: application_native_entity_values(text,jsonb,text[])';
 END IF;

 target:='public.application_native_builtin_field_revision(text,text)'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 before:=$source$WHEN p_type='person' AND p_field='self' THEN 2 ELSE 1 END;$source$;
 replacement:=$source$WHEN p_type='person' AND p_field='self' THEN 2
  WHEN p_type='person' AND (starts_with(p_field,'profile.') OR p_field IN('tags','externalRef')) THEN 2 ELSE 1 END;$source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native self-profile codec anchor changed: application_native_builtin_field_revision(text,text)';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native self-profile function metadata changed: application_native_builtin_field_revision(text,text)';
 END IF;

 target:='public.application_native_crm_attributes_complete(uuid,uuid)'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 before:=$source$jsonb_object_keys(e.attributes) key WHERE NOT key=ANY($source$;
 replacement:=$source$jsonb_object_keys(e.attributes) key WHERE v_kind<>'person' AND NOT key=ANY($source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native self-profile codec anchor changed: application_native_crm_attributes_complete(uuid,uuid)';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native self-profile function metadata changed: application_native_crm_attributes_complete(uuid,uuid)';
 END IF;

END $migration$;
COMMIT;
