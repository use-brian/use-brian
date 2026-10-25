BEGIN;
-- [COMP:api/identity-context] Known self-profile slots use the existing person
-- field policy and immutable observations. No source identity or ACL is added.
ALTER FUNCTION application_native_field_keys(text) RENAME TO application_native_field_keys_before_self_profile;
REVOKE ALL ON FUNCTION application_native_field_keys_before_self_profile(text) FROM PUBLIC;
CREATE FUNCTION application_native_field_keys(p_type text) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_field_keys_before_self_profile(p_type)||CASE p_type WHEN 'person' THEN
  ARRAY['profile.name','profile.role','profile.company','profile.location','profile.birthday','profile.pronouns','profile.role_or_company','profile.sources'] ELSE '{}'::text[] END
$$;
REVOKE ALL ON FUNCTION application_native_field_keys(text) FROM PUBLIC;

ALTER FUNCTION application_native_entity_values(text,jsonb) RENAME TO application_native_entity_values_before_self_profile;
REVOKE ALL ON FUNCTION application_native_entity_values_before_self_profile(text,jsonb) FROM PUBLIC;
CREATE FUNCTION application_native_entity_values(p_type text,payload jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT application_native_entity_values_before_self_profile(p_type,payload)||CASE p_type WHEN 'person' THEN
  jsonb_build_object('profile.name',payload#>'{attributes,name}','profile.role',payload#>'{attributes,role}',
   'profile.company',payload#>'{attributes,company}','profile.location',payload#>'{attributes,location}',
   'profile.birthday',payload#>'{attributes,birthday}','profile.pronouns',payload#>'{attributes,pronouns}',
   'profile.role_or_company',payload#>'{attributes,role_or_company}','profile.sources',payload#>'{attributes,sources}') ELSE '{}'::jsonb END
$$;
REVOKE ALL ON FUNCTION application_native_entity_values(text,jsonb) FROM PUBLIC;

DO $migration$
DECLARE definition text;before text;replacement text;target oid;metadata jsonb;
BEGIN
 -- Point and query observations share this semantic codec revision dictionary.
 target:='public.application_native_builtin_field_revision(text,text)'::regprocedure;
 SELECT pg_get_functiondef(target),to_jsonb(p)-'prosrc' INTO definition,metadata FROM pg_proc p WHERE p.oid=target;
 before:=$source$WHEN p_type='company' AND p_field='domain' OR p_type='person' AND p_field='email' THEN 2 ELSE 1 END;$source$;
 replacement:=$source$WHEN p_type='company' AND p_field='domain' OR p_type='person' AND p_field='email' THEN 2
  WHEN p_type='person' AND p_field='self' THEN 2 ELSE 1 END;$source$;
 IF length(definition)-length(replace(definition,before,''))<>length(before) THEN RAISE EXCEPTION 'Native builtin revision dictionary changed; review self codec identity';END IF;
 EXECUTE replace(definition,before,replacement);
 IF (SELECT to_jsonb(p)-'prosrc' FROM pg_proc p WHERE p.oid=target) IS DISTINCT FROM metadata THEN
  RAISE EXCEPTION 'Native builtin revision function identity or privileges changed';
 END IF;

 -- Preserve only selected raw slots in the existing selected-value codec.
 SELECT pg_get_functiondef('application_native_entity_values(text,jsonb,text[])'::regprocedure) INTO definition;
 before:=$source$('tags','tags'),('externalRef','external_ref'),('ownerId','owner_id'),('archivedAt','crm_archived_at')$source$;
 replacement:=before||$source$,
  ('self','self'),('profile.name','name'),('profile.role','role'),('profile.company','company'),
  ('profile.location','location'),('profile.birthday','birthday'),('profile.pronouns','pronouns'),
  ('profile.role_or_company','role_or_company'),('profile.sources','sources')$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native selected codec changed; review self profile slots';END IF;
 EXECUTE replace(definition,before,replacement);

 -- Display name and stored self-profile name have distinct write-mask keys.
 SELECT pg_get_functiondef('application_native_entity_attribute_values(jsonb)'::regprocedure) INTO definition;
 before:=$source$WHEN 'probability' THEN 'probability' ELSE 'attribute.'||entry.key END;$source$;
 replacement:=$source$WHEN 'probability' THEN 'probability'
    WHEN 'name' THEN 'profile.name' WHEN 'role' THEN 'profile.role' WHEN 'company' THEN 'profile.company'
    WHEN 'location' THEN 'profile.location' WHEN 'birthday' THEN 'profile.birthday' WHEN 'pronouns' THEN 'profile.pronouns'
    WHEN 'role_or_company' THEN 'profile.role_or_company' WHEN 'sources' THEN 'profile.sources'
    ELSE 'attribute.'||entry.key END;$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native attribute codec changed; review self profile aliases';END IF;
 EXECUTE replace(definition,before,replacement);

 -- Compiled immutable descriptors do not protect the direct SQL create port.
 SELECT pg_get_functiondef('application_create_canonical_crm_ref(text,jsonb,jsonb)'::regprocedure) INTO definition;
 before:=$source$WHERE field NOT IN('createdAt','updatedAt','archivedAt','self'));$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native creation allowlist changed; review read-only profile fields';END IF;
 EXECUTE replace(definition,before,$source$WHERE field NOT IN('createdAt','updatedAt','archivedAt','self') AND NOT starts_with(field,'profile.'));$source$);

 -- A complete legacy snapshot still refuses arbitrary nonenumerable extras.
 SELECT pg_get_functiondef('application_native_crm_attributes_complete(uuid,uuid)'::regprocedure) INTO definition;
 before:=$source$WHEN 'person' THEN ARRAY['self','email','phone','company_id']$source$;
 replacement:=$source$WHEN 'person' THEN ARRAY['self','email','phone','company_id','name','role','company','location','birthday','pronouns','role_or_company','sources']$source$;
 IF position(before IN definition)=0 THEN RAISE EXCEPTION 'Native completeness codec changed; review self profile vocabulary';END IF;
 EXECUTE replace(definition,before,replacement);
END $migration$;
COMMIT;
