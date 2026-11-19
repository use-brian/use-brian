-- [COMP:api/native-turn-frame] Source compiler for fresh conversion relations.
-- __CONVERSION_REFERENCE_DDL__ is rendered from only the finite maintained
-- CREATE TYPE/TABLE/ALTER TABLE/REVOKE declarations, never LIKE or target rows.
CREATE FUNCTION pg_temp.conversion_map_relation(i oid) RETURNS oid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n name;s name;
BEGIN
 IF i=0 THEN RETURN 0;END IF;
 SELECT c.relname,ns.nspname INTO STRICT n,s FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace WHERE c.oid=i;
 IF s<>'conversion_source_reference' THEN RETURN i;END IF;
 RETURN to_regclass(format('public.%I',n));
END $$;
CREATE FUNCTION pg_temp.conversion_map_type(i oid) RETURNS oid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE n name;s name;
BEGIN
 IF i=0 THEN RETURN 0;END IF;
 SELECT t.typname,ns.nspname INTO STRICT n,s FROM pg_type t JOIN pg_namespace ns ON ns.oid=t.typnamespace WHERE t.oid=i;
 IF s<>'conversion_source_reference' THEN RETURN i;END IF;
 RETURN to_regtype(format('public.%I',n));
END $$;
CREATE FUNCTION pg_temp.conversion_map_constraint(i oid) RETURNS oid LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE original pg_constraint;mapped oid;
BEGIN
 IF i=0 THEN RETURN 0;END IF;
 SELECT * INTO STRICT original FROM pg_constraint WHERE oid=i;
 SELECT oid INTO STRICT mapped FROM pg_constraint WHERE conrelid=pg_temp.conversion_map_relation((original).conrelid) AND conname=(original).conname;
 RETURN mapped;
END $$;
CREATE FUNCTION pg_temp.conversion_constraint(c pg_constraint,mapping boolean) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN mapping THEN (to_jsonb(c)-ARRAY['oid','connamespace','conrelid','conindid','confrelid'])||jsonb_build_object(
  'oid',pg_temp.conversion_map_constraint((c).oid),'connamespace','public'::regnamespace::oid,
  'conrelid',pg_temp.conversion_map_relation((c).conrelid),'conindid',pg_temp.conversion_map_relation((c).conindid),'confrelid',pg_temp.conversion_map_relation((c).confrelid)) ELSE to_jsonb(c) END
$$;
CREATE FUNCTION pg_temp.conversion_trigger(t pg_trigger,mapping boolean) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE mapped oid;n text;
BEGIN
 IF NOT mapping THEN RETURN to_jsonb(t);END IF;
 IF (t).tgisinternal THEN
  SELECT oid INTO STRICT mapped FROM pg_trigger WHERE tgrelid=pg_temp.conversion_map_relation((t).tgrelid)
    AND tgconstraint=pg_temp.conversion_map_constraint((t).tgconstraint) AND tgtype=(t).tgtype AND tgisinternal;
  IF right((t).tgname::text,length((t).oid::text))<>(t).oid::text OR (t).tgname!~'^RI_ConstraintTrigger_[ac]_' THEN RAISE EXCEPTION 'conversion_reference_internal_trigger_name';END IF;
  n:=left((t).tgname::text,length((t).tgname::text)-length((t).oid::text))||mapped::text;
 ELSE
  SELECT oid INTO STRICT mapped FROM pg_trigger WHERE tgrelid=pg_temp.conversion_map_relation((t).tgrelid) AND tgname=(t).tgname;
  n:=(t).tgname;
 END IF;
 RETURN (to_jsonb(t)-ARRAY['oid','tgname','tgrelid','tgconstraint','tgconstrrelid','tgconstrindid'])||jsonb_build_object(
  'oid',mapped,'tgname',n,'tgrelid',pg_temp.conversion_map_relation((t).tgrelid),'tgconstraint',pg_temp.conversion_map_constraint((t).tgconstraint),
  'tgconstrrelid',pg_temp.conversion_map_relation((t).tgconstrrelid),'tgconstrindid',pg_temp.conversion_map_relation((t).tgconstrindid));
