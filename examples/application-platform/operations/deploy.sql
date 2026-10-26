-- Versioned source-owned module deployment; no actor/resource grants are seeded.
-- Apply once as the installation migrator after platform8087; normal runtime cannot register ports.
-- [COMP:examples/application-references]
BEGIN;
CREATE TABLE purchasing_schema_bindings (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 request_type_id uuid NOT NULL REFERENCES entity_types(id),
 line_item_type_id uuid NOT NULL REFERENCES entity_types(id),
 order_type_id uuid NOT NULL REFERENCES entity_types(id),
 revision bigint NOT NULL DEFAULT nextval('application_policy_revision_seq'),
 CHECK(request_type_id<>line_item_type_id AND request_type_id<>order_type_id AND line_item_type_id<>order_type_id)
);
ALTER TABLE purchasing_schema_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purchasing_schema_bindings FROM PUBLIC;
CREATE FUNCTION purchasing_configuration_revision(w uuid) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT revision::text FROM purchasing_schema_bindings WHERE workspace_id=w),'unconfigured')
$$;
REVOKE ALL ON FUNCTION purchasing_configuration_revision(uuid) FROM PUBLIC;
CREATE FUNCTION purchasing_schema_shape(w uuid,r uuid,l uuid,o uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT r<>l AND r<>o AND l<>o AND
 EXISTS(SELECT 1 FROM entity_types WHERE id=r AND workspace_id=w AND schema_version=1 AND properties='[{"name":"title","required":true,"config":{"kind":"text"}},{"name":"company","required":true,"config":{"kind":"relation","targetEntityTypeRef":{"kind":"builtin","name":"company"}}},{"name":"budget","required":true,"config":{"kind":"text"}},{"name":"state","required":true,"config":{"kind":"text"}},{"name":"total","required":false,"config":{"kind":"text"}}]'::jsonb) AND
 EXISTS(SELECT 1 FROM entity_types WHERE id=l AND workspace_id=w AND schema_version=1 AND properties=replace('[{"name":"title","required":true,"config":{"kind":"text"}},{"name":"request","required":true,"config":{"kind":"relation","targetEntityTypeRef":{"kind":"user_defined","entityTypeId":"REQUEST_SCHEMA_PLACEHOLDER"}}},{"name":"quantity","required":true,"config":{"kind":"number","minimum":1,"maximum":1000000}},{"name":"unitCost","required":true,"config":{"kind":"text"}}]','REQUEST_SCHEMA_PLACEHOLDER',r::text)::jsonb) AND
 EXISTS(SELECT 1 FROM entity_types WHERE id=o AND workspace_id=w AND schema_version=1 AND properties=replace('[{"name":"request","required":true,"config":{"kind":"relation","targetEntityTypeRef":{"kind":"user_defined","entityTypeId":"REQUEST_SCHEMA_PLACEHOLDER"}}},{"name":"company","required":true,"config":{"kind":"relation","targetEntityTypeRef":{"kind":"builtin","name":"company"}}},{"name":"total","required":true,"config":{"kind":"text"}},{"name":"state","required":true,"config":{"kind":"text"}}]','REQUEST_SCHEMA_PLACEHOLDER',r::text)::jsonb)
$$;
REVOKE ALL ON FUNCTION purchasing_schema_shape(uuid,uuid,uuid,uuid) FROM PUBLIC;
CREATE FUNCTION purchasing_configure_schemas(w uuid,input jsonb) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r uuid:=(input->>'requestTypeId')::uuid;l uuid:=(input->>'lineItemTypeId')::uuid;o uuid:=(input->>'orderTypeId')::uuid;revision text;
BEGIN
 IF input-ARRAY['requestTypeId','lineItemTypeId','orderTypeId']<>'{}'::jsonb OR NOT input ?& ARRAY['requestTypeId','lineItemTypeId','orderTypeId']
 OR purchasing_schema_shape(w,r,l,o) IS NOT TRUE
 OR EXISTS(SELECT 1 FROM unnest(ARRAY[r,l,o]) id WHERE NOT EXISTS(SELECT 1 FROM application_native_resource_owners owner WHERE owner.workspace_id=w
 AND owner.module_key='purchasing' AND owner.origin=jsonb_build_object('kind','generic','entityTypeId',id) AND owner.resource_type='record.'||id::text))
 THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO purchasing_schema_bindings(workspace_id,request_type_id,line_item_type_id,order_type_id) VALUES(w,r,l,o)
 ON CONFLICT(workspace_id) DO UPDATE SET request_type_id=r,line_item_type_id=l,order_type_id=o,revision=nextval('application_policy_revision_seq')
 RETURNING purchasing_schema_bindings.revision::text INTO revision;
 RETURN revision;
END $$;
REVOKE ALL ON FUNCTION purchasing_configure_schemas(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION purchasing_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE s entity_types;keys jsonb;fields jsonb;BEGIN
   SELECT * INTO s FROM entity_types WHERE workspace_id=w AND id=(o->>'entityTypeId')::uuid;IF s.id IS NULL THEN RETURN NULL;END IF;
   SELECT jsonb_agg(p->'name' ORDER BY p->>'name'),jsonb_agg(jsonb_build_object('key',p->>'name','read',CASE WHEN p->>'name' IN('budget','unitCost','total') THEN '[ ["manager"] ]'::jsonb ELSE '[ ["requester","manager"] ]'::jsonb END,
   'write',CASE WHEN p->>'name'='total' THEN '[ ["manager"] ]'::jsonb ELSE '[ ["requester","manager"] ]'::jsonb END,'releaseReadTo','["service"]'::jsonb,'releaseWriteTo','["service"]'::jsonb) ORDER BY p->>'name') INTO keys,fields FROM jsonb_array_elements(s.properties) p;
   RETURN jsonb_build_object('moduleKey','purchasing','origin',o,'typeKey','record.'||s.id::text,'schemaVersion',s.schema_version::text,'policyVersion','purchase-v1','fieldKeys',keys,'fields',fields,
   'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
   REVOKE ALL ON FUNCTION purchasing_catalog(uuid,jsonb,text) FROM PUBLIC;
   CREATE FUNCTION purchasing_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
   DECLARE catalog jsonb;source jsonb;BEGIN catalog:=purchasing_catalog(w,o,t);source:=read_scope_source(w,'entity_instance',i::uuid);IF source IS NULL THEN RETURN NULL;END IF;
   RETURN (catalog-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);END $$;
   REVOKE ALL ON FUNCTION purchasing_metadata(uuid,jsonb,text,text) FROM PUBLIC;
   INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
   VALUES('purchasing','1',ARRAY['requester','manager'],'purchasing_metadata(uuid,jsonb,text,text)'::regprocedure,'purchasing_catalog(uuid,jsonb,text)'::regprocedure,true,'purchasing_configuration_revision(uuid)'::regprocedure);
   INSERT INTO application_deployed_module_capabilities(module_key,contract_version,commands,queries,dependencies)
   VALUES('purchasing','1',ARRAY['create_request','submit_request','approve_order'],ARRAY['get','query','history'],ARRAY['records','native']);
INSERT INTO application_native_configuration_operations(module_key,operation_key,input_fields,required_role_keys,apply_handler)
 VALUES('purchasing','set_schemas','[{"key":"requestTypeId","kind":"text","required":true,"maxLength":36},{"key":"lineItemTypeId","kind":"text","required":true,"maxLength":36},{"key":"orderTypeId","kind":"text","required":true,"maxLength":36}]',ARRAY['manager'],'purchasing_configure_schemas(uuid,jsonb)'::regprocedure);
CREATE FUNCTION purchasing_read_schema_bindings(w uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE config purchasing_schema_bindings;
BEGIN
 IF read_application_module_role(w,'purchasing','requester') IS NOT TRUE AND read_application_module_role(w,'purchasing','manager') IS NOT TRUE THEN RETURN NULL;END IF;
 IF application_deployed_module_state(w,'purchasing') IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO config FROM purchasing_schema_bindings WHERE workspace_id=w;
 IF config.workspace_id IS NULL OR purchasing_schema_shape(w,config.request_type_id,config.line_item_type_id,config.order_type_id) IS NOT TRUE
 OR EXISTS(SELECT 1 FROM unnest(ARRAY[config.request_type_id,config.line_item_type_id,config.order_type_id]) id WHERE NOT EXISTS(SELECT 1 FROM application_native_resource_owners owner WHERE owner.workspace_id=w
 AND owner.module_key='purchasing' AND owner.origin=jsonb_build_object('kind','generic','entityTypeId',id) AND owner.resource_type='record.'||id::text)) THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('requestTypeId',config.request_type_id,'lineItemTypeId',config.line_item_type_id,'orderTypeId',config.order_type_id);
END $$;
REVOKE ALL ON FUNCTION purchasing_read_schema_bindings(uuid) FROM PUBLIC;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
 REVOKE ALL ON purchasing_schema_bindings FROM app_user;
 GRANT EXECUTE ON FUNCTION purchasing_read_schema_bindings(uuid) TO app_user;
END IF;END $$;
COMMIT;
