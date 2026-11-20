// [COMP:api/conversation-visibility] Read-only attestation for retained graph participation.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource as previousSource,assertAuthenticationReadOnly as previousReadOnly } from './installation-authentication-8307.mjs'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { lineageMediaRenderer,lineageMediaSignature,lineageMigrationName,lineageSectionEnd,lineageSectionStart,reviewedLineageSource } from './build-conversation-record-lineage.mjs'

const prefix='a8307_',successor='a8309_'
const literal=value=>"'"+value.replaceAll("'","''")+"'"
const sha=value=>createHash('sha256').update(value).digest('hex')
const exposed='conversation_record_resource_current'
const roster=['conversation_record_derivative_origin','conversation_record_derivative_edges',
 'conversation_record_retained_native_source','conversation_record_derivation_current',exposed,'require_conversation_record_retention_current',
 'lock_conversation_anchor_policy_change','lock_conversation_member_read']
function once(source,before,after) {
  if(source.split(before).length!==2)throw Error('conversation_lineage_source_changed: '+before.slice(0,75))
  return source.replace(before,()=>after)
}
export const assertAuthenticationReadOnly=sql=>previousReadOnly(sql.replaceAll(successor,prefix))

function catalogProof(declarations) {
  const policies=[...declarations.matchAll(/^CREATE POLICY ([a-z_]+) ON public\.([a-z_]+) AS RESTRICTIVE FOR SELECT TO app_user\n USING\(([^;]+)\);/gm)]
  const triggers=[...declarations.matchAll(/^CREATE TRIGGER ([a-z_]+)\n BEFORE INSERT OR UPDATE OR DELETE ON public\.([a-z_]+)\n FOR EACH ROW EXECUTE FUNCTION public\.lock_conversation_anchor_policy_change\(\);/gm)]
  const checks=[...declarations.matchAll(/^CREATE CONSTRAINT TRIGGER conversation_record_retention_current\n AFTER INSERT ON public\.([a-z_]+) DEFERRABLE INITIALLY DEFERRED FOR EACH ROW\n EXECUTE FUNCTION public\.require_conversation_record_retention_current\(\);/gm)]
  if(policies.length!==3||triggers.length!==4||JSON.stringify(checks.map(([,table])=>table))!==JSON.stringify(['memories','tasks','workspace_files']))
    throw Error('conversation_lineage_catalog_roster_changed')
  return `CREATE TEMP TABLE a8307_lineage_policy(workspace_id uuid,id uuid,scope_version bigint) ON COMMIT DROP;
${policies.map(([,name,,condition])=>`CREATE POLICY ${name} ON pg_temp.a8307_lineage_policy AS RESTRICTIVE FOR SELECT TO app_user USING (${condition});`).join('\n')}
DO $lineage_catalog$
DECLARE item record;actual pg_policy;reviewed pg_policy;relation regclass;
BEGIN
 FOR item IN SELECT * FROM (VALUES ${policies.map(([,name,table])=>`(${literal(table)},${literal(name)})`).join(',')}) q(relation,policy) LOOP
  relation:=to_regclass('public.'||item.relation);
  SELECT * INTO actual FROM pg_policy WHERE polrelid=relation AND polname=item.policy;
  SELECT * INTO STRICT reviewed FROM pg_policy WHERE polrelid='pg_temp.a8307_lineage_policy'::regclass AND polname=item.policy;
  IF actual.oid IS NULL OR NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=relation AND relrowsecurity)
   OR ROW(actual.polpermissive,actual.polcmd,actual.polroles,pg_get_expr(actual.polqual,actual.polrelid),actual.polwithcheck)
   IS DISTINCT FROM ROW(reviewed.polpermissive,reviewed.polcmd,reviewed.polroles,pg_get_expr(reviewed.polqual,reviewed.polrelid),reviewed.polwithcheck)
  THEN RAISE EXCEPTION 'conversation_lineage_policy_changed: %.%',item.relation,item.policy;END IF;
 END LOOP;
 FOR item IN SELECT * FROM (VALUES
  ${[...triggers.map(([,name,table])=>`(${literal(table)},${literal(name)},31,'public.lock_conversation_anchor_policy_change()',false)`),
    ...checks.map(([,table])=>`(${literal(table)},'conversation_record_retention_current',5,'public.require_conversation_record_retention_current()',true)`)].join(',\n  ')}
 ) q(relation,trigger_name,mask,routine,deferred) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.'||item.relation) AND t.tgname=item.trigger_name
   AND t.tgfoid=to_regprocedure(item.routine) AND t.tgtype=item.mask AND t.tgenabled='O' AND NOT t.tgisinternal
   AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred
   AND CASE WHEN item.deferred THEN EXISTS(SELECT 1 FROM pg_constraint c WHERE c.oid=t.tgconstraint
     AND c.conrelid=t.tgrelid AND c.contype='t' AND c.condeferrable AND c.condeferred) ELSE t.tgconstraint=0 END
   AND t.tgnargs=0 AND t.tgattr=''::int2vector AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)
  THEN RAISE EXCEPTION 'conversation_lineage_trigger_changed: %.%',item.relation,item.trigger_name;END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam
  WHERE i.indexrelid=to_regclass('public.workspace_files_conversation_record_predecessor')
   AND i.indrelid='public.workspace_files'::regclass AND a.amname='btree'
   AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisunique AND i.indnatts=2 AND i.indnkeyatts=2
   AND i.indexprs IS NULL AND pg_get_expr(i.indpred,i.indrelid)='(superseded_by IS NOT NULL)'
   AND (SELECT array_agg(attname::text ORDER BY keys.position) FROM unnest(i.indkey) WITH ORDINALITY keys(number,position)
        JOIN pg_attribute x ON x.attrelid=i.indrelid AND x.attnum=keys.number)=ARRAY['workspace_id','superseded_by'])
 THEN RAISE EXCEPTION 'conversation_lineage_predecessor_index_changed';END IF;
END $lineage_catalog$;`
}

