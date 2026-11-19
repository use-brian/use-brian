-- [COMP:api/native-turn-frame] Source-authenticated publication successors.
-- The generator supplies only shipped SourceSpecs and its reviewed table query.
-- No expected executable or schema is learned from the target catalog.
-- phase: before_installer
CREATE TEMP TABLE publication_source_functions(
 signature text PRIMARY KEY,metadata jsonb NOT NULL,body_parts jsonb NOT NULL
) ON COMMIT DROP;
CREATE TEMP TABLE publication_verified_table_snapshot(snapshot jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE publication_before_installer_schema(snapshot jsonb NOT NULL) ON COMMIT DROP;

CREATE FUNCTION pg_temp.publication_assert_expected_functions() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $check$
DECLARE expected record;actual pg_proc;
BEGIN
 FOR expected IN SELECT signature,metadata FROM publication_expected_current ORDER BY signature COLLATE "C" LOOP
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||expected.signature);
  IF actual.oid IS NULL OR to_jsonb(actual) IS DISTINCT FROM expected.metadata THEN
   RAISE EXCEPTION 'publication_unreviewed_successor: %',expected.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
END $check$;

DO $source_functions$
DECLARE specs constant jsonb:=__PUBLICATION_SOURCE_SPECS__::jsonb;
 spec jsonb;actual pg_proc;reference pg_proc;expected jsonb;prior jsonb;declaration text;
 argument text;type_name text;argument_name text;defaults text[];reference_name text;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
 expected_acl aclitem[];ordinal integer:=0;arg_position integer;argument_count integer;
 required constant text[]:=ARRAY[
  'native_conversation_publication_scope(uuid,uuid)',
  'native_conversation_publication_result(uuid,uuid,uuid)',
  'native_conversation_publication_enter(uuid,uuid,jsonb,jsonb)',
  'native_conversation_publication_complete()',
  'native_conversation_publication_immutable()',
  'read_native_conversation_publications(uuid,uuid,jsonb,integer)',
  'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb,jsonb)',
  'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)',
  'native_turn_complete_publication()',
  'native_session_turn_publication_state(uuid,uuid,uuid)',  'native_conversation_terminal_candidate_valid(jsonb,jsonb,uuid)',  'native_conversation_terminal_subset(jsonb,jsonb,jsonb)',  'native_conversation_publication_packet(uuid,jsonb)',  'native_session_public_turn_id(uuid,uuid,uuid)',  'native_session_expired_turn_outcome(uuid,uuid,uuid,uuid,boolean)',  'native_session_turn_transition(uuid,text,uuid,timestamp with time zone,integer,uuid,text,boolean)',  'native_session_release_turn(uuid,uuid,text)'];
