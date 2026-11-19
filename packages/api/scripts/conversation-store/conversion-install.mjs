// [COMP:api/native-turn-frame] Source-owned conversion enrollment and repinning.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {conversionSourceProfile} from './conversion-source-profile.mjs'
const lit=x=>"'"+x.replaceAll("'","''")+"'"
export async function conversionInstall(input,module,directory){
 const compilerDigest=createHash('sha256').update(module).digest('hex')
 const compilerCheck="IF compiler IS NULL OR compiler !~ '^[a-f0-9]{64}$'"
 if(module.split(compilerCheck).length!==2)throw Error('conversion_compiler_identity_source_changed')
 module=module.replace(compilerCheck,()=>"IF compiler IS DISTINCT FROM '"+compilerDigest+"' OR compiler IS NULL OR compiler !~ '^[a-f0-9]{64}$'")
 module=module.replace("IF r.protocol_version<>1 THEN RAISE EXCEPTION 'conversion_unsupported_protocol';END IF;",()=>"IF r.protocol_version<>1 OR r.compiler_digest IS DISTINCT FROM '"+compilerDigest+"' THEN RAISE EXCEPTION 'conversion_unsupported_protocol';END IF;")
 module=module.replace("IF r.protocol_version<>1 OR NOT r.audit_done OR r.phase<>'delta'",()=>"IF r.protocol_version<>1 OR r.compiler_digest IS DISTINCT FROM '"+compilerDigest+"' OR NOT r.audit_done OR r.phase<>'delta'")
 const profile=conversionSourceProfile(module),source=await readFile(directory+'conversion-original-consumers.sql','utf8')
 const specifications=profile.functions.map((p,index)=>({name:p.name,referenceName:'conversion_source_function_'+index,reference:p.reference(index)}))
 const map=sql=>sql.replace(/public\.(native_conversation_[a-z_]+)/g,'conversion_source_reference.$1')
 let ddl=[...profile.tables,...profile.privileges.filter(p=>!p.startsWith('REVOKE ALL ON FUNCTION'))].map(map).join('\n')
 const guard=profile.triggers.find(p=>p.includes('ON public.native_conversation_frame_requirements'))
 ddl+='\n'+guard.replace('ON public.native_conversation_frame_requirements','ON conversion_source_reference.native_conversation_frame_requirements')
 for(const name of ['native_conversation_frame_requirements','native_conversation_conversion_runs','native_conversation_conversion_inputs','native_conversation_conversion_pending','native_conversation_conversion_pages'])ddl+=`\nCREATE TRIGGER crm_recovery_capture AFTER INSERT OR UPDATE OR DELETE ON conversion_source_reference.${name} FOR EACH ROW EXECUTE FUNCTION public.crm_capture_erasure_effect();`
 const schema=(await readFile(directory+'conversion-schema-reference.sql','utf8')).replace(/^__CONVERSION_REFERENCE_DDL__$/m,()=>ddl)
 const headerStart=input.successorSource.indexOf('CREATE FUNCTION pg_temp.publication_relation_semantics('),headerEnd=input.successorSource.indexOf('$shape$;',headerStart)
 const header=input.successorSource.slice(headerStart,headerEnd).split('AS $shape$')[1].trim()
 const expression=(await readFile(directory+'conversion-schema-snapshot.sql','utf8')).replace(/^--.*\n/,'').trim().replaceAll('__CLASS_C__','('+header.replaceAll('relation_record','c')+')').replaceAll('__CLASS_R__','('+header.replaceAll('relation_record','r')+')')
 const enrolled=[]
 for(const [index,trigger] of profile.triggers.filter(p=>p!==guard).entries()){
  const match=trigger.match(/ON (?:public\.)?([a-z_]+) FOR EACH ROW/);if(!match)throw Error('conversion_enrollment_source_changed')
  enrolled.push(`CREATE TEMP TABLE conversion_enrollment_reference_${index}(workspace_id uuid,id uuid);
${trigger.replace('ON '+match[1]+' FOR EACH ROW',`ON pg_temp.conversion_enrollment_reference_${index} FOR EACH ROW`)}
DO $enrollment$ DECLARE actual pg_trigger;reference pg_trigger;expected jsonb;BEGIN
 SELECT * INTO STRICT actual FROM pg_trigger WHERE tgrelid=${lit('public.'+match[1])}::regclass AND tgname='native_conversation_conversion_enroll';
 SELECT * INTO STRICT reference FROM pg_trigger WHERE tgrelid='pg_temp.conversion_enrollment_reference_${index}'::regclass AND tgname='native_conversation_conversion_enroll';
 expected:=(to_jsonb(reference)-ARRAY['oid','tgrelid'])||jsonb_build_object('oid',actual.oid,'tgrelid',actual.tgrelid);
 IF to_jsonb(actual) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'conversion_enrollment_source_mismatch';END IF;
 INSERT INTO conversion_source_added_triggers VALUES(expected);
END $enrollment$;
DROP TABLE pg_temp.conversion_enrollment_reference_${index};`)
 }
 const signatures=profile.functions.map(p=>p.name+'('+p.args.split(',').filter(Boolean).map(a=>a.trim().split(/\s+/).slice(1).join(' ').replaceAll('public.','')).join(',')+')')
 signatures.push('native_conversation_conversion_contract()')
 const names=[...input.nextRoster.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replaceAll("''","'")),nextNames=[...names,...signatures].sort()
 if(new Set(nextNames).size!==295)throw Error('conversion_registry_roster_source_changed')
 const sourceOrderStart=input.authenticationPreamble.indexOf('CREATE FUNCTION pg_temp.publication_source_body('),sourceOrderEnd=input.authenticationPreamble.indexOf('END $source_order$;',sourceOrderStart)
 let sourceOrder=input.authenticationPreamble.slice(sourceOrderStart,sourceOrderEnd+'END $source_order$;'.length)
 const assertion="IF successor IS NULL OR parts IS DISTINCT FROM expected_parts THEN RAISE EXCEPTION 'publication_source_ordering_template_changed';END IF;"
 if(sourceOrder.split(assertion).length!==2)throw Error('conversion_source_order_assertion_changed')
 sourceOrder=sourceOrder.replace('pg_temp.publication_source_body','pg_temp.conversion_source_body').replace(assertion,"IF successor IS DISTINCT FROM true THEN RAISE EXCEPTION 'conversion_source_order_profile_changed';END IF;")
 sourceOrder=sourceOrder.replace(lit(JSON.stringify(names)),lit(JSON.stringify(nextNames)))
 const prefix='\n SELECT native_turn_publication_contract() AND ('
 sourceOrder=sourceOrder.replace('RETURN replace(body,roster,ordered_roster);',`RETURN replace(replace(body,roster,ordered_roster),${lit(prefix)},${lit('\n SELECT native_turn_publication_contract() AND native_conversation_conversion_contract() AND (')});`)
 const install=`${source}
${module}
-- Every newly created executable is compared to an independently compiled source declaration.
DO $conversion_source_functions$
DECLARE spec jsonb;actual pg_proc;reference pg_proc;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 FOR spec IN SELECT value FROM jsonb_array_elements(${lit(JSON.stringify(specifications))}::jsonb) LOOP
  EXECUTE spec->>'reference';
  SELECT * INTO STRICT actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=spec->>'name';
  SELECT * INTO STRICT reference FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=spec->>'referenceName';
  IF (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM (to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proacl'])
   OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
  THEN RAISE EXCEPTION 'conversion_source_function_mismatch: %',spec->>'name';END IF;
 END LOOP;
END $conversion_source_functions$;
-- The authenticated existing recovery owner enrolls the five new relations.
SELECT public.crm_install_erasure_capture();
${schema}
${enrolled.join('\n')}
-- Every field except the explicitly typed engine attribute-version identity was
-- already checked against independent source DDL above. Retain that identity's
-- exact installed value for all subsequent fresh boundary comparisons.
CREATE TEMP TABLE conversion_verified_runtime_snapshot(snapshot jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO conversion_verified_runtime_snapshot ${expression};
DO $conversion_table_contract$
DECLARE snapshot jsonb;triggers jsonb;trigger_ids text;body text;actual pg_proc;reference pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
BEGIN
 SELECT s.snapshot INTO STRICT snapshot FROM conversion_verified_runtime_snapshot s;
 SELECT jsonb_agg(metadata ORDER BY (metadata->>'oid')::oid),string_agg((metadata->>'oid')||'::oid',',' ORDER BY (metadata->>'oid')::oid)
 INTO triggers,trigger_ids FROM conversion_source_added_triggers;
 body:='\n SELECT ('||${lit(expression)}||') IS NOT DISTINCT FROM '||quote_literal(snapshot::text)||'::jsonb AND\n (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t WHERE t.oid=ANY(ARRAY['||trigger_ids||'])) IS NOT DISTINCT FROM '||quote_literal(triggers::text)||'::jsonb';
 EXECUTE format('CREATE FUNCTION public.native_conversation_conversion_contract() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 REVOKE ALL ON FUNCTION public.native_conversation_conversion_contract() FROM PUBLIC,app_user;
 EXECUTE format('CREATE FUNCTION pg_temp.conversion_contract_reference() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS %L',body);
 SELECT * INTO STRICT actual FROM pg_proc WHERE oid='public.native_conversation_conversion_contract()'::regprocedure;
 SELECT * INTO STRICT reference FROM pg_proc WHERE oid='pg_temp.conversion_contract_reference()'::regprocedure;
 IF (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM(to_jsonb(reference)-ARRAY['oid','proname','pronamespace','proacl'])
  OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
 THEN RAISE EXCEPTION 'conversion_contract_source_mismatch';END IF;
 INSERT INTO publication_expected_current VALUES('native_conversation_conversion_contract()',to_jsonb(actual));
 INSERT INTO publication_successor_templates VALUES('native_conversation_conversion_contract()',jsonb_build_array(body));
END $conversion_table_contract$;
-- Extend only the exact source-owned trigger predicates changed by this module.
DO $conversion_table_templates$
DECLARE parts jsonb;part jsonb;original jsonb;added jsonb;next_parts jsonb:='[]';index integer:=0;
BEGIN
 SELECT t.parts INTO STRICT parts FROM publication_successor_templates t WHERE signature='native_turn_helpers_current()';
 FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
  IF index=1 THEN
   original:=pg_temp.publication_json(part#>'{slot,template}');
   SELECT coalesce(jsonb_agg(metadata),'[]') INTO added FROM conversion_source_added_triggers WHERE metadata->>'tgrelid'='public.scope_derivation_sources'::regclass::oid::text;
   SELECT jsonb_agg(value ORDER BY (value->>'oid')::oid) INTO original FROM jsonb_array_elements(original||added);
   part:=to_jsonb(quote_literal(original::text));
  END IF;
  next_parts:=next_parts||jsonb_build_array(part);index:=index+1;
 END LOOP;
 UPDATE publication_successor_templates SET parts=next_parts WHERE signature='native_turn_helpers_current()';
 SELECT snapshot INTO STRICT original FROM publication_before_installer_schema;
 SELECT coalesce(jsonb_agg(metadata),'[]') INTO added FROM conversion_source_added_triggers
  WHERE metadata->>'tgrelid' IN(SELECT value->>'oid' FROM jsonb_array_elements(original->'tables'));
 SELECT jsonb_agg(value ORDER BY (value->>'oid')::oid) INTO added FROM jsonb_array_elements((original->'triggers')||added);
 original:=jsonb_set(original,'{triggers}',added);next_parts:='[]';
 SELECT t.parts INTO STRICT parts FROM publication_successor_templates t WHERE signature='native_turn_publication_contract()';
 FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
  IF part#>>'{slot,kind}'='conversionVerifiedPublicationTables' THEN part:=to_jsonb(quote_literal(original::text));END IF;
  next_parts:=next_parts||jsonb_build_array(part);
 END LOOP;
 UPDATE publication_successor_templates SET parts=next_parts WHERE signature='native_turn_publication_contract()';
END $conversion_table_templates$;
${sourceOrder}
DO $conversion_enroll_functions$
DECLARE signature text;actual pg_proc;
BEGIN
 FOREACH signature IN ARRAY ARRAY[${signatures.map(lit).join(',')}]::text[] LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||signature);
  IF signature<>'native_conversation_conversion_contract()' THEN
   INSERT INTO publication_expected_current VALUES(signature,to_jsonb(actual));
   INSERT INTO publication_successor_templates VALUES(signature,jsonb_build_array(actual.prosrc));
  END IF;
  INSERT INTO native_turn_contract_helpers VALUES(signature,actual);
 END LOOP;
END $conversion_enroll_functions$;
DO $conversion_propagate$
DECLARE routine record;actual pg_proc;after_row pg_proc;expected jsonb;next_expected jsonb;body text;definition text;old_hash text;new_hash text;passes integer:=0;changes integer;
BEGIN
 LOOP
  passes:=passes+1;IF passes>100 THEN RAISE EXCEPTION 'conversion_pin_cycle';END IF;changes:=0;
  FOR routine IN SELECT t.signature,t.parts FROM publication_successor_templates t ORDER BY t.signature COLLATE "C" LOOP
   SELECT metadata INTO STRICT expected FROM publication_expected_current WHERE signature=routine.signature;
   SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure(routine.signature);
   IF to_jsonb(actual) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'conversion_unreviewed_successor_change: %',routine.signature;END IF;
   body:=pg_temp.conversion_source_body(routine.signature,routine.parts,true);
   IF (actual.prosrc COLLATE "C") IS NOT DISTINCT FROM(body COLLATE "C") THEN CONTINUE;END IF;
   old_hash:=encode(sha256(convert_to(expected::text,'UTF8')),'hex');
   definition:=pg_get_functiondef(actual.oid);
   IF actual.prosrc='' OR(length(definition)-length(replace(definition,actual.prosrc,'')))/length(actual.prosrc)<>1 THEN RAISE EXCEPTION 'conversion_owning_body_shape';END IF;
   EXECUTE replace(definition,actual.prosrc,body);
   SELECT * INTO STRICT after_row FROM pg_proc WHERE oid=actual.oid;
   next_expected:=jsonb_set(expected,'{prosrc}',to_jsonb(body));
   IF to_jsonb(after_row) IS DISTINCT FROM next_expected THEN RAISE EXCEPTION 'conversion_rendered_metadata_changed';END IF;
   IF EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=routine.signature AND to_jsonb(h.contract) IS DISTINCT FROM expected) THEN RAISE EXCEPTION 'conversion_registry_predecessor_changed';END IF;
   UPDATE native_turn_contract_helpers SET contract=after_row WHERE signature=routine.signature;
   new_hash:=encode(sha256(convert_to(next_expected::text,'UTF8')),'hex');
   IF EXISTS(SELECT 1 FROM native_retained_contract_helpers h WHERE h.signature=routine.signature AND h.fingerprint<>old_hash) THEN RAISE EXCEPTION 'conversion_retained_predecessor_changed';END IF;
   UPDATE native_retained_contract_helpers SET fingerprint=new_hash WHERE signature=routine.signature AND fingerprint=old_hash;
   UPDATE publication_expected_current SET metadata=next_expected WHERE signature=routine.signature;changes:=changes+1;
  END LOOP;
  EXIT WHEN changes=0;
 END LOOP;
 IF EXISTS(SELECT 1 FROM publication_expected_current e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature) WHERE to_jsonb(p) IS DISTINCT FROM e.metadata)
  OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h JOIN pg_proc p ON p.oid=to_regprocedure(h.signature) WHERE p IS DISTINCT FROM h.contract)
  OR native_conversation_conversion_contract() IS NOT TRUE OR native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE OR native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversion_successor_contract_changed';END IF;
END $conversion_propagate$;
`
 return install
}