export async function lineageInstallationSource(migration,options) {
  const [previous,lineage]=await Promise.all([previousSource(options),reviewedLineageSource()])
  if(migration.split(lineageSectionStart).length!==2||migration.split(lineageSectionEnd).length!==2
    ||!migration.includes(lineageSectionStart+lineage+lineageSectionEnd))throw Error('conversation_lineage_declaration_changed')
  const named=[...lineage.matchAll(/^CREATE FUNCTION public\.([a-z_]+)\(/gm)].map(match=>match[1])
  if(JSON.stringify(named)!==JSON.stringify(roster)
    ||lineage.split('GRANT EXECUTE ON FUNCTION public.'+exposed+'(uuid,text,uuid,text) TO app_user;').length!==2
    ||[...lineage.matchAll(/^GRANT /gm)].length!==1)throw Error('conversation_lineage_function_roster_changed')
  const functions=roster.map((name,index)=>({name,reference:prefix+'lineage_ref_'+index,exposed:name===exposed}))
  const references=functions.map(({name,reference})=>receivingOwnerDeclaration(lineage,name)
    .replace('CREATE FUNCTION public.'+name,'CREATE FUNCTION pg_temp.'+reference)).join('\n')
  const proof=`${references}
CREATE TEMP TABLE a8307_lineage_oids(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $lineage_source$
DECLARE item record;actual pg_proc;reviewed pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 app_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 FOR item IN SELECT * FROM (VALUES ${functions.map(({name,reference,exposed})=>`(${literal(name)},${literal(reference)},${exposed})`).join(',')}) q(name,reference,exposed) LOOP
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=item.reference;
  SELECT * INTO actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=item.name AND proargtypes=reviewed.proargtypes;
  IF actual.oid IS NULL OR actual.proowner<>owner_id OR actual.proacl IS DISTINCT FROM
    (CASE WHEN item.exposed THEN ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
     ELSE ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)] END)
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
    (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
  THEN RAISE EXCEPTION 'conversation_lineage_function_changed: %',item.name;END IF;
  INSERT INTO pg_temp.a8307_lineage_oids VALUES(actual.oid);
 END LOOP;
END $lineage_source$;
${catalogProof(lineage)}`
  const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8307_publication_expected_current)::text'
  const renderer=prefix+'conversion_source_body'
  const predecessorRenderer=prefix+'record_lineage_predecessor_body'
  const declaration=`CREATE FUNCTION pg_temp.${renderer}(signature text,parts jsonb,successor boolean)`
  const marker='END $record_floor_renderer$;'
  let sql=once(previous.sql,declaration,declaration.replace(renderer,predecessorRenderer))
  sql=once(sql,marker,marker+'\n'+lineageMediaRenderer(renderer,predecessorRenderer))
  const bodyCheck="(expected->>'signature') NOT IN("
  sql=once(sql,bodyCheck,bodyCheck+literal(lineageMediaSignature)+',')
  sql=once(sql,receipt,proof+'\n'+receipt)
  const begin=sql.indexOf(receipt)
  sql=sql.slice(0,begin)+once(sql.slice(begin),"),'UTF8')),'hex') local_digest,",`)||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE "C")
   FROM pg_proc p JOIN pg_temp.a8307_lineage_oids r USING(oid))::text,'UTF8')),'hex') local_digest,`)
  sql=once(sql,')::int functions,','+'+functions.length+')::int functions,').replaceAll(prefix,successor)
  assertAuthenticationReadOnly(sql)
  const cleanup=(previous.cleanup+`\nDROP FUNCTION pg_temp.${predecessorRenderer}(text,jsonb,boolean);
 DO $lineage_ref_cleanup$ DECLARE f record;BEGIN
  FOR f IN SELECT p.oid::regprocedure identity FROM pg_proc p WHERE p.pronamespace=pg_my_temp_schema()
   AND p.proname=ANY(ARRAY[${functions.map(({reference})=>literal(reference)).join(',')}])
  LOOP EXECUTE 'DROP FUNCTION '||f.identity;END LOOP;
 END $lineage_ref_cleanup$;`).replaceAll(prefix,successor)
  return {...previous,sql,cleanup,functions:previous.functions+functions.length,sourceDigest:sha(migration),migrationSha:sha(migration)}
}