BEGIN
 IF jsonb_typeof(specs) IS DISTINCT FROM 'array'
  OR (SELECT count(*) FROM jsonb_array_elements(specs))<>cardinality(required)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(specs) s WHERE NOT(s->>'signature'=ANY(required)))
  OR (SELECT count(DISTINCT s->>'signature') FROM jsonb_array_elements(specs) s)<>cardinality(required)
  OR runtime_id IS NULL OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
 THEN RAISE EXCEPTION 'publication_source_spec_roster_changed' USING ERRCODE='55000';END IF;
 FOR spec IN SELECT value FROM jsonb_array_elements(specs) LOOP
  IF spec-ARRAY['profile','name','signature','argNames','argTypes','returnType','language','volatility','secdef','config','defaultsSQL','appExecute','body']<>'{}'
   OR NOT spec ?& ARRAY['profile','name','signature','argNames','argTypes','returnType','language','volatility','secdef','config','defaultsSQL','appExecute','body']
   OR spec->>'language'<>'plpgsql' OR spec->>'volatility'<>'v' OR spec->'secdef'<>'true'::jsonb
   OR spec->>'returnType' NOT IN('jsonb','trigger','text','boolean') OR jsonb_typeof(spec->'body') IS DISTINCT FROM 'string'
   OR spec->>'name' IS DISTINCT FROM split_part(spec->>'signature','(',1)
   OR jsonb_typeof(spec->'argNames') IS DISTINCT FROM 'array' OR jsonb_typeof(spec->'argTypes') IS DISTINCT FROM 'array'
   OR jsonb_array_length(spec->'argNames')<>jsonb_array_length(spec->'argTypes')
   OR (spec->>'profile'='replace') IS DISTINCT FROM ((spec->>'signature')=ANY(ARRAY[
    'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','native_turn_complete_publication()']))
   OR spec->>'profile' NOT IN('new','replace')
   OR (spec->'appExecute'='true'::jsonb) IS DISTINCT FROM ((spec->>'signature')=ANY(ARRAY[
    'native_session_turn_publication_state(uuid,uuid,uuid)',
    'read_native_conversation_publications(uuid,uuid,jsonb,integer)',
    'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb,jsonb)',
    'publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)']))
  THEN RAISE EXCEPTION 'publication_source_spec_changed: %',spec->>'signature' USING ERRCODE='55000';END IF;
  IF spec->'config' IS DISTINCT FROM (CASE WHEN spec->>'name'='publish_native_session_message_batch'
   THEN '["search_path=pg_catalog, public, pg_temp","plan_cache_mode=force_generic_plan"]'::jsonb
   ELSE '["search_path=pg_catalog, public, pg_temp"]'::jsonb END)
  THEN RAISE EXCEPTION 'publication_source_config_changed: %',spec->>'signature';END IF;
  defaults:=NULL;
  IF spec->>'signature'='read_native_conversation_publications(uuid,uuid,jsonb,integer)' THEN
   IF spec->>'defaultsSQL' IS DISTINCT FROM 'NULL::jsonb, 20' THEN RAISE EXCEPTION 'publication_source_defaults_changed';END IF;
   defaults:=ARRAY['NULL::jsonb','20'];
  ELSIF spec->'defaultsSQL' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'publication_source_defaults_changed';
  END IF;
  declaration:='';argument_count:=jsonb_array_length(spec->'argTypes');
  FOR arg_position IN 0..argument_count-1 LOOP
   type_name:=spec#>>ARRAY['argTypes',arg_position::text];argument_name:=spec#>>ARRAY['argNames',arg_position::text];
   IF type_name NOT IN('uuid','jsonb','text','integer','boolean','timestamp with time zone') OR argument_name IS NULL OR argument_name='' THEN
    RAISE EXCEPTION 'publication_source_argument_changed';END IF;
   argument:=format('%I %s',argument_name,type_name);
   IF defaults IS NOT NULL AND arg_position>=argument_count-cardinality(defaults) THEN
    argument:=argument||' DEFAULT '||defaults[arg_position-(argument_count-cardinality(defaults))+1];
   END IF;
   declaration:=declaration||CASE WHEN arg_position=0 THEN '' ELSE ',' END||argument;
  END LOOP;
  ordinal:=ordinal+1;reference_name:='publication_source_reference_'||ordinal;
  IF to_regprocedure('pg_temp.'||reference_name||'('||
   (SELECT coalesce(string_agg(value,',' ORDER BY n),'') FROM jsonb_array_elements_text(spec->'argTypes') WITH ORDINALITY x(value,n))||')') IS NOT NULL
  THEN RAISE EXCEPTION 'publication_source_reference_exists';END IF;
  EXECUTE format('CREATE FUNCTION pg_temp.%I(%s) RETURNS %s LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp %s AS %L',
   reference_name,declaration,spec->>'returnType',
   CASE WHEN spec->>'name'='publish_native_session_message_batch' THEN 'SET plan_cache_mode=force_generic_plan' ELSE '' END,spec->>'body');
  SELECT * INTO STRICT reference FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=reference_name;
  SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.'||(spec->>'signature'));
  IF actual.oid IS NULL THEN RAISE EXCEPTION 'publication_source_function_missing: %',spec->>'signature';END IF;
  IF spec->>'profile'='replace' THEN
   SELECT metadata INTO prior FROM publication_reviewed_contracts WHERE signature=spec->>'signature';
   IF prior IS NULL THEN RAISE EXCEPTION 'publication_source_predecessor_missing';END IF;
   -- An existing signature keeps its exact authenticated raw ACL, including order.
   expected:=prior->'proacl';
  ELSE
   expected_acl:=ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)];
   IF (spec->>'appExecute')::boolean THEN expected_acl:=expected_acl||makeaclitem(runtime_id,owner_id,'EXECUTE',false);END IF;
   expected:=to_jsonb(expected_acl);
  END IF;
  expected:=(to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proowner','proacl'])||jsonb_build_object(
   'oid',actual.oid,'proname',spec->>'name','pronamespace','public'::regnamespace::oid,'proowner',owner_id,'proacl',expected);
  IF to_jsonb(actual) IS DISTINCT FROM expected OR (actual.prosrc COLLATE "C") IS DISTINCT FROM ((spec->>'body') COLLATE "C") THEN
   RAISE EXCEPTION 'publication_source_successor_changed: %',spec->>'signature' USING ERRCODE='55000';
  END IF;
  INSERT INTO publication_source_functions VALUES(spec->>'signature',expected,jsonb_build_array(spec->>'body'));
  EXECUTE format('DROP FUNCTION pg_temp.%I(%s)',reference_name,
   (SELECT coalesce(string_agg(value,',' ORDER BY n),'') FROM jsonb_array_elements_text(spec->'argTypes') WITH ORDINALITY x(value,n)));
 END LOOP;
 INSERT INTO publication_expected_current SELECT signature,metadata FROM publication_source_functions
  ON CONFLICT(signature) DO UPDATE SET metadata=EXCLUDED.metadata;
 INSERT INTO publication_successor_templates SELECT signature,body_parts FROM publication_source_functions
  ON CONFLICT(signature) DO UPDATE SET parts=EXCLUDED.parts;
 PERFORM pg_temp.publication_assert_expected_functions();
