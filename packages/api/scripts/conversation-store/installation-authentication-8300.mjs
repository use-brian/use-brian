// [COMP:api/conversation-record-conversion] Read-only source profile for bounded record payload conversion.
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {currentInstallationAuthenticationSource as predecessorSource,assertAuthenticationReadOnly as predecessorReadOnly} from './installation-authentication-8298.mjs'
import {number,conversionRecordSignatures,conversionRecordRenderer,legacyConversionBodies} from './build-conversation-record-conversion.mjs'
import {executableProjection} from './executable-record.mjs'

const sha=value=>createHash('sha256').update(value).digest('hex')
const q=value=>"'"+value.replaceAll("'","''")+"'"
const once=(source,before,after)=>{
 if(source.split(before).length!==2)throw Error('record_conversion_auth_source_changed: '+before.slice(0,100))
 return source.replace(before,()=>after)
}
const digest='529b96787bf97fdb04b51332de7d27f91e60830221b816348b7a9e4a49ead8cb'
const prefix='a8298_',referenceSchema=prefix+'conversion_source_reference'
const renderer=prefix+'conversion_source_body',previousRenderer=prefix+'record_conversion_pred_body'
const referenceSignature='native_conversation_conversion_inputs_record_session_id_fkey'

export function assertAuthenticationReadOnly(sql){return predecessorReadOnly(sql.replaceAll('a8300_','a8298_'))}