END $$;
CREATE FUNCTION pg_temp.conversion_schema_snapshot(source_schema text,mapping boolean) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 WITH relations AS(SELECT c.* FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=source_schema
  AND c.relname=ANY(ARRAY['native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages'])),
 types AS(SELECT t.* FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=source_schema
  AND t.typname=ANY(ARRAY['native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages','native_conversation_requirement_source','native_conversation_conversion_unit_kind','_native_conversation_frame_requirements','_native_conversation_conversion_runs','_native_conversation_conversion_inputs','_native_conversation_conversion_pending','_native_conversation_conversion_pages','_native_conversation_requirement_source','_native_conversation_conversion_unit_kind']))
 SELECT jsonb_build_object(
  'relations',(SELECT jsonb_agg(pg_temp.publication_relation_semantics(c::pg_class) ORDER BY c.relname COLLATE "C") FROM relations c),
  'columns',(SELECT jsonb_agg(CASE WHEN mapping THEN (pg_temp.publication_attribute_semantics(a)-ARRAY['attrelid','atttypid'])||jsonb_build_object('attrelid',pg_temp.conversion_map_relation(a.attrelid),'atttypid',pg_temp.conversion_map_type(a.atttypid)) ELSE pg_temp.publication_attribute_semantics(a) END ORDER BY c.relname COLLATE "C",a.attnum) FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid WHERE a.attnum>0),
  'constraints',(SELECT jsonb_agg(pg_temp.conversion_constraint(k,mapping) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C") FROM relations c JOIN pg_constraint k ON k.conrelid=c.oid),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('index',CASE WHEN mapping THEN(to_jsonb(i)-ARRAY['indexrelid','indrelid'])||jsonb_build_object('indexrelid',pg_temp.conversion_map_relation(i.indexrelid),'indrelid',pg_temp.conversion_map_relation(i.indrelid)) ELSE to_jsonb(i) END,'relation',pg_temp.publication_relation_semantics(r)) ORDER BY c.relname COLLATE "C",r.relname COLLATE "C") FROM relations c JOIN pg_index i ON i.indrelid=c.oid JOIN pg_class r ON r.oid=i.indexrelid),
  'defaults',(SELECT jsonb_agg(CASE WHEN mapping THEN(to_jsonb(d)-ARRAY['oid','adrelid'])||jsonb_build_object('oid',(SELECT p.oid FROM pg_attrdef p WHERE p.adrelid=pg_temp.conversion_map_relation(d.adrelid) AND p.adnum=d.adnum),'adrelid',pg_temp.conversion_map_relation(d.adrelid)) ELSE to_jsonb(d) END ORDER BY c.relname COLLATE "C",d.adnum) FROM relations c JOIN pg_attrdef d ON d.adrelid=c.oid),
  'triggers',(SELECT jsonb_agg(pg_temp.conversion_trigger(t,mapping) ORDER BY (pg_temp.conversion_trigger(t,mapping)->>'oid')::oid) FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid),
  'types',(SELECT jsonb_agg(CASE WHEN mapping THEN(to_jsonb(t)-ARRAY['oid','typnamespace','typrelid','typelem','typarray'])||jsonb_build_object('oid',pg_temp.conversion_map_type(t.oid),'typnamespace','public'::regnamespace::oid,'typrelid',pg_temp.conversion_map_relation(t.typrelid),'typelem',pg_temp.conversion_map_type(t.typelem),'typarray',pg_temp.conversion_map_type(t.typarray)) ELSE to_jsonb(t) END ORDER BY t.typname COLLATE "C") FROM types t),
  'typeColumns',(SELECT jsonb_agg(CASE WHEN mapping THEN(pg_temp.publication_attribute_semantics(a)-ARRAY['attrelid','atttypid'])||jsonb_build_object('attrelid',pg_temp.conversion_map_relation(a.attrelid),'atttypid',pg_temp.conversion_map_type(a.atttypid)) ELSE pg_temp.publication_attribute_semantics(a) END ORDER BY t.typname COLLATE "C",a.attnum) FROM types t JOIN pg_attribute a ON a.attrelid=t.typrelid WHERE a.attnum>0),
  'enum',(SELECT jsonb_agg(jsonb_build_array(t.typname,e.enumlabel,e.enumsortorder) ORDER BY t.typname COLLATE "C",e.enumsortorder) FROM types t JOIN pg_enum e ON e.enumtypid=t.oid),
  'recoveryTargets',CASE WHEN mapping THEN(SELECT jsonb_agg(jsonb_build_object('table_name',c.relname,'key_columns',
    (SELECT array_agg(a.attname::text ORDER BY k.ordinal) FROM pg_constraint p,unnest(p.conkey) WITH ORDINALITY k(id,ordinal),pg_attribute a WHERE p.conrelid=c.oid AND p.contype='p' AND a.attrelid=c.oid AND a.attnum=k.id),'capture_inserts',false) ORDER BY c.relname COLLATE "C") FROM relations c)
    ELSE(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.table_name COLLATE "C") FROM public.crm_erasure_journal_targets t WHERE t.table_name IN(SELECT relname FROM relations)) END,
  'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM relations c JOIN pg_policy p ON p.polrelid=c.oid),
  'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM relations c JOIN pg_rewrite r ON r.ev_class=c.oid),
  'inheritance',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.inhrelid,i.inhseqno) FROM pg_inherits i WHERE i.inhrelid IN(SELECT oid FROM relations) OR i.inhparent IN(SELECT oid FROM relations)))
$$;

CREATE TEMP TABLE conversion_verified_schema(snapshot jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE conversion_source_added_triggers(metadata jsonb NOT NULL) ON COMMIT DROP;
CREATE SCHEMA conversion_source_reference;
__CONVERSION_REFERENCE_DDL__
-- All expected declarations above came from maintained source. New source
-- tables must be owner-only even when ambient defaults mention another role.
DO $conversion_assert_source_relations$
DECLARE actual jsonb;expected jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(ARRAY[
  'native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages'])
  AND coalesce(relacl,acldefault('r',relowner)) IS DISTINCT FROM acldefault('r',relowner))
 THEN RAISE EXCEPTION 'conversion_relation_private_acl_changed';END IF;
 actual:=pg_temp.conversion_schema_snapshot('public',false);expected:=pg_temp.conversion_schema_snapshot('conversion_source_reference',true);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'conversion_source_schema_mismatch' USING DETAIL=(SELECT jsonb_agg(key)::text FROM jsonb_each(expected) e WHERE e.value IS DISTINCT FROM actual->e.key);END IF;
 INSERT INTO conversion_verified_schema VALUES(expected);
 -- These include source-defined child AND parent RI rows. Their exact complete
 -- records are compiled by trusted declarations and mapped by named identity.
 INSERT INTO conversion_source_added_triggers SELECT pg_temp.conversion_trigger(t,true) FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint
 WHERE c.conrelid IN(SELECT oid FROM pg_class WHERE relnamespace='conversion_source_reference'::regnamespace AND relkind='r');
END $conversion_assert_source_relations$;
DROP SCHEMA conversion_source_reference CASCADE;