END $source_functions$;

-- These compiler references are source declarations, not LIKE/copies of target tables.
CREATE FUNCTION pg_temp.publication_reference_schema() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $reference$
BEGIN
 IF to_regnamespace('publication_source_reference') IS NOT NULL THEN
  RAISE EXCEPTION 'publication_source_reference_schema_exists';END IF;
 EXECUTE 'CREATE SCHEMA publication_source_reference';
 IF NOT EXISTS(SELECT FROM pg_namespace WHERE nspname='publication_source_reference'
  AND nspowner=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
  AND coalesce(nspacl,acldefault('n',nspowner)) IS NOT DISTINCT FROM acldefault('n',nspowner))
 THEN RAISE EXCEPTION 'publication_reference_schema_private_profile_changed';END IF;
 EXECUTE $ddl$CREATE TABLE publication_source_reference.native_conversation_publications(
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
 input_message_id uuid NOT NULL REFERENCES public.session_messages(id) ON DELETE CASCADE,
 actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
 assistant_id uuid NOT NULL REFERENCES public.assistants(id) ON DELETE CASCADE,
 turn_token uuid NOT NULL,slot text NOT NULL CHECK(slot='buffered_transcript'),
 command_format integer NOT NULL CHECK(command_format IN(1,2)),command_digest text NOT NULL CHECK(command_digest~'^[a-f0-9]{64}$'),
 stopped boolean NOT NULL,frame_ids uuid[] NOT NULL CHECK(cardinality(frame_ids) BETWEEN 1 AND 2),
 leader_frame_id uuid NOT NULL,expected_output_count integer NOT NULL CHECK(expected_output_count BETWEEN 1 AND 513),
 annotation_user_id uuid,annotation_assistant_id uuid,outputs jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz,
 requested_stopped boolean,terminal_descriptor jsonb,terminal_outputs jsonb,
 CONSTRAINT native_conversation_terminal_format CHECK(
  command_format=1 AND requested_stopped IS NULL AND terminal_descriptor IS NULL AND terminal_outputs IS NULL
  OR command_format=2 AND requested_stopped IS NOT NULL AND (NOT requested_stopped OR stopped)
   AND (terminal_descriptor IS NULL)=(terminal_outputs IS NULL) AND (NOT stopped OR terminal_descriptor IS NULL)),
 CONSTRAINT native_conversation_publication_slot UNIQUE(workspace_id,session_id,turn_token,slot),
 CONSTRAINT native_conversation_publication_result CHECK((outputs IS NULL)=(completed_at IS NULL)))$ddl$;
 EXECUTE 'CREATE INDEX native_conversation_publication_discovery ON publication_source_reference.native_conversation_publications(workspace_id,session_id,actor_user_id,assistant_id,created_at,id)';
 EXECUTE 'REVOKE ALL ON publication_source_reference.native_conversation_publications FROM PUBLIC,app_user';
 EXECUTE 'ALTER TABLE publication_source_reference.native_conversation_publications ENABLE ROW LEVEL SECURITY';
 EXECUTE $ddl$CREATE TABLE publication_source_reference.native_turn_publication_work(publication_id uuid,
  CONSTRAINT native_turn_publication_operation FOREIGN KEY(publication_id)
  REFERENCES publication_source_reference.native_conversation_publications(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED)$ddl$;
 EXECUTE 'REVOKE ALL ON publication_source_reference.native_turn_publication_work FROM PUBLIC,app_user';
 IF EXISTS(SELECT FROM pg_class WHERE relnamespace='publication_source_reference'::regnamespace
  AND relkind='r' AND (relowner<>(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
   OR relacl IS DISTINCT FROM acldefault('r',relowner)))
 THEN RAISE EXCEPTION 'publication_reference_table_private_profile_changed';END IF;
 EXECUTE 'CREATE CONSTRAINT TRIGGER native_conversation_publication_complete AFTER INSERT ON publication_source_reference.native_conversation_publications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.native_conversation_publication_complete()';
 EXECUTE 'CREATE TRIGGER native_conversation_publication_immutable BEFORE UPDATE ON publication_source_reference.native_conversation_publications FOR EACH ROW EXECUTE FUNCTION public.native_conversation_publication_immutable()';
END $reference$;

CREATE FUNCTION pg_temp.publication_map_reference_relation(relation_id oid) RETURNS oid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $map$
DECLARE relation_name name;namespace_name name;mapped oid;
BEGIN
 IF relation_id=0 THEN RETURN 0;END IF;
 SELECT c.relname,n.nspname INTO STRICT relation_name,namespace_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=relation_id;
 IF namespace_name<>'publication_source_reference' THEN RETURN relation_id;END IF;
 mapped:=to_regclass(format('public.%I',relation_name));
 IF mapped IS NULL THEN RAISE EXCEPTION 'publication_reference_relation_missing: %',relation_name;END IF;
 RETURN mapped;
END $map$;
CREATE FUNCTION pg_temp.publication_map_reference_constraint(constraint_id oid) RETURNS oid
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $map$
DECLARE original pg_constraint;mapped oid;
BEGIN
 IF constraint_id=0 THEN RETURN 0;END IF;
 SELECT * INTO STRICT original FROM pg_constraint WHERE oid=constraint_id;
 SELECT oid INTO STRICT mapped FROM pg_constraint WHERE conrelid=pg_temp.publication_map_reference_relation((original).conrelid) AND conname=(original).conname;
 RETURN mapped;
END $map$;
CREATE FUNCTION pg_temp.publication_map_reference_attributes(relation_id oid,attributes smallint[]) RETURNS smallint[]
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $map$
DECLARE mapped smallint;
BEGIN
 IF relation_id<>'publication_source_reference.native_turn_publication_work'::regclass OR attributes IS NULL THEN RETURN attributes;END IF;
 IF attributes<>ARRAY[1]::smallint[] THEN RAISE EXCEPTION 'publication_reference_attribute_shape';END IF;
 SELECT attnum INTO STRICT mapped FROM pg_attribute WHERE attrelid='public.native_turn_publication_work'::regclass AND attname='publication_id' AND NOT attisdropped;
 RETURN ARRAY[mapped];
END $map$;
CREATE FUNCTION pg_temp.publication_reference_constraint_record(original pg_constraint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $map$
 SELECT (to_jsonb(original)-ARRAY['oid','connamespace','conrelid','conindid','confrelid','conkey','confkey'])||jsonb_build_object(
  'oid',pg_temp.publication_map_reference_constraint((original).oid),'connamespace','public'::regnamespace::oid,
  'conrelid',pg_temp.publication_map_reference_relation((original).conrelid),
  'conindid',pg_temp.publication_map_reference_relation((original).conindid),
  'confrelid',pg_temp.publication_map_reference_relation((original).confrelid),
  'conkey',pg_temp.publication_map_reference_attributes((original).conrelid,(original).conkey),
  'confkey',pg_temp.publication_map_reference_attributes((original).confrelid,(original).confkey))
$map$;
CREATE FUNCTION pg_temp.publication_reference_trigger_record(original pg_trigger) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $map$
DECLARE mapped oid;trigger_name text;prefix text;
BEGIN
 IF (original).tgisinternal THEN
  SELECT oid INTO STRICT mapped FROM pg_trigger WHERE tgrelid=pg_temp.publication_map_reference_relation((original).tgrelid)
   AND tgconstraint=pg_temp.publication_map_reference_constraint((original).tgconstraint) AND tgtype=(original).tgtype AND tgisinternal;
  IF right((original).tgname::text,length((original).oid::text))<>(original).oid::text THEN RAISE EXCEPTION 'publication_reference_internal_name';END IF;
  prefix:=left((original).tgname::text,length((original).tgname::text)-length((original).oid::text));
  IF prefix NOT IN('RI_ConstraintTrigger_a_','RI_ConstraintTrigger_c_') THEN RAISE EXCEPTION 'publication_reference_internal_kind';END IF;
  trigger_name:=prefix||mapped::text;
 ELSE
  SELECT oid INTO STRICT mapped FROM pg_trigger WHERE tgrelid=pg_temp.publication_map_reference_relation((original).tgrelid) AND tgname=(original).tgname;
  trigger_name:=(original).tgname;
 END IF;
 RETURN (to_jsonb(original)-ARRAY['oid','tgname','tgrelid','tgconstraint','tgconstrrelid','tgconstrindid'])||jsonb_build_object(
  'oid',mapped,'tgname',trigger_name,'tgrelid',pg_temp.publication_map_reference_relation((original).tgrelid),
  'tgconstraint',pg_temp.publication_map_reference_constraint((original).tgconstraint),
  'tgconstrrelid',pg_temp.publication_map_reference_relation((original).tgconstrrelid),
  'tgconstrindid',pg_temp.publication_map_reference_relation((original).tgconstrindid));
END $map$;

CREATE FUNCTION pg_temp.publication_relation_semantics(relation_record pg_class) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $shape$
 SELECT jsonb_build_object('name',(relation_record).relname,'owner',(relation_record).relowner,'kind',(relation_record).relkind,
  'persistence',(relation_record).relpersistence,'am',(relation_record).relam,'tablespace',(relation_record).reltablespace,
  'options',(relation_record).reloptions,'replicaIdentity',(relation_record).relreplident,'ofType',(relation_record).reloftype,
  'attributes',(relation_record).relnatts,'checks',(relation_record).relchecks,'hasIndex',(relation_record).relhasindex,
  'hasRules',(relation_record).relhasrules,'hasTriggers',(relation_record).relhastriggers,'hasSubclass',(relation_record).relhassubclass,
  'rls',(relation_record).relrowsecurity,'forceRls',(relation_record).relforcerowsecurity,'partition',(relation_record).relispartition,
  'partitionBound',(relation_record).relpartbound,'acl',(relation_record).relacl)
$shape$;

CREATE FUNCTION pg_temp.publication_schema_details() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $details$
 SELECT jsonb_build_object(
  'header',pg_temp.publication_relation_semantics(c),
  'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0),
  'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('index',to_jsonb(i),'relation',pg_temp.publication_relation_semantics(r)) ORDER BY r.relname COLLATE "C")
   FROM pg_index i JOIN pg_class r ON r.oid=i.indexrelid WHERE i.indrelid=c.oid),
  'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY d.adnum) FROM pg_attrdef d WHERE d.adrelid=c.oid),
  'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.tgrelid=c.oid),
  'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM pg_rewrite r WHERE r.ev_class=c.oid),
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM pg_policy p WHERE p.polrelid=c.oid),
  'inheritance',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.inhrelid,i.inhseqno) FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
  'workColumn',(SELECT to_jsonb(a) FROM pg_attribute a WHERE a.attrelid='public.native_turn_publication_work'::regclass AND a.attname='publication_id' AND NOT a.attisdropped),
  'workConstraint',(SELECT to_jsonb(k) FROM pg_constraint k WHERE k.conrelid='public.native_turn_publication_work'::regclass AND k.conname='native_turn_publication_operation'),
  'workTriggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
   WHERE k.conrelid='public.native_turn_publication_work'::regclass AND k.conname='native_turn_publication_operation' AND t.tgrelid=k.conrelid))
 FROM pg_class c WHERE c.oid='public.native_conversation_publications'::regclass