function independentDefinitions(schema){
 const functions=[...schema.matchAll(/^CREATE FUNCTION public\.([a-z_]+)\(([\s\S]*?\bAS (\$[a-z_]+\$))([\s\S]*?)\3;/gm)]
 if(functions.length!==conversionRecordSignatures.length)throw Error('record_conversion_auth_member_roster_changed')
 const specs=functions.map(([,name,start,tag,body])=>{
  const signature=conversionRecordSignatures.find(signature=>signature.startsWith(name+'('))
  if(!signature)throw Error('record_conversion_auth_unreviewed_member: '+name)
  const reference=`${prefix}record_copy_${name}`.slice(0,63)
  const args=signature.slice(name.length)
  return {signature,reference:reference+args,ddl:`CREATE FUNCTION pg_temp.${reference}(${start}${body}${tag};`}
 })
 return `DO $record_conversion_private_references$ BEGIN
 ${specs.map(member=>'EXECUTE '+q(member.ddl)+';').join('\n ')}
END $record_conversion_private_references$;
DO $record_conversion_auth_members$
DECLARE reviewed record;actual pg_proc;expected pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.workspaces'::regclass);
BEGIN
 FOR reviewed IN SELECT * FROM (VALUES ${specs.map(x=>`(${q(x.signature)},${q(x.reference)})`).join(',')}) members(signature,reference) LOOP
  SELECT * INTO STRICT actual FROM pg_proc WHERE oid=to_regprocedure('public.'||reviewed.signature);
  SELECT * INTO STRICT expected FROM pg_proc WHERE oid=to_regprocedure('pg_temp.'||reviewed.reference);
  IF actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)]
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
      (to_jsonb(expected)-ARRAY['oid','proname','pronamespace','proacl'])
   OR NOT EXISTS(SELECT 1 FROM public.native_turn_contract_helpers h WHERE h.signature=reviewed.signature
     AND h.contract IS NOT DISTINCT FROM ${executableProjection('actual')})
  THEN RAISE EXCEPTION 'record_conversion_auth_member_changed: %',reviewed.signature;END IF;
  INSERT INTO pg_temp.${prefix}publication_expected_current VALUES(reviewed.signature,to_jsonb(actual));
  INSERT INTO pg_temp.${prefix}publication_successor_templates VALUES(reviewed.signature,jsonb_build_array(expected.prosrc));
 END LOOP;
END $record_conversion_auth_members$;
${specs.map(member=>`DROP FUNCTION pg_temp.${member.reference};`).join('\n')}`
}

function independentSchema(schema){
 const firstFunction=schema.indexOf('CREATE FUNCTION public.'),guard=schema.match(/^CREATE TRIGGER protect_compiled_conversation_payload[\s\S]+?;$/m)?.[0]
 if(firstFunction<0||!guard)throw Error('record_conversion_auth_trigger_roster_changed')
 const ddl=oneEnvelope(schema.slice(0,firstFunction))
 const map=sql=>sql.replace(/public\.(native_conversation_conversion_[a-z_]+|conversation_envelopes)\b/g,referenceSchema+'.$1')
 const mapped=map(ddl),index=mapped.match(/^CREATE INDEX native_conversation_record_copies[\s\S]+?;$/m)?.[0]
 if(!index||!index.startsWith(`CREATE INDEX native_conversation_record_copies ON ${referenceSchema}.`))
  throw Error('record_conversion_auth_index_source_changed')
 return `CREATE TABLE ${referenceSchema}.conversation_envelopes(session_id uuid PRIMARY KEY);
${once(mapped,index,`DO $record_conversion_reference_index$ BEGIN EXECUTE ${q(index)}; END $record_conversion_reference_index$;`)}
${map(guard)}`
}

function oneEnvelope(ddl){
 const match=ddl.match(/^ALTER TABLE public\.conversation_envelopes\n[^;]+;$/m)
 if(!match)throw Error('record_conversion_auth_envelope_columns_changed')
 return once(ddl,match[0],'')
}

function independentlyCompareEnvelope(){
 return `DO $record_conversion_auth_envelope$
DECLARE e oid:='public.conversation_envelopes'::regclass;a pg_attribute;t pg_trigger;r record;
BEGIN
 FOR r IN SELECT * FROM (VALUES('record_conversion_generation','int8'),('record_conversion_revision','int8'),
   ('record_conversion_through','int4'),('record_conversion_legacy','bool')) fields(name,type) LOOP
  SELECT * INTO STRICT a FROM pg_attribute WHERE attrelid=e AND attname=r.name AND attnum>0 AND NOT attisdropped;
  IF a.atttypid<>to_regtype(r.type) OR a.attnotnull OR a.atthasdef OR a.attgenerated<>'' OR a.attidentity<>''
  THEN RAISE EXCEPTION 'record_conversion_auth_envelope_field_changed: %',r.name;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=e AND conname='conversation_envelopes_record_conversion_through_check'
    AND convalidated AND pg_get_constraintdef(oid)='CHECK ((record_conversion_through >= 0))')
 THEN RAISE EXCEPTION 'record_conversion_auth_envelope_bound_changed';END IF;
 FOR r IN SELECT * FROM (VALUES('enqueue_conversation_record_conversion',12),('requeue_conversation_record_conversion',16)) deps(name,type) LOOP
  SELECT * INTO STRICT t FROM pg_trigger WHERE tgrelid=e AND tgname=r.name;
  IF t.tgfoid<>'public.enqueue_conversation_record_conversion()'::regprocedure OR t.tgtype<>r.type+1 OR t.tgenabled<>'O'
   OR t.tgnargs<>0 OR t.tgisinternal OR t.tgconstraint<>0
  THEN RAISE EXCEPTION 'record_conversion_auth_envelope_trigger_changed: %',r.name;END IF;
  IF r.type=16 AND (t.tgqual IS NULL OR pg_get_triggerdef(t.oid) NOT LIKE
    '% AFTER UPDATE OF version, record_data_revision ON % FOR EACH ROW WHEN (((old.version IS DISTINCT FROM new.version) OR (old.record_data_revision IS DISTINCT FROM new.record_data_revision))) EXECUTE FUNCTION enqueue_conversation_record_conversion()')
   OR r.type=12 AND (t.tgqual IS NOT NULL OR t.tgattr::text<>'')
  THEN RAISE EXCEPTION 'record_conversion_auth_envelope_trigger_condition_changed: %',r.name;END IF;
 END LOOP;
END $record_conversion_auth_envelope$;`
}

export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}){
 const raw=await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/'+number,'utf8')
 if(sha(raw)!==digest)throw Error('installation_source_migration_changed')
 const [source,legacy]=await Promise.all([predecessorSource({sourceRoot}),legacyConversionBodies()])
 const schemaMarker='-- [COMP:api/conversation-record-conversion] Bounded exact payload copies'
 const schemaEnd='CREATE TEMP TABLE record_conversion_snapshot('
 if(raw.split(schemaMarker).length!==2||raw.split(schemaEnd).length!==2)throw Error('record_conversion_auth_migration_section_changed')
 const schema=raw.slice(raw.indexOf(schemaMarker),raw.indexOf(schemaEnd))
 let sql=source.sql
 const rendererDeclaration=`CREATE FUNCTION pg_temp.${renderer}(routine text,parts jsonb,successor boolean)`
 const renderStart=sql.indexOf(rendererDeclaration),renderEnd=sql.indexOf('END $legacy_bypass_renderer$;',renderStart)
 if(renderStart<0||renderEnd<renderStart)throw Error('record_conversion_predecessor_renderer_changed')
 const splice=renderEnd+'END $legacy_bypass_renderer$;'.length
 sql=sql.slice(0,splice)+'\n'+conversionRecordRenderer(renderer,previousRenderer)+sql.slice(splice)
 sql=sql.replace(rendererDeclaration,rendererDeclaration.replace(renderer,previousRenderer))

 const authSlot=" ELSE '{}'::jsonb END)\n   OR actual.proowner<>owner_id"
 const cases=legacy.map(({name,body})=>` WHEN spec->>'name'=${q(name)} THEN jsonb_build_object('prosrc',${q(body)})`).join('\n  ')
 sql=once(sql,authSlot,'\n  '+cases+authSlot)

 const schemaCheck='DO $conversion_assert_source_relations$'
 sql=once(sql,schemaCheck,independentSchema(schema)+'\n'+schemaCheck)
 // The added check casts the reference enum column to text. Map that exact
 // type OID in the check tree just as the predecessor maps composite columns.
 const constraintTail=`'confrelid',pg_temp.${prefix}conversion_map_relation((c).confrelid)) ELSE to_jsonb(c) END`
 sql=once(sql,constraintTail,`'confrelid',pg_temp.${prefix}conversion_map_relation((c).confrelid),
  'conbin',replace((c).conbin::text,
   ':vartype '||to_regtype('${referenceSchema}.native_conversation_conversion_unit_kind')::oid||' ',
   ':vartype '||'public.native_conversation_conversion_unit_kind'::regtype::oid||' ')) ELSE to_jsonb(c) END`)
 const oldRecoveryKey="(SELECT array_agg(a.attname::text ORDER BY k.ordinal) FROM pg_constraint p,unnest(p.conkey) WITH ORDINALITY k(id,ordinal),pg_attribute a WHERE p.conrelid=c.oid AND p.contype='p' AND a.attrelid=c.oid AND a.attnum=k.id)"
 sql=once(sql,oldRecoveryKey,`CASE WHEN c.relname='native_conversation_conversion_pending' THEN ARRAY['workspace_id','kind','id','version']::text[] ELSE ${oldRecoveryKey} END`)
 const triggerReference=`WHERE c.conrelid IN(SELECT oid FROM pg_class WHERE relnamespace='${referenceSchema}'::regnamespace AND relkind='r');`
 sql=once(sql,triggerReference,`WHERE c.conname<>${q(referenceSignature)} AND c.conrelid IN(
  SELECT oid FROM pg_class WHERE relnamespace='${referenceSchema}'::regnamespace AND relkind='r' AND relname<>'conversation_envelopes');
 IF (SELECT jsonb_agg(pg_temp.${prefix}conversion_trigger(t,true) ORDER BY (pg_temp.${prefix}conversion_trigger(t,true)->>'oid')::oid)
  FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint
  WHERE c.connamespace='${referenceSchema}'::regnamespace AND c.conname=${q(referenceSignature)})
 IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint
  WHERE c.connamespace='public'::regnamespace AND c.conname=${q(referenceSignature)})
 THEN RAISE EXCEPTION 'record_conversion_auth_envelope_foreign_key_changed';END IF;`)

 sql=once(sql,'DO $verify_current$',independentDefinitions(schema)+'\nDO $verify_current$')
 const receipt=`SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.${prefix}publication_expected_current)::text`
 sql=once(sql,receipt,independentlyCompareEnvelope()+'\n'+receipt)
 sql=sql.replaceAll(prefix,'a8300_')
 assertAuthenticationReadOnly(sql)
 const cleanup=(source.cleanup+`\nDROP FUNCTION pg_temp.${previousRenderer}(text,jsonb,boolean);`).replaceAll(prefix,'a8300_')
 return {...source,sql,cleanup,sourceDigest:digest,migrationSha:digest,functions:source.functions+conversionRecordSignatures.length}
}

export async function authenticateConversationInstallation(ownerClient,options){
 if(ownerClient?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
 const source=await currentInstallationAuthenticationSource(options)
 await ownerClient.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
 try{
  const result=await ownerClient.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
  if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
   throw Error('installation_authentication_receipt_malformed')
  await ownerClient.query(source.cleanup)
  await ownerClient.query('COMMIT')
  return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
   localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
 }catch(error){await ownerClient.query('ROLLBACK').catch(()=>{});throw error}
}
