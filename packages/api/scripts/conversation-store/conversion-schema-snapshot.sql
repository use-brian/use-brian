-- [COMP:api/native-turn-frame] Exact fresh conversion catalogue observation.
WITH relations AS(SELECT c.* FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(ARRAY[
 'native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages'])),
 types AS(SELECT t.* FROM pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname=ANY(ARRAY[
 'native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages','native_conversation_requirement_source','native_conversation_conversion_unit_kind',
 '_native_conversation_frame_requirements','_native_conversation_conversion_runs','_native_conversation_conversion_inputs','_native_conversation_conversion_pending','_native_conversation_conversion_pages','_native_conversation_requirement_source','_native_conversation_conversion_unit_kind']))
SELECT jsonb_build_object(
 'relations',(SELECT jsonb_agg(__CLASS_C__ ORDER BY c.relname COLLATE "C") FROM relations c),
 'columns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY c.relname COLLATE "C",a.attnum) FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid WHERE a.attnum>0),
 'constraints',(SELECT jsonb_agg(to_jsonb(k) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C") FROM relations c JOIN pg_constraint k ON k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('index',to_jsonb(i),'relation',__CLASS_R__) ORDER BY c.relname COLLATE "C",r.relname COLLATE "C") FROM relations c JOIN pg_index i ON i.indrelid=c.oid JOIN pg_class r ON r.oid=i.indexrelid),
 'defaults',(SELECT jsonb_agg(to_jsonb(d) ORDER BY c.relname COLLATE "C",d.adnum) FROM relations c JOIN pg_attrdef d ON d.adrelid=c.oid),
 'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid),
 'types',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.typname COLLATE "C") FROM types t),
 'typeColumns',(SELECT jsonb_agg(to_jsonb(a) ORDER BY t.typname COLLATE "C",a.attnum) FROM types t JOIN pg_attribute a ON a.attrelid=t.typrelid WHERE a.attnum>0),
 'enum',(SELECT jsonb_agg(jsonb_build_array(t.typname,e.enumlabel,e.enumsortorder) ORDER BY t.typname COLLATE "C",e.enumsortorder) FROM types t JOIN pg_enum e ON e.enumtypid=t.oid),
 'recoveryTargets',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.table_name COLLATE "C") FROM public.crm_erasure_journal_targets t WHERE t.table_name IN(SELECT relname FROM relations)),
 'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid) FROM relations c JOIN pg_policy p ON p.polrelid=c.oid),
 'rules',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.oid) FROM relations c JOIN pg_rewrite r ON r.ev_class=c.oid),
 'inheritance',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.inhrelid,i.inhseqno) FROM pg_inherits i WHERE i.inhrelid IN(SELECT oid FROM relations) OR i.inhparent IN(SELECT oid FROM relations)))