$details$;
CREATE TEMP TABLE publication_before_installer_details(snapshot jsonb NOT NULL) ON COMMIT DROP;

-- PG18 back branches reserve pg_attver for the engine's durable attribute
-- version (XLogRecPtr/uint64). Only this typed installation identity differs
-- between independently compiled objects. Every other option stays literal;
-- the authenticated before/after snapshot below retains the FULL actual value.
CREATE FUNCTION pg_temp.publication_attribute_semantics(attribute_record pg_attribute) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $attribute$
DECLARE option_value text;options text[];versions integer:=0;decimal_value text;
BEGIN
 IF (attribute_record).attoptions IS NULL THEN RETURN to_jsonb(attribute_record);END IF;
 options:=ARRAY[]::text[];
 FOREACH option_value IN ARRAY (attribute_record).attoptions LOOP
  IF split_part(option_value,'=',1)='pg_attver' THEN
   versions:=versions+1;decimal_value:=substring(option_value FROM length('pg_attver=')+1);
   IF versions>1 OR option_value!~'^pg_attver=(0|[1-9][0-9]{0,19})$' THEN
    RAISE EXCEPTION 'publication_attribute_version_option_changed' USING ERRCODE='55000';END IF;
   IF decimal_value::numeric>18446744073709551615::numeric THEN
    RAISE EXCEPTION 'publication_attribute_version_option_changed' USING ERRCODE='55000';END IF;
   options:=array_append(options,'pg_attver=__ENGINE_ATTRIBUTE_VERSION__');
  ELSE options:=array_append(options,option_value);END IF;
 END LOOP;
 RETURN jsonb_set(to_jsonb(attribute_record),'{attoptions}',to_jsonb(options));