export async function currentInstallationAuthenticationSource({sourceRoot=fileURLToPath(new URL('../../',import.meta.url))}={}) {
  const migration=await readFile(sourceRoot.replace(/\/$/,'')+'/migrations/'+lineageMigrationName,'utf8')
  if(sha(migration)!=='c81d6dd7992215e0e009951d81a4606ec6fdf879d60314a3173b5848a09a7264')throw Error('installation_source_migration_changed')
  return lineageInstallationSource(migration,{sourceRoot})
}

export async function authenticateConversationInstallation(client,options) {
  if(client?.getTransactionStatus?.()!=='I')throw Error('installation_authentication_requires_idle_owner')
  const source=await currentInstallationAuthenticationSource(options)
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
  try {
    const result=await client.query(source.sql),row=(Array.isArray(result)?result.at(-1):result)?.rows?.[0]
    if(!row||row.functions!==source.functions||!/^[a-f0-9]{64}$/.test(row.local_digest)||typeof row.witness_current!=='boolean')
      throw Error('installation_authentication_receipt_malformed')
    await client.query(source.cleanup)
    await client.query('COMMIT')
    return Object.freeze({format:1,sourceDefinitionDigest:source.sourceDigest,functions:row.functions,
      localContractDigest:row.local_digest,witnessCurrent:row.witness_current})
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{})
    throw error
  }
}