END $attribute$;

CREATE FUNCTION pg_temp.publication_assert_source_schema() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $schema$
DECLARE actual jsonb;expected jsonb;item record;original pg_attribute;attribute_json jsonb;
 actual_header oid:='public.native_conversation_publications'::regclass;
 actual_work oid:='public.native_turn_publication_work'::regclass;
 reference_header oid;reference_work oid;new_attribute integer;old_snapshot jsonb;
BEGIN
 -- Reference equality must not bless ambient third-party default grants.
 IF NOT EXISTS(SELECT FROM pg_class WHERE oid=actual_header
  AND relowner=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
  AND relacl IS NOT DISTINCT FROM acldefault('r',relowner)
  AND relkind='r' AND relpersistence='p' AND relrowsecurity AND NOT relforcerowsecurity)
 THEN RAISE EXCEPTION 'publication_header_private_profile_changed' USING ERRCODE='55000';END IF;
 PERFORM pg_temp.publication_reference_schema();
 reference_header:='publication_source_reference.native_conversation_publications'::regclass;
 reference_work:='publication_source_reference.native_turn_publication_work'::regclass;
 SELECT snapshot INTO STRICT old_snapshot FROM publication_predecessor_table_snapshot;
 SELECT coalesce(max((value->>1)::integer),0)+1 INTO new_attribute FROM jsonb_array_elements(old_snapshot->'columns')
  WHERE value->>0=actual_work::text;
 IF (SELECT count(*) FROM pg_attribute WHERE attrelid=actual_work AND attname='publication_id' AND attnum=new_attribute AND NOT attisdropped)<>1
 THEN RAISE EXCEPTION 'publication_work_column_position_changed';END IF;

 SELECT pg_temp.publication_relation_semantics(c) INTO actual FROM pg_class c WHERE oid=actual_header;
 SELECT pg_temp.publication_relation_semantics(c) INTO expected FROM pg_class c WHERE oid=reference_header;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_header_relation_changed' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT FROM pg_rewrite WHERE ev_class=actual_header) OR EXISTS(SELECT FROM pg_policy WHERE polrelid=actual_header)
  OR EXISTS(SELECT FROM pg_inherits WHERE inhrelid=actual_header OR inhparent=actual_header)
 THEN RAISE EXCEPTION 'publication_header_extra_schema';END IF;
 SELECT jsonb_agg(pg_temp.publication_attribute_semantics(a) ORDER BY a.attnum) INTO actual FROM pg_attribute a WHERE a.attrelid=actual_header AND a.attnum>0;
 SELECT jsonb_agg((pg_temp.publication_attribute_semantics(a)-'attrelid')||jsonb_build_object('attrelid',actual_header) ORDER BY a.attnum) INTO expected
  FROM pg_attribute a WHERE a.attrelid=reference_header AND a.attnum>0;
 IF actual IS DISTINCT FROM expected THEN
  RAISE EXCEPTION 'publication_header_columns_changed' USING DETAIL=(SELECT jsonb_agg(jsonb_build_object('attribute',coalesce(a.value->>'attname',e.value->>'attname'),'actual',a.value,'expected',e.value))::text
   FROM jsonb_array_elements(actual) WITH ORDINALITY a(value,n) FULL JOIN jsonb_array_elements(expected) WITH ORDINALITY e(value,n) ON a.n=e.n WHERE a.value IS DISTINCT FROM e.value);
 END IF;
 SELECT * INTO STRICT original FROM pg_attribute WHERE attrelid=reference_work AND attname='publication_id' AND NOT attisdropped;
 attribute_json:=(pg_temp.publication_attribute_semantics(original)-ARRAY['attrelid','attnum'])||jsonb_build_object('attrelid',actual_work,'attnum',new_attribute);
 IF attribute_json IS DISTINCT FROM (SELECT pg_temp.publication_attribute_semantics(a) FROM pg_attribute a WHERE a.attrelid=actual_work AND a.attnum=new_attribute)
 THEN RAISE EXCEPTION 'publication_work_column_changed';END IF;

 SELECT jsonb_agg(jsonb_build_object('index',to_jsonb(i),'relation',pg_temp.publication_relation_semantics(c)) ORDER BY c.relname COLLATE "C") INTO actual
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=actual_header;
 SELECT jsonb_agg(jsonb_build_object('index',(to_jsonb(i)-ARRAY['indexrelid','indrelid'])||jsonb_build_object(
  'indexrelid',pg_temp.publication_map_reference_relation(i.indexrelid),'indrelid',actual_header),
  'relation',pg_temp.publication_relation_semantics(c)) ORDER BY c.relname COLLATE "C") INTO expected
  FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=reference_header;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_header_indexes_changed';END IF;
 SELECT jsonb_agg(to_jsonb(k) ORDER BY k.conname COLLATE "C") INTO actual FROM pg_constraint k WHERE k.conrelid=actual_header;
 SELECT jsonb_agg(pg_temp.publication_reference_constraint_record(k) ORDER BY k.conname COLLATE "C") INTO expected FROM pg_constraint k WHERE k.conrelid=reference_header;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_header_constraints_changed';END IF;
 SELECT to_jsonb(k) INTO actual FROM pg_constraint k WHERE k.conrelid=actual_work AND k.conname='native_turn_publication_operation';
 SELECT pg_temp.publication_reference_constraint_record(k) INTO expected FROM pg_constraint k WHERE k.conrelid=reference_work AND k.conname='native_turn_publication_operation';
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_work_foreign_key_changed';END IF;

 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO actual FROM pg_trigger t WHERE t.tgrelid=actual_header;
 SELECT jsonb_agg(mapped ORDER BY (mapped->>'oid')::oid) INTO expected FROM(
  SELECT pg_temp.publication_reference_trigger_record(t) mapped FROM pg_trigger t WHERE t.tgrelid=reference_header) mapped;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_header_triggers_changed';END IF;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) INTO actual FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
  WHERE k.conrelid=actual_work AND k.conname='native_turn_publication_operation' AND t.tgrelid=actual_work;
 SELECT jsonb_agg(mapped ORDER BY (mapped->>'oid')::oid) INTO expected FROM(
  SELECT pg_temp.publication_reference_trigger_record(t) mapped FROM pg_trigger t JOIN pg_constraint k ON k.oid=t.tgconstraint
  WHERE k.conrelid=reference_work AND k.conname='native_turn_publication_operation' AND t.tgrelid=reference_work) mapped;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_work_constraint_triggers_changed';END IF;

 SELECT jsonb_agg(to_jsonb(d) ORDER BY d.adnum) INTO actual FROM pg_attrdef d WHERE d.adrelid=actual_header;
 SELECT jsonb_agg((to_jsonb(d)-ARRAY['oid','adrelid'])||jsonb_build_object('adrelid',actual_header,
  'oid',(SELECT a.oid FROM pg_attrdef a WHERE a.adrelid=actual_header AND a.adnum=d.adnum)) ORDER BY d.adnum)
  INTO expected FROM pg_attrdef d WHERE d.adrelid=reference_header;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_header_defaults_changed';END IF;
 IF EXISTS(SELECT FROM pg_attrdef WHERE adrelid=actual_work AND adnum=new_attribute)
 THEN RAISE EXCEPTION 'publication_work_column_default_changed';END IF;
 EXECUTE 'DROP SCHEMA publication_source_reference CASCADE';
END $schema$;

CREATE FUNCTION pg_temp.publication_table_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $snapshot$
__PUBLICATION_TABLE_EXPRESSION__
$snapshot$;

DO $before_installer$
DECLARE old_snapshot jsonb;current_snapshot jsonb;remaining jsonb;old_rows jsonb;key text;
 header_id oid:='public.native_conversation_publications'::regclass;
 work_id oid:='public.native_turn_publication_work'::regclass;
 foreign_key oid:=(SELECT oid FROM pg_constraint WHERE conrelid='public.native_turn_publication_work'::regclass AND conname='native_turn_publication_operation');
BEGIN
 PERFORM pg_temp.publication_assert_source_schema();
 SELECT snapshot INTO STRICT old_snapshot FROM publication_predecessor_table_snapshot;
 current_snapshot:=pg_temp.publication_table_snapshot();
 FOREACH key IN ARRAY ARRAY['tables','columns','constraints','triggers','defaults','rules','policies'] LOOP
  SELECT coalesce(jsonb_agg(value ORDER BY ordinal),'[]') INTO remaining
  FROM jsonb_array_elements(coalesce(nullif(current_snapshot->key,'null'::jsonb),'[]')) WITH ORDINALITY input(value,ordinal)
  WHERE NOT(
   key='tables' AND value->>'oid'=header_id::text
   OR key='columns' AND value->>0=header_id::text
   OR key='constraints' AND value->>'conrelid'=header_id::text
   OR key='triggers' AND value->>'tgrelid'=header_id::text
   OR key='defaults' AND value->>'adrelid'=header_id::text
   OR key='columns' AND value->>0=work_id::text AND value->>2='publication_id'
   OR key='constraints' AND value->>'oid'=foreign_key::text
   OR key='triggers' AND value->>'tgrelid'=work_id::text AND value->>'tgconstraint'=foreign_key::text);
  old_rows:=coalesce(nullif(old_snapshot->key,'null'::jsonb),'[]');
  IF remaining IS DISTINCT FROM old_rows THEN RAISE EXCEPTION 'publication_existing_schema_changed: %',key USING ERRCODE='55000';END IF;
 END LOOP;
 INSERT INTO publication_before_installer_schema VALUES(current_snapshot);
 INSERT INTO publication_before_installer_details SELECT pg_temp.publication_schema_details();
 PERFORM pg_temp.publication_assert_expected_functions();
END $before_installer$;

CREATE FUNCTION pg_temp.publication_successors_after_install() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $after$
DECLARE before_snapshot jsonb;after_snapshot jsonb;before_details jsonb;after_details jsonb;trigger_record pg_trigger;
 reference_record pg_trigger;expected_trigger jsonb;remaining jsonb;key text;header_id oid:='public.native_conversation_publications'::regclass;
BEGIN
 IF EXISTS(SELECT 1 FROM publication_verified_table_snapshot) OR EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
  RAISE EXCEPTION 'publication_successor_phase_changed';END IF;
 -- The authenticated installer may add only the declared capture trigger.
 PERFORM pg_temp.publication_assert_expected_functions();
 IF (SELECT to_jsonb(t) FROM public.crm_erasure_journal_targets t WHERE table_name='native_conversation_publications')
  IS DISTINCT FROM jsonb_build_object('table_name','native_conversation_publications','key_columns',ARRAY['id']::text[],'capture_inserts',false)
 THEN RAISE EXCEPTION 'publication_recovery_target_changed' USING ERRCODE='55000';END IF;
 SELECT snapshot INTO STRICT before_snapshot FROM publication_before_installer_schema;
 SELECT snapshot INTO STRICT before_details FROM publication_before_installer_details;
 SELECT * INTO STRICT trigger_record FROM pg_trigger WHERE tgrelid=header_id AND tgname='crm_recovery_capture';
 IF to_regclass('pg_temp.publication_recovery_trigger_reference') IS NOT NULL THEN RAISE EXCEPTION 'publication_trigger_reference_exists';END IF;
 CREATE TEMP TABLE publication_recovery_trigger_reference(id uuid);
 CREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON publication_recovery_trigger_reference
  FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();
 SELECT * INTO STRICT reference_record FROM pg_trigger WHERE tgrelid='pg_temp.publication_recovery_trigger_reference'::regclass AND tgname='crm_recovery_capture';
 expected_trigger:=(to_jsonb(reference_record)-ARRAY['oid','tgrelid'])||jsonb_build_object('oid',trigger_record.oid,'tgrelid',header_id);
 IF to_jsonb(trigger_record) IS DISTINCT FROM expected_trigger THEN RAISE EXCEPTION 'publication_recovery_trigger_changed' USING ERRCODE='55000';END IF;
 DROP TABLE pg_temp.publication_recovery_trigger_reference;
 after_snapshot:=pg_temp.publication_table_snapshot();
 SELECT coalesce(jsonb_agg(value ORDER BY ordinal),'[]') INTO remaining FROM
  jsonb_array_elements(after_snapshot->'triggers') WITH ORDINALITY input(value,ordinal) WHERE value->>'oid'<>trigger_record.oid::text;
 after_snapshot:=jsonb_set(after_snapshot,'{triggers}',remaining);
 IF after_snapshot IS DISTINCT FROM before_snapshot THEN RAISE EXCEPTION 'publication_installer_schema_changed' USING ERRCODE='55000';END IF;
 after_details:=pg_temp.publication_schema_details();
 SELECT coalesce(jsonb_agg(value ORDER BY ordinal),'[]') INTO remaining FROM
  jsonb_array_elements(after_details->'triggers') WITH ORDINALITY input(value,ordinal) WHERE value->>'oid'<>trigger_record.oid::text;
 after_details:=jsonb_set(after_details,'{triggers}',remaining);
 IF after_details IS DISTINCT FROM before_details THEN RAISE EXCEPTION 'publication_installer_successor_changed' USING ERRCODE='55000';END IF;
 PERFORM pg_temp.publication_assert_expected_functions();
 INSERT INTO publication_verified_table_snapshot SELECT pg_temp.publication_table_snapshot();
END $after$;
-- phase: after_installer
SELECT pg_temp.publication_successors_after_install();
