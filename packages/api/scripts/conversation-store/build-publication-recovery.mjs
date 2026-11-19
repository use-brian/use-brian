// [COMP:api/native-turn-frame] Authenticated forward durable-publication slice.
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {reviewedSourceOrdering} from './publication-recovery-source-order.mjs'
const require=createRequire(import.meta.url),{tsImport}=require('tsx/esm/api')
const {sessionKindSql}=await tsImport('../../src/session-kind.ts',import.meta.url)
const directory=new URL('./',import.meta.url),target=new URL('../../migrations/8272_durable_conversation_publications.sql',import.meta.url)
const sha=value=>createHash('sha256').update(value).digest('hex'),lit=value=>`'${value.replaceAll("'","''")}'`,arr=values=>`ARRAY[${values.map(lit).join(',')}]::text[]`
const validationIndex=process.argv.indexOf('--validate-manifest')
if(validationIndex!==-1&&(validationIndex!==2||process.argv.length!==4))throw new Error('Publication manifest validation requires one explicit path')
const manifest=JSON.parse(await readFile(validationIndex===-1?new URL('publication-recovery-predecessors.json',directory):process.argv[validationIndex+1],'utf8'))
if(manifest.format!==2)throw new Error('Publication predecessor requires explicit slot format')
const reviewedNames=new Set(manifest.contracts.map(c=>c.signature))
// Unknown persistent callers are refused across user namespaces. Compiler refs
// in temporary schemas and PostgreSQL-owned system namespaces are not owners.
const persistentCaller="c.pronamespace<>pg_my_temp_schema() AND NOT pg_is_other_temp_schema(c.pronamespace) AND EXISTS(SELECT 1 FROM pg_namespace caller_namespace WHERE caller_namespace.oid=c.pronamespace AND caller_namespace.nspname NOT IN('pg_catalog','information_schema') AND caller_namespace.nspname!~'^pg_toast')"
const predecessorFingerprints=manifest.predecessorFingerprints
if(!predecessorFingerprints||Object.keys(predecessorFingerprints).length!==reviewedNames.size
 ||Object.entries(predecessorFingerprints).some(([identity,value])=>!reviewedNames.has(identity)||!/^([a-f0-9]{64})$/.test(value)))throw new Error('publication_fingerprint_inventory_changed')
const knownFingerprints=new Set(Object.values(predecessorFingerprints))
// Only these source-created helpers can carry the historical per-schema grant.
// The six PUBLIC helpers keep PUBLIC; the two private helpers become owner-only.
const inheritedAclBindings=[
 ['crm_install_erasure_capture()',['522_crm_erasure_journal.sql','8271_refresh_recovery_capture.sql'],false],
 ['file_session_binding_allows(uuid)',['637_file_publication_bindings.sql'],true],
 ['media_parent_visible(text,uuid)',['643_recording_segment_publication.sql'],true],
 ['office_output_file_allows(uuid,boolean)',['639_office_generation_publication.sql'],true],
 ['pdf_intake_file_visible(uuid)',['638_pdf_intake_publication.sql'],true],
 ['project_labels_allowed(jsonb,uuid,text[],boolean)',['749_project_shared_spaces.sql'],true],
 ['read_session_authority_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean)',['8269_canonical_conversation_publication.sql'],false],
 ['recording_transcript_file_allows(uuid)',['643_recording_segment_publication.sql'],true],
]
for(const file of new Set(['81110_legacy_function_execute_privileges.sql',...inheritedAclBindings.flatMap(([,files])=>files)])){
 if(!Object.hasOwn(manifest.source,file)||!/^[a-f0-9]{64}$/.test(manifest.source[file]))throw new Error('publication_inherited_acl_source_changed: '+file)
}
const inheritedAclProfile={format:1,schema:'public',runtime:'app_user',
 defaultHistory:{file:'81110_legacy_function_execute_privileges.sql',sha256:manifest.source['81110_legacy_function_execute_privileges.sql']},
 functions:inheritedAclBindings.map(([signature,files,publicExecute])=>({signature,publicExecute,
  source:files.map(file=>({file,sha256:manifest.source[file]}))}))}
if(JSON.stringify(manifest.inheritedFunctionExecute)!==JSON.stringify(inheritedAclProfile))throw new Error('publication_inherited_acl_profile_changed')
const retainedGuardRoster=['native_retained_helpers_current()','native_turn_privacy_edges(uuid,jsonb)']
const retainedGuardSourceFiles=['8267_retained_native_graph.sql','8269_canonical_conversation_publication.sql']
const retainedGuardSources=[]
for(const file of retainedGuardSourceFiles){
 if(!Object.hasOwn(manifest.source,file)||!/^[a-f0-9]{64}$/.test(manifest.source[file]))throw new Error('publication_retained_guard_source_changed')
 const source=await readFile(new URL('../../migrations/'+file,directory),'utf8')
 if(sha(source)!==manifest.source[file])throw new Error('publication_retained_guard_source_changed')
 retainedGuardSources.push(source)
}
const retainedGuardHeader='CREATE FUNCTION native_retained_helpers_current() RETURNS boolean\nLANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $guard$'
if(retainedGuardSources[0].split(retainedGuardHeader).length!==2)throw new Error('publication_retained_guard_declaration_changed')
let retainedGuardBody=retainedGuardSources[0].split(retainedGuardHeader)[1].split('$guard$;')[0]
const retainedBefore=[...retainedGuardBody.matchAll(/AND array_agg\(h.signature ORDER BY h.signature\)=(ARRAY\[[\s\S]*?\])::text\[\]/g)]
const retainedRetired=[...retainedGuardSources[1].matchAll(/DELETE FROM native_retained_contract_helpers h WHERE h.signature=ANY\((ARRAY\[[\s\S]*?\]::text\[\])\);/g)]
if(retainedBefore.length!==1||retainedRetired.length!==1)throw new Error('publication_retained_guard_retirement_changed')
const sourceSignatures=text=>[...text.matchAll(/'((?:[^']|'')*)'/g)].map(match=>match[1].replaceAll("''","'"))
const retiredSet=new Set(sourceSignatures(retainedRetired[0][1])),surviving=sourceSignatures(retainedBefore[0][1]).filter(signature=>!retiredSet.has(signature))
if(JSON.stringify(surviving)!==JSON.stringify(retainedGuardRoster))throw new Error('publication_retained_guard_roster_changed')
retainedGuardBody=retainedGuardBody.replace(retainedBefore[0][1],arr(retainedGuardRoster).replace(/::text\[\]$/,''))
const retainedGuardProfile={format:1,signature:retainedGuardRoster[0],bodySha256:'c032b4d9689c152b8352f79ff1e214cc71aa040af9265b4b87612ccd41015050',
 roster:retainedGuardRoster,source:retainedGuardSourceFiles.map(file=>({file,sha256:manifest.source[file]}))}
if(sha(retainedGuardBody)!==retainedGuardProfile.bodySha256||JSON.stringify(manifest.retainedGuard)!==JSON.stringify(retainedGuardProfile))throw new Error('publication_retained_guard_profile_changed')
for(const [signature,,publicExecute] of inheritedAclBindings){
 const expected=[{grantee:'OWNER',grantor:'OWNER',privilege:'EXECUTE',grantable:false},
  ...(publicExecute?[{grantee:'PUBLIC',grantor:'OWNER',privilege:'EXECUTE',grantable:false}]:[])]
 if(JSON.stringify(manifest.contracts.find(c=>c.signature===signature)?.acl)!==JSON.stringify(expected))throw new Error('publication_inherited_acl_canonical_changed: '+signature)
}
// These are the complete reviewed defaults, not a parser/normalizer for target
// pg_node_tree text. Datum width belongs to the compiling PostgreSQL profile.
const defaultNodes={
 booleanFalse:'{CONST :consttype 16 :consttypmod -1 :constcollid 0 :constlen 1 :constbyval true :constisnull false :location -1 :constvalue 1 [ 0 0 0 0 0 0 0 0 ]}',
 integerZero:'{CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 :constbyval true :constisnull false :location -1 :constvalue 4 [ 0 0 0 0 0 0 0 0 ]}',
 jsonbNull:'{CONST :consttype 3802 :consttypmod -1 :constcollid 0 :constlen -1 :constbyval false :constisnull true :location -1 :constvalue <>}',
 uuidNull:'{CONST :consttype 2950 :consttypmod -1 :constcollid 0 :constlen 16 :constbyval false :constisnull true :location -1 :constvalue <>}',
}
const defaultProfiles={
 boolean_false:{types:['boolean'],declaration:'d0 pg_catalog.bool DEFAULT false',nodes:['booleanFalse']},
 boolean_false_jsonb_null:{types:['boolean','jsonb'],declaration:'d0 pg_catalog.bool DEFAULT false,d1 pg_catalog.jsonb DEFAULT NULL::pg_catalog.jsonb',nodes:['booleanFalse','jsonbNull']},
 integer_zero:{types:['integer'],declaration:'d0 pg_catalog.int4 DEFAULT 0',nodes:['integerZero']},
 integer_zero_jsonb_null:{types:['integer','jsonb'],declaration:'d0 pg_catalog.int4 DEFAULT 0,d1 pg_catalog.jsonb DEFAULT NULL::pg_catalog.jsonb',nodes:['integerZero','jsonbNull']},
 jsonb_null_jsonb_null:{types:['jsonb','jsonb'],declaration:'d0 pg_catalog.jsonb DEFAULT NULL::pg_catalog.jsonb,d1 pg_catalog.jsonb DEFAULT NULL::pg_catalog.jsonb',nodes:['jsonbNull','jsonbNull']},
 uuid_null:{types:['uuid'],declaration:'d0 pg_catalog.uuid DEFAULT NULL::pg_catalog.uuid',nodes:['uuidNull']},
}
const defaultBindings={
 'application_canonical_ancestry_allowed(uuid,text,uuid,text,boolean)':'boolean_false',
 'application_canonical_ancestry_from_admitted_root(uuid,text,uuid,text,boolean,jsonb)':'boolean_false_jsonb_null',
 'application_compute_field_envelope(uuid,jsonb,text,uuid,text,text,text[],integer)':'integer_zero',
 'application_compute_field_envelope_before_module_policy(uuid,jsonb,text,uuid,text,text,text[],integer)':'integer_zero',
 'application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)':'integer_zero',
 'application_compute_field_envelope_before_session_eval(uuid,jsonb,text,uuid,text,text,text[],integer)':'integer_zero',
 'application_materialize_field_envelope(uuid,jsonb,integer)':'integer_zero',
 'application_memory_statement_envelope(uuid,jsonb,text,uuid,text,text,text[],integer,jsonb)':'integer_zero_jsonb_null',
 'capture_conversation_evidence(uuid,jsonb,jsonb,jsonb)':'jsonb_null_jsonb_null',
 'member_operation_grants(boolean,uuid)':'uuid_null',
 'member_operation_scope_allows(uuid,text,text[],boolean)':'boolean_false',
 'member_principal_operation_grants(uuid,boolean,uuid)':'uuid_null',
 'read_native_file_worklist_evidence(uuid,text[],uuid[],text[],boolean,boolean)':'boolean_false',
}
const jsonSlot=(kind,identity)=>({$slot:{kind,identity,encoding:'string'}})
const historicalOrder=[
 ['application_scope_source_edges(uuid,text,uuid,text)','plpgsql','54684274a61b863d1c0861cab50af94a8c5a57d2a160477ca3ec6db06b6ed4ee'],
 ['application_scope_source_edges_before_knowledge_versions(uuid,text,uuid,text)','sql','7fca1bdb8cfc547aa35d5b337cc15507c648e3a8a750f24a57291f04a6ce3af9'],
 ['knowledge_version_source_edges(uuid,text,uuid,text)','plpgsql','3ee5491357378e78020090b1b69c0b734f7659b8402e23099f26e9b4a3da365d'],
 ['scope_source_ancestors(uuid,text,uuid)','plpgsql','af5f79f9df62e62e21861e1a91e5556c8ee9b95642bb18265d4ae4d737615df8'],
 ['scope_source_ancestors_before_workflow_run(uuid,text,uuid)','plpgsql','77d87af6e50b69e1caab38de7189b1984d240ec6fa9bc3a32c449c4f2480ba53'],
 ['scope_source_ancestors_before_browser_session(uuid,text,uuid)','plpgsql','2220d1102cc8fc3b905c59439a1f1cc447a2693307f844005ea143ac3b51978c'],
 ['scope_source_ancestors_before_browser_profile(uuid,text,uuid)','plpgsql','b519deb046431ded25a403da7e828675631c8c265a5ab72ec07b6f82ff963ec8'],
 ['scope_source_table(text)','sql','fe4abe363e9e7632e6b66e2ea13fa15a53b07ed1400c65572b52104862fd7d36'],
 ['scope_source_table_before_knowledge_versions(text)','sql','58f438f9becce29fa4620fa688831387a02ef29212acdf5bea707b2e559da6fd'],
 ['scope_source_table_before_persistent_context(text)','sql','1487c14ce340612b7464428092c594e3562abb411e9bae6c3d03617b50ce3bc8'],
 ['scope_source_table_before_media(text)','sql','08772cc3ed6d5e772083551e93f6392790b8e573dd0e3c4167533a55444f7e5b'],
 ['application_native_source_edges_dispatch(uuid,text,uuid,text)','plpgsql','1ebd222402966ab6f5c3b6e291c632056d36ab989405be70c13aaffa78bdb42c'],
]
// PostgreSQL's source-profile jsonb text, used only to verify frozen native
// provenance at build time. Runtime hashes are compiled by PostgreSQL itself.
const jsonbText=value=>Array.isArray(value)?'['+value.map(jsonbText).join(', ')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort((a,b)=>Buffer.byteLength(a)-Buffer.byteLength(b)||Buffer.compare(Buffer.from(a),Buffer.from(b))).map(key=>JSON.stringify(key)+': '+jsonbText(value[key])).join(', ')+'}':JSON.stringify(value)
const historical=manifest.historicalProjections
if(!historical||historical.profiles?.length!==historicalOrder.length||!historical.source)throw new Error('publication_historical_profile_roster_changed')
for(const [index,[identity,language,fingerprint]] of historicalOrder.entries()){
 const profile=historical.profiles[index],projection=profile?.projection,native=profile?.nativeProvenance
 if(profile?.signature!==identity||!reviewedNames.has(identity)||!projection
  ||JSON.stringify(projection.namespace)!==JSON.stringify(jsonSlot('namespace','public'))
  ||JSON.stringify(projection.language)!==JSON.stringify(jsonSlot('language',language))
  ||projection.name!==identity.split('(')[0]||sha(projection.body)!==profile.bodySha256
  ||native?.namespaceOid!=='2200'||native?.languageOid!==(language==='sql'?'14':'14053')||native?.fingerprint!==fingerprint
  ||sha(jsonbText({...projection,namespace:native.namespaceOid,language:native.languageOid}))!==fingerprint)throw new Error('publication_historical_profile_changed: '+identity)
 for(const ref of [...(profile.bodySources??[]),profile.authenticatedMetadataAt]){
  const name=ref?.file?.replace(/^use-brian\/packages\/api\/migrations\//,'')
  if(!name||!historical.source[ref.file]||historical.source[ref.file]!==manifest.source[name]||!Number.isInteger(ref.line)||ref.line<1)throw new Error('publication_historical_source_changed: '+identity)
 }
}
if(Object.entries(historical.source).some(([path,digest])=>manifest.source[path.replace(/^use-brian\/packages\/api\/migrations\//,'')]!==digest))throw new Error('publication_historical_source_changed')
const catalogExpressionBindings={
 'public.native_turn_publication_work.completion_ready':['table_default_false','433b6d9b0ef55ee622f3f640d6eb7233d89838de3d01e48e60ea0e5bbbb10739'],
 'public.native_turn_publication_events.fired':['table_default_false','433b6d9b0ef55ee622f3f640d6eb7233d89838de3d01e48e60ea0e5bbbb10739'],
 'public.native_turn_publication_impossible.native_turn_publication_impossible_check':['table_check_false','433b6d9b0ef55ee622f3f640d6eb7233d89838de3d01e48e60ea0e5bbbb10739'],
 'public.native_turn_frames.native_turn_frames_format_check':['table_check_format','aed41234198d11936f0aa29ffbc949b71416e39d406f8a2321a52bdd91859053'],
 'public.native_turn_frames.native_turn_frames_manifest_digest_check':['table_check_digest','d3ab13630b88ff3e04030be3a38395bc59255678d4e7f93b3ed710a5008d076a'],
}
if(!manifest.catalogExpressions||Object.keys(manifest.catalogExpressions).sort().join('|')!==Object.keys(catalogExpressionBindings).sort().join('|'))throw new Error('publication_catalog_expression_roster_changed')
for(const [identity,[profile,nativeSha]] of Object.entries(catalogExpressionBindings)){
 const declared=manifest.catalogExpressions[identity]
 if(declared?.profile!==profile||sha(declared.nativeAst)!==nativeSha)throw new Error('publication_catalog_expression_changed: '+identity)
}
const catalog=(signature,index)=>manifest.contracts.find(c=>c.signature===signature)?.bodyParts[index]?.slot?.template
const helperCatalog=catalog('native_turn_helpers_current()',3),publicationCatalog=catalog('native_turn_publication_contract()',1)
const expectedRelations=['public.scope_derivations','public.scope_derivation_sources'].map(identity=>[jsonSlot('relation',identity),jsonSlot('owner','OWNER'),{$slot:{kind:'relationDefaultAcl',identity,encoding:'json'}},'r',true,false])
if(JSON.stringify(helperCatalog?.relations)!==JSON.stringify(expectedRelations))throw new Error('publication_relation_tuple_changed')
for(const [index,[identity,position]] of [['public.native_turn_publication_work.completion_ready',8],['public.native_turn_publication_events.fired',4]].entries()){
 const definition=publicationCatalog?.defaults?.[index],relation=identity.slice(0,identity.lastIndexOf('.'))
 if(!definition||definition.adnum!==position||JSON.stringify(definition.adrelid)!==JSON.stringify(jsonSlot('relation',relation))
  ||JSON.stringify(definition.oid)!==JSON.stringify(jsonSlot('columnDefaultOid',identity))
  ||JSON.stringify(definition.adbin)!==JSON.stringify(jsonSlot('catalogExpression','table_default_false')))throw new Error('publication_column_default_binding_changed: '+identity)
}
for(const [identity,[profile]] of Object.entries(catalogExpressionBindings).filter(([identity])=>identity.includes('_check'))){
 const name=identity.slice(identity.lastIndexOf('.')+1),relation=identity.slice(0,identity.lastIndexOf('.')),constraints=publicationCatalog?.constraints?.filter(c=>c.conname===name)
 const constraint=constraints?.[0],position=profile==='table_check_format'?4:profile==='table_check_digest'?5:null
 if(constraints?.length!==1||JSON.stringify(constraint.conrelid)!==JSON.stringify(jsonSlot('relation',relation))
  ||JSON.stringify(constraint.conbin)!==JSON.stringify(jsonSlot('catalogExpression',profile))
  ||JSON.stringify(constraint.conkey)!==JSON.stringify(position===null?null:[position]))throw new Error('publication_constraint_expression_binding_changed: '+identity)
}
for(const [position,name,type] of [[4,'format','23'],[5,'manifest_digest','25']]){
 const columns=publicationCatalog?.columns?.filter(c=>JSON.stringify(c[0])===JSON.stringify(jsonSlot('relation','public.native_turn_frames'))&&c[1]===position)
 if(columns?.length!==1||columns[0][2]!==name||columns[0][3]!==type)throw new Error('publication_expression_attribute_changed')
}
if(!manifest.argumentDefaults||Object.keys(manifest.argumentDefaults).sort().join('|')!==Object.keys(defaultBindings).sort().join('|'))throw new Error('publication_default_profile_roster_changed')
for(const contract of manifest.contracts){
 const profileId=defaultBindings[contract.signature],defaultSlot=contract.metadata.proargdefaults,provenance=manifest.argumentDefaults[contract.signature]
 if(profileId){
  const profile=defaultProfiles[profileId],types=contract.signature.slice(contract.signature.indexOf('(')+1,-1).split(','),oids={boolean:'16',integer:'23',jsonb:'3802',uuid:'2950'}
  if(JSON.stringify(defaultSlot)!==JSON.stringify({$slot:{kind:'argumentDefaults',identity:profileId,encoding:'string'}})
   ||JSON.stringify(provenance)!==JSON.stringify({profile:profileId,nativeAst:'('+profile.nodes.map(node=>defaultNodes[node]).join(' ')+')'}))throw new Error('publication_default_profile_changed: '+contract.signature)
  if(contract.metadata.pronargdefaults!==profile.types.length||contract.metadata.pronargs!==types.length
   ||JSON.stringify(types.slice(-profile.types.length))!==JSON.stringify(profile.types)
   ||JSON.stringify(contract.metadata.proargtypes.slice(-profile.types.length))!==JSON.stringify(profile.types.map(type=>oids[type])))throw new Error('publication_default_argument_binding_changed: '+contract.signature)
 }else if(defaultSlot!==null||contract.metadata.pronargdefaults!==0)throw new Error('publication_unreviewed_default_profile: '+contract.signature)
 const references={},historicalReferences={},frozen={}
 for(const [index,part] of contract.bodyParts.entries()){
  if(typeof part==='string'){
   for(const match of part.matchAll(/'([a-f0-9]{64})'/g)){
    if(knownFingerprints.has(match[1]))throw new Error('publication_unrepresented_fingerprint: '+contract.signature)
    frozen[match[1]]=(frozen[match[1]]??0)+1
   }
   continue
  }
  if(!part||Object.keys(part).join(',')!=='slot')throw new Error('Unknown body template part')
  const slot=part.slot,before=contract.bodyParts[index-1],after=contract.bodyParts[index+1]
  if(typeof before!=='string'||typeof after!=='string')throw new Error('Ambiguous adjacent body slots')
  if(slot.kind==='fingerprint'){
   if(!reviewedNames.has(slot.identity)||!before.endsWith("'")||!after.startsWith("'"))throw new Error('Unreviewed executable pin slot')
   const contexts=references[slot.identity]??=[]
   contexts.push({partIndex:index,beforeSha256:sha(before),afterSha256:sha(after)})
  }else if(slot.kind==='historicalProjection'){
   const functionSlot=contract.bodyParts[index-2]?.slot
   if(contract.signature!=='application_scope_lineage(uuid,text[],uuid[],text[])'||functionSlot?.kind!=='function'||functionSlot.identity!==slot.identity
    ||before!=="::oid,'"||!after.startsWith("'::text)")||!historicalOrder.some(([identity])=>identity===slot.identity))throw new Error('publication_historical_slot_changed')
   historicalReferences[slot.identity]=[...(historicalReferences[slot.identity]??[]),{partIndex:index,beforeSha256:sha(before),afterSha256:sha(after)}]
  }else if(slot.kind==='function'){
   if(!reviewedNames.has(slot.identity)||!after.startsWith('::oid'))throw new Error('Unreviewed function OID slot')
  }else if(slot.kind==='catalogLiteral'){
   if(!['native_turn_helpers_current()','native_turn_publication_contract()'].includes(contract.signature)
    ||!/(?:IS NOT DISTINCT FROM|IS DISTINCT FROM) $/.test(before)||!after.startsWith('::jsonb'))throw new Error('Unreviewed catalog literal slot')
  }else throw new Error('Unknown body slot kind')
 }
 const ordered=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))))
 const review=contract.hashLiteralReview
 if(!review||Object.keys(review).sort().join(',')!=='fingerprints,frozen,historical'
  ||ordered(references)!==ordered(review.fingerprints)||ordered(frozen)!==ordered(review.frozen)||ordered(historicalReferences)!==ordered(review.historical))throw new Error('publication_hash_literal_review_changed: '+contract.signature)
 if(contract.signature==='application_scope_lineage(uuid,text[],uuid[],text[])'&&JSON.stringify(Object.keys(historicalReferences))!==JSON.stringify(historicalOrder.map(([identity])=>identity)))throw new Error('publication_historical_slot_roster_changed')
}
const specialCatalogSlots={}
const permitCatalog=(path,kind,identity)=>{specialCatalogSlots[path]={kind,identity}}
for(const [index,identity] of ['public.scope_derivations','public.scope_derivation_sources'].entries())permitCatalog('native_turn_helpers_current()/3/relations/'+index+'/2','relationDefaultAcl',identity)
for(const [index,identity] of ['public.native_turn_publication_work.completion_ready','public.native_turn_publication_events.fired'].entries()){
 permitCatalog('native_turn_publication_contract()/1/defaults/'+index+'/oid','columnDefaultOid',identity)
 permitCatalog('native_turn_publication_contract()/1/defaults/'+index+'/adbin','catalogExpression','table_default_false')
}
for(const [identity,[profile]] of Object.entries(catalogExpressionBindings).filter(([identity])=>identity.includes('_check'))){
 const name=identity.slice(identity.lastIndexOf('.')+1),index=publicationCatalog.constraints.findIndex(c=>c.conname===name)
 permitCatalog('native_turn_publication_contract()/1/constraints/'+index+'/conbin','catalogExpression',profile)
}
const constraintNamespaces=[
 ['native_turn_helpers_current()/3/constraint',helperCatalog.constraint],
 ...publicationCatalog.constraints.map((constraint,index)=>['native_turn_publication_contract()/1/constraints/'+index,constraint]),
]
if(constraintNamespaces.length!==38)throw new Error('publication_constraint_namespace_roster_changed')
for(const [path,constraint] of constraintNamespaces){
 const relation=constraint.conrelid?.$slot
 if(relation?.kind!=='relation'||!relation.identity.startsWith('public.')||typeof constraint.conname!=='string')throw new Error('publication_constraint_namespace_binding_changed')
 const identity=relation.identity+'.'+constraint.conname,expected={$slot:{kind:'constraintNamespace',identity,encoding:'string'}}
 if(JSON.stringify(constraint.connamespace)!==JSON.stringify(expected))throw new Error('publication_constraint_namespace_binding_changed')
 permitCatalog(path+'/connamespace','constraintNamespace',identity)
}
const observedCatalogSlots={}
function inspectCatalog(value,path){
 if(Array.isArray(value)){for(const [index,item] of value.entries())inspectCatalog(item,path+'/'+index);return}
 if(!value||typeof value!=='object')return
 if(value.$slot){
  const {kind,identity}=value.$slot
  if(!['owner','namespace','language','function','fingerprint','relation','type','constraint','constraintNamespace','trigger','constraintTriggerOid','constraintTriggerName','ownerAcl','relationDefaultAcl','columnDefaultOid','catalogExpression','historicalProjection','argumentDefaults'].includes(kind))throw new Error('publication_unknown_catalog_slot')
  if(['relationDefaultAcl','columnDefaultOid','catalogExpression','historicalProjection','argumentDefaults','constraintNamespace'].includes(kind))observedCatalogSlots[path]={kind,identity}
  return
 }
 for(const [key,item] of Object.entries(value))inspectCatalog(item,path+'/'+key)
}
for(const contract of manifest.contracts)for(const [index,part] of contract.bodyParts.entries())if(part?.slot?.kind==='catalogLiteral')inspectCatalog(part.slot.template,contract.signature+'/'+index)
const orderCatalog=value=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))))
if(orderCatalog(observedCatalogSlots)!==orderCatalog(specialCatalogSlots))throw new Error('publication_catalog_slot_locations_changed')
const sourceOrdering=reviewedSourceOrdering(manifest,retainedGuardSources[1])
if(validationIndex!==-1){console.log('Publication manifest explicit pin contexts match');process.exit(0)}
for(const [name,digest] of Object.entries(manifest.source))if(sha(await readFile(new URL('../../migrations/'+name,directory)))!==digest)throw new Error('Publication predecessor source changed: '+name)
const once=(source,before,after)=>{if(source.split(before).length!==2)throw new Error('Publication predecessor shape changed: '+before.slice(0,90));return source.replace(before,()=>after)}
const oldMessages=await readFile(new URL('messages.sql',directory),'utf8'),oldCompletion=await readFile(new URL('completion.sql',directory),'utf8')
let messages=once(oldMessages,'target jsonb)','target jsonb,operation jsonb)')
messages=once(messages,'next_sequence integer;results jsonb;annotation_result jsonb;','next_sequence integer;results jsonb;annotation_result jsonb;registration jsonb;original_command jsonb:=jsonb_build_object(\'payloads\',payloads,\'producer\',producer,\'sources\',sources,\'target\',target);')
messages=once(messages," IF envelope THEN",` IF operation IS NOT NULL THEN
  registration:=native_conversation_publication_enter(w,s,operation,original_command);
  IF registration->>'duplicate'='true' THEN RETURN registration->'value';END IF;
 END IF;
 IF envelope THEN`)
messages=once(messages,' INSERT INTO native_turn_publication_work(',` IF operation IS NOT NULL THEN SET CONSTRAINTS native_turn_publication_operation DEFERRED;END IF;
 INSERT INTO native_turn_publication_work(`)
messages=once(messages,'prepared,completion_owner)','prepared,completion_owner,publication_id)')
messages=messages.replaceAll("CASE WHEN compound THEN leader END WHERE", "CASE WHEN compound THEN leader END,(operation->>'operationId')::uuid WHERE")
const registration=` ), registration AS (
  INSERT INTO native_conversation_publications(id,workspace_id,session_id,input_message_id,actor_user_id,assistant_id,turn_token,slot,
   command_format,command_digest,stopped,frame_ids,leader_frame_id,expected_output_count,annotation_user_id,annotation_assistant_id,requested_stopped,terminal_descriptor,terminal_outputs)
  SELECT (operation->>'operationId')::uuid,w,s,(operation->>'inputMessageId')::uuid,(operation->>'actorUserId')::uuid,(operation->>'assistantId')::uuid,
   (operation->>'turnToken')::uuid,'buffered_transcript',(operation->>'version')::integer,registration->>'digest',(registration->>'effectiveStopped')::boolean,
   ARRAY(SELECT frame FROM unnest(ARRAY[CASE WHEN annotation_command IS NOT NULL THEN a_frame END,CASE WHEN jsonb_array_length(payloads)>0 THEN t_frame END]) frame WHERE frame IS NOT NULL ORDER BY frame),
   leader,jsonb_array_length(payloads)+CASE WHEN annotation_command IS NOT NULL THEN 1 ELSE 0 END,session_row.user_id,session_row.assistant_id,
   CASE WHEN operation->'version'='2'::jsonb THEN (operation->>'stopped')::boolean END,
   CASE WHEN operation->'version'='2'::jsonb AND registration->>'effectiveStopped'='false' THEN nullif(operation->'terminalCandidate','null'::jsonb) END,
   CASE WHEN operation->'version'='2'::jsonb AND registration->>'effectiveStopped'='false' AND nullif(operation->'terminalCandidate','null'::jsonb) IS NOT NULL THEN
    (SELECT jsonb_agg(jsonb_build_object('origin',m.n->'origin','revision',m.n->'revision','commandOrdinal',m.n->'commandOrdinal',
      'kind','session_message','version','1','id',written.id,'frameId',t_frame,'derivationId',d.id,'sequence',written.sequence_num,
      'payloadDigest',o.value->'payloadDigest') ORDER BY m.ordinal)
     FROM jsonb_array_elements(operation#>'{terminalCandidate,members}') WITH ORDINALITY m(n,ordinal)
     JOIN t_written written ON written.sequence_num=next_sequence+(m.n->>'commandOrdinal')::integer+1
     JOIN t_declarations d ON d.resource_id=written.id JOIN output_rows o ON o.frame_id=t_frame AND o.value->>'id'=written.id::text) END
  FROM seal CROSS JOIN(SELECT count(*) FROM debt) ready WHERE operation IS NOT NULL RETURNING id
 ) SELECT`
messages=once(messages,' ) SELECT\n  (SELECT coalesce(jsonb_agg',registration+'\n  (SELECT coalesce(jsonb_agg')
messages=once(messages,'INTO results,annotation_result FROM(SELECT count(*) FROM debt) ready;','INTO results,annotation_result FROM(SELECT count(*) FROM debt) ready CROSS JOIN(SELECT count(*) FROM registration) registered;')
messages=once(messages," IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;\n RETURN CASE"," IF operation IS NOT NULL THEN SET CONSTRAINTS native_turn_publication_operation IMMEDIATE;END IF;\n IF native_turn_helpers_current() IS NOT TRUE THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;\n RETURN CASE")
messages=once(messages," RETURN CASE WHEN envelope THEN jsonb_build_object('messages',results,'annotation',annotation_result) ELSE results END;",
 " RETURN CASE WHEN operation->'version'='2'::jsonb THEN native_conversation_publication_packet((operation->>'operationId')::uuid,CASE WHEN envelope THEN jsonb_build_object('messages',results,'annotation',annotation_result) ELSE results END) ELSE CASE WHEN envelope THEN jsonb_build_object('messages',results,'annotation',annotation_result) ELSE results END END;")
// The legacy public signature remains an explicit unmigrated profile under the same owner.
const legacy=`CREATE OR REPLACE FUNCTION public.publish_native_session_message_batch(w uuid,s uuid,payloads jsonb,producer text,sources jsonb,target jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET plan_cache_mode=force_generic_plan AS $legacy$
BEGIN RETURN publish_native_session_message_batch(w,s,payloads,producer,sources,target,NULL);END $legacy$;
REVOKE ALL ON FUNCTION publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb,jsonb) FROM PUBLIC,app_user;
GRANT EXECUTE ON FUNCTION publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb,jsonb) TO app_user;`
let completion=once(oldCompletion,'ordinal integer:=0;','ordinal integer:=0;publication native_conversation_publications;committed_outputs jsonb;')
completion=once(completion,'(work.workspace_id,work.session_id,work.context,work.completion_owner) IS DISTINCT FROM\n   (leader.workspace_id,leader.session_id,leader.context,leader.completion_owner)',
 '(work.workspace_id,work.session_id,work.context,work.completion_owner,work.publication_id) IS DISTINCT FROM\n   (leader.workspace_id,leader.session_id,leader.context,leader.completion_owner,leader.publication_id)')
completion=once(completion,' UPDATE native_turn_publication_work SET completion_ready=true',` IF leader.publication_id IS NOT NULL THEN
  SELECT * INTO publication FROM native_conversation_publications WHERE id=leader.publication_id FOR UPDATE;
  IF publication.id IS NULL OR publication.workspace_id<>leader.workspace_id OR publication.session_id<>leader.session_id
   OR publication.leader_frame_id<>leader.frame_id OR publication.frame_ids IS DISTINCT FROM members
   OR publication.expected_output_count<>jsonb_array_length(NEW.outputs) OR publication.completed_at IS NOT NULL
   OR publication.actor_user_id::text IS DISTINCT FROM nullif(current_setting('app.current_user_id',true),'')
   OR publication.assistant_id::text IS DISTINCT FROM nullif(current_setting('app.v2_assistant_id',true),'')
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  SELECT jsonb_agg(output.n||jsonb_build_object('kind',coalesce(output.n->>'kind','session_message'),'version','1',
   'frameId',coalesce(output.n->>'frameId',leader.frame_id::text)) ORDER BY output.ordinal) INTO committed_outputs
   FROM jsonb_array_elements(NEW.outputs) WITH ORDINALITY output(n,ordinal);
  IF publication.command_format=2 AND native_conversation_terminal_subset(publication.terminal_descriptor,publication.terminal_outputs,committed_outputs) IS NOT TRUE
  THEN RAISE EXCEPTION 'scope_source_changed' USING ERRCODE='42501';END IF;
  UPDATE native_conversation_publications SET outputs=committed_outputs,completed_at=clock_timestamp() WHERE id=publication.id;
 END IF;
 UPDATE native_turn_publication_work SET completion_ready=true`)
let schema=await readFile(new URL('publication-recovery.sql',directory),'utf8')
schema+='\n'+await readFile(new URL('terminal-publication.sql',directory),'utf8')+'\n'+await readFile(new URL('terminal-lifecycle.sql',directory),'utf8')
schema=schema.replaceAll('__WEB_ROOM_PREDICATE__',sessionKindSql.durableBufferedPublication('r'))
const bodyOf=(source,name,tag)=>{
 const start=source.indexOf('FUNCTION public.'+name+'(');if(start<0)throw new Error('Missing declared source function '+name)
 const selected=source.slice(start),marker='AS $'+tag+'$',bodyStart=selected.indexOf(marker)
 if(bodyStart<0)throw new Error('Missing declared function body '+name)
 return selected.slice(bodyStart+marker.length).split('$'+tag+'$;')[0]
}
const newHeaders=[
 ['native_conversation_publication_scope','w uuid,s uuid','jsonb',false],
 ['native_conversation_publication_result','w uuid,s uuid,i uuid','jsonb',false],
 ['native_conversation_publication_enter','w uuid,s uuid,operation jsonb,command jsonb','jsonb',false],
 ['native_conversation_publication_complete','','trigger',false],
 ['native_conversation_publication_immutable','','trigger',false],
 ['read_native_conversation_publications','w uuid,s uuid,after jsonb,maximum integer','jsonb',true],
 ['native_session_turn_publication_state','w uuid,s uuid,t uuid','text',true],
 ['native_conversation_terminal_candidate_valid','candidate jsonb,payloads jsonb,answering uuid','boolean',false],
 ['native_conversation_terminal_subset','descriptor jsonb,selected jsonb,outputs jsonb','boolean',false],
 ['native_conversation_publication_packet','i uuid,value jsonb','jsonb',false],
 ['native_session_public_turn_id','w uuid,s uuid,t uuid','text',false],
 ['native_session_expired_turn_outcome','w uuid,s uuid,t uuid,a uuid,cancelled boolean','text',false],
 ['native_session_turn_transition','s uuid,action text,answering_assistant uuid,started_at timestamp with time zone,stale_after_ms integer,expected_token uuid,expected_public_turn_id text,fence_token boolean','jsonb',false],
 ['native_session_release_turn','s uuid,t uuid,requested_reason text','jsonb',false],
]
const sourceSpecs=newHeaders.map(([name,args,returnType,appExecute])=>({profile:'new',name,signature:name+'('+args.split(',').filter(Boolean).map(x=>x.trim().split(/\s+/).slice(1).join(' ')).join(',')+')',
 argNames:args.split(',').filter(Boolean).map(x=>x.trim().split(/\s+/)[0]),argTypes:args.split(',').filter(Boolean).map(x=>x.trim().split(/\s+/).slice(1).join(' ')),
 returnType,language:'plpgsql',volatility:'v',secdef:true,config:['search_path=pg_catalog, public, pg_temp'],defaultsSQL:name==='read_native_conversation_publications'?'NULL::jsonb, 20':null,appExecute,body:bodyOf(schema,name,'body')}))
for(const [profile,args,source,tag] of [
 ['new','w uuid,s uuid,payloads jsonb,producer text,sources jsonb,target jsonb,operation jsonb',messages,'function'],
 ['replace','w uuid,s uuid,payloads jsonb,producer text,sources jsonb,target jsonb',legacy,'legacy'],
]){const name='publish_native_session_message_batch';sourceSpecs.push({profile,name,signature:name+'('+args.split(',').map(x=>x.trim().split(/\s+/).slice(1).join(' ')).join(',')+')',argNames:args.split(',').map(x=>x.trim().split(/\s+/)[0]),argTypes:args.split(',').map(x=>x.trim().split(/\s+/).slice(1).join(' ')),returnType:'jsonb',language:'plpgsql',volatility:'v',secdef:true,config:['search_path=pg_catalog, public, pg_temp','plan_cache_mode=force_generic_plan'],defaultsSQL:null,appExecute:true,body:bodyOf(source,name,tag)})}
sourceSpecs.push({profile:'replace',name:'native_turn_complete_publication',signature:'native_turn_complete_publication()',argNames:[],argTypes:[],returnType:'trigger',language:'plpgsql',volatility:'v',secdef:true,config:['search_path=pg_catalog, public, pg_temp'],defaultsSQL:null,appExecute:false,body:bodyOf(completion,'native_turn_complete_publication','function')})
const newSignatures=sourceSpecs.filter(spec=>spec.profile==='new').map(spec=>spec.signature)
const signatures=manifest.contracts.map(c=>c.signature)
const defaultCompiler=Object.entries(defaultProfiles).map(([identity,profile])=>{
 const name='pg_temp.publication_default_profile_'+identity,signature=name+'('+profile.types.join(',')+')'
 return `CREATE FUNCTION ${name}(${profile.declaration}) RETURNS pg_catalog.int4 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS 'SELECT 1';
INSERT INTO pg_temp.publication_argument_defaults SELECT ${lit(identity)},p.proargdefaults::text FROM pg_proc p WHERE p.oid=${lit(signature)}::regprocedure;
DROP FUNCTION ${signature};`
}).join('\n')
const expressionCompiler=`
CREATE TEMP TABLE publication_compiled_expressions(profile text PRIMARY KEY,expression text NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE publication_expression_source(
 workspace_id pg_catalog.uuid,id pg_catalog.uuid,session_id pg_catalog.uuid,format pg_catalog.int4,manifest_digest pg_catalog.text,
 flag pg_catalog.bool DEFAULT false,
 CONSTRAINT source_format CHECK(format OPERATOR(pg_catalog.=) ANY(ARRAY[1::pg_catalog.int4,2::pg_catalog.int4])),
 CONSTRAINT source_digest CHECK(manifest_digest OPERATOR(pg_catalog.~) '^[a-f0-9]{64}$'::pg_catalog.text),
 CONSTRAINT source_false CHECK(false));
INSERT INTO pg_temp.publication_compiled_expressions SELECT 'table_default_false',adbin::text FROM pg_attrdef
 WHERE adrelid='pg_temp.publication_expression_source'::regclass AND adnum=6;
INSERT INTO pg_temp.publication_compiled_expressions SELECT CASE conname WHEN 'source_format' THEN 'table_check_format'
 WHEN 'source_digest' THEN 'table_check_digest' WHEN 'source_false' THEN 'table_check_false' END,conbin::text FROM pg_constraint
 WHERE conrelid='pg_temp.publication_expression_source'::regclass;
DROP TABLE pg_temp.publication_expression_source;
CREATE TEMP TABLE publication_historical_projections(identity text PRIMARY KEY,template jsonb NOT NULL) ON COMMIT DROP;
INSERT INTO pg_temp.publication_historical_projections VALUES ${historical.profiles.map(profile=>'('+lit(profile.signature)+','+lit(JSON.stringify(profile.projection))+'::jsonb)').join(',')};
`
const legacyAclSource=await readFile(new URL('publication-recovery-legacy-acl.sql',directory),'utf8')
const legacyAclPhases=new Map([...legacyAclSource.matchAll(/^-- phase: (\w+)\n([\s\S]*?)(?=^-- phase: |$(?![\s\S]))/gm)].map(match=>[match[1],match[2]]))
if(legacyAclPhases.size!==2||!legacyAclPhases.has('before_auth')||!legacyAclPhases.has('after_auth'))throw new Error('Inherited ACL validation phase structure changed')
const legacyAclPhase=name=>legacyAclPhases.get(name).replaceAll('__PUBLICATION_LEGACY_ACL_PROFILE__',()=>lit(JSON.stringify(inheritedAclProfile)))
const retainedGuardAuthentication=(await readFile(new URL('publication-recovery-retained-guard.sql',directory),'utf8'))
 .replaceAll('__PUBLICATION_RETAINED_GUARD_BODY__',()=>lit(retainedGuardBody))
const authentication=`
-- Catalog reads precede private installer state; public runtime routines retain
-- their independently declared pg_catalog,public,pg_temp configuration.
SET LOCAL search_path=pg_catalog,pg_temp,public;
-- Refuse executable DDL hooks before even the source-only comparator compiler.
DO $publication_profile$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'publication_unreviewed_ddl_trigger';END IF;
END $publication_profile$;
CREATE TEMP TABLE publication_argument_defaults(profile text PRIMARY KEY,ast text NOT NULL) ON COMMIT DROP;
${defaultCompiler}
${expressionCompiler}
CREATE TEMP TABLE publication_reviewed_contracts(signature text PRIMARY KEY,metadata jsonb NOT NULL,fingerprint text NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE publication_expected_current(signature text PRIMARY KEY,metadata jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE publication_successor_templates(signature text PRIMARY KEY,parts jsonb NOT NULL) ON COMMIT DROP;
${legacyAclPhase('before_auth')}
-- Render ONLY reviewed positions. All other body bytes and metadata fields are literal.
CREATE FUNCTION pg_temp.publication_slot(slot jsonb) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $slot$
DECLARE value text;pieces text[];projection jsonb;owner_id oid;runtime_id oid;owner_name text;
BEGIN
 IF slot-ARRAY['kind','identity','encoding','relation','triggerType','internal']<>'{}' OR NOT slot ?& ARRAY['kind','identity']
 THEN RAISE EXCEPTION 'publication_unknown_slot';END IF;
 CASE slot->>'kind'
  WHEN 'owner' THEN SELECT relowner::text INTO STRICT value FROM pg_class WHERE oid='public.sessions'::regclass;
  WHEN 'namespace' THEN value:=to_regnamespace(slot->>'identity')::oid::text;
  WHEN 'language' THEN SELECT oid::text INTO STRICT value FROM pg_language WHERE lanname=slot->>'identity';
  WHEN 'function' THEN value:=to_regprocedure(slot->>'identity')::oid::text;
  WHEN 'fingerprint' THEN SELECT encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex') INTO STRICT value FROM pg_proc p WHERE p.oid=to_regprocedure(slot->>'identity');
  WHEN 'argumentDefaults' THEN SELECT ast INTO STRICT value FROM pg_temp.publication_argument_defaults WHERE profile=slot->>'identity';
  WHEN 'catalogExpression' THEN SELECT expression INTO STRICT value FROM pg_temp.publication_compiled_expressions WHERE profile=slot->>'identity';
  WHEN 'columnDefaultOid' THEN
   pieces:=string_to_array(slot->>'identity','.');
   SELECT d.oid::text INTO STRICT value FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
    WHERE d.adrelid=to_regclass(pieces[1]||'.'||pieces[2]) AND a.attname=pieces[3] AND NOT a.attisdropped;
  WHEN 'historicalProjection' THEN
   SELECT template INTO STRICT projection FROM pg_temp.publication_historical_projections WHERE identity=slot->>'identity';
   value:=encode(sha256(convert_to(pg_temp.publication_json(projection)::text,'UTF8')),'hex');
  WHEN 'relation' THEN value:=to_regclass(slot->>'identity')::oid::text;
  WHEN 'type' THEN value:=to_regtype(slot->>'identity')::oid::text;
  WHEN 'constraintNamespace' THEN
   pieces:=string_to_array(slot->>'identity','.');
   IF cardinality(pieces)<>3 OR pieces[1]<>'public' THEN RAISE EXCEPTION 'publication_constraint_namespace_binding_changed';END IF;
   PERFORM 1 FROM pg_constraint WHERE conrelid=to_regclass(pieces[1]||'.'||pieces[2]) AND conname=pieces[3] AND connamespace='public'::regnamespace;
   IF NOT FOUND THEN RAISE EXCEPTION 'publication_constraint_namespace_changed: %',slot->>'identity';END IF;
   value:='public'::regnamespace::oid::text;
  WHEN 'constraint' THEN pieces:=string_to_array(slot->>'identity','.');SELECT oid::text INTO STRICT value FROM pg_constraint WHERE conrelid=to_regclass(pieces[1]||'.'||pieces[2]) AND conname=pieces[3];
  WHEN 'trigger' THEN pieces:=string_to_array(slot->>'identity','.');SELECT oid::text INTO STRICT value FROM pg_trigger WHERE tgrelid=to_regclass(pieces[1]||'.'||pieces[2]) AND tgname=pieces[3];
  WHEN 'constraintTriggerOid','constraintTriggerName' THEN
   pieces:=string_to_array(slot->>'identity','.');
   SELECT CASE WHEN slot->>'kind'='constraintTriggerOid' THEN t.oid::text ELSE t.tgname::text END INTO STRICT value
    FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint
    WHERE c.conrelid=to_regclass(pieces[1]||'.'||pieces[2]) AND c.conname=pieces[3]
     AND t.tgrelid=to_regclass(slot->>'relation') AND t.tgtype=(slot->>'triggerType')::integer AND t.tgisinternal=(slot->>'internal')::boolean;
  WHEN 'ownerAcl' THEN
   IF slot->>'identity'!~'^[A-Za-z*]*$' THEN RAISE EXCEPTION 'publication_acl_slot_invalid';END IF;
   SELECT quote_ident(pg_get_userbyid(relowner))||'='||(slot->>'identity')||'/'||quote_ident(pg_get_userbyid(relowner)) INTO STRICT value FROM pg_class WHERE oid='public.sessions'::regclass;
  WHEN 'relationDefaultAcl' THEN
   IF slot->>'identity' NOT IN('public.scope_derivations','public.scope_derivation_sources') THEN RAISE EXCEPTION 'publication_relation_acl_profile_changed';END IF;
   SELECT relowner,pg_get_userbyid(relowner) INTO STRICT owner_id,owner_name FROM pg_class WHERE oid='public.sessions'::regclass;
   SELECT oid INTO STRICT runtime_id FROM pg_roles WHERE rolname='app_user';
   -- Both maintained bootstraps apply this closed table default ACL. Its entry
   -- order follows the declared grantee OIDs, never target relacl contents.
   SELECT jsonb_agg(entry.acl ORDER BY entry.grantee)::text INTO value FROM(VALUES
    (owner_id,quote_ident(owner_name)||'=arwdDxtm/'||quote_ident(owner_name)),
    (runtime_id,quote_ident('app_user')||'=arwd/'||quote_ident(owner_name))) entry(grantee,acl);
  ELSE RAISE EXCEPTION 'publication_unknown_slot';
 END CASE;
 IF value IS NULL OR value='' THEN RAISE EXCEPTION 'publication_slot_identity_missing: %',slot->>'identity';END IF;
 RETURN value;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'publication_named_slot_missing_or_ambiguous: %',slot USING ERRCODE='55000';
END $slot$;
CREATE FUNCTION pg_temp.publication_json(template jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $render$
DECLARE result jsonb;entry record;rendered_value text;
BEGIN
 IF jsonb_typeof(template)='object' AND template ? '$slot' THEN
  IF template-'$slot'<>'{}' THEN RAISE EXCEPTION 'publication_ambiguous_json_slot';END IF;
  rendered_value:=pg_temp.publication_slot(template->'$slot');
  IF template#>>'{$slot,encoding}'='json' AND template#>>'{$slot,kind}'='relationDefaultAcl' THEN RETURN rendered_value::jsonb;END IF;
  IF template#>>'{$slot,encoding}'='number' THEN RETURN to_jsonb(rendered_value::numeric);END IF;
  IF template#>>'{$slot,encoding}' IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'publication_unknown_slot_encoding';END IF;
  RETURN to_jsonb(rendered_value);
 ELSIF jsonb_typeof(template)='object' THEN
  result:='{}';FOR entry IN SELECT key,value FROM jsonb_each(template) LOOP result:=result||jsonb_build_object(entry.key,pg_temp.publication_json(entry.value));END LOOP;RETURN result;
 ELSIF jsonb_typeof(template)='array' THEN
  SELECT coalesce(jsonb_agg(pg_temp.publication_json(element) ORDER BY ordinal),'[]') INTO result FROM jsonb_array_elements(template) WITH ORDINALITY input(element,ordinal);RETURN result;
 END IF;
 RETURN template;
END $render$;
CREATE FUNCTION pg_temp.publication_body(parts jsonb) RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $render$
DECLARE part jsonb;body text:='';rendered_slot text;
BEGIN
 IF jsonb_typeof(parts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'publication_body_template_missing';END IF;
 FOR part IN SELECT value FROM jsonb_array_elements(parts) LOOP
  IF jsonb_typeof(part)='string' THEN body:=body||(part#>>'{}');
  ELSIF jsonb_typeof(part)='object' AND part-'slot'='{}' THEN
   IF part#>>'{slot,kind}'='catalogLiteral' THEN
    IF (part->'slot')-ARRAY['kind','template']<>'{}' OR NOT(part->'slot') ? 'template' THEN RAISE EXCEPTION 'publication_bad_catalog_slot';END IF;
    rendered_slot:=quote_literal(pg_temp.publication_json(part#>'{slot,template}')::text);
   ELSE rendered_slot:=pg_temp.publication_slot(part->'slot');END IF;
   body:=body||rendered_slot;
  ELSE RAISE EXCEPTION 'publication_unknown_body_slot';END IF;
 END LOOP;
 RETURN body;
END $render$;
${sourceOrdering.sql(newSignatures)}
${retainedGuardAuthentication}
DO $authenticate$ DECLARE expected jsonb;p pg_proc;body text;acl jsonb;owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);runtime_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'publication_unreviewed_ddl_trigger';END IF;
 FOR expected IN SELECT value FROM jsonb_array_elements(${lit(JSON.stringify(manifest.contracts))}::jsonb) LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected->>'signature');
  IF p.oid IS NULL OR p.proowner<>owner_id THEN RAISE EXCEPTION 'publication_predecessor_owner_changed: %',expected->>'signature';END IF;
  body:=pg_temp.publication_source_body(expected->>'signature',expected->'bodyParts',false);
  SELECT jsonb_agg(jsonb_build_object('grantee',grantee,'grantor',grantor,'privilege',privilege,'grantable',grantable) ORDER BY grantee COLLATE "C") INTO acl
  FROM(SELECT CASE WHEN a.grantee=p.proowner THEN 'OWNER' WHEN a.grantee=0 THEN 'PUBLIC' WHEN a.grantee=runtime_id THEN 'app_user' ELSE 'UNREVIEWED_OID:'||a.grantee::text END grantee,
   CASE WHEN a.grantor=p.proowner THEN 'OWNER' ELSE 'UNREVIEWED_OID:'||a.grantor::text END grantor,a.privilege_type privilege,a.is_grantable grantable
   FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) grants;
  IF (p.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C")
   OR (to_jsonb(p)-ARRAY['oid','prosrc','proacl']) IS DISTINCT FROM pg_temp.publication_json(expected->'metadata')
  THEN RAISE EXCEPTION 'publication_predecessor_changed: %',expected->>'signature';END IF;
  PERFORM pg_temp.publication_authenticate_acl(expected->>'signature',p,expected->'acl',acl);
  INSERT INTO publication_reviewed_contracts SELECT expected->>'signature',to_jsonb(p),encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex');
  INSERT INTO publication_expected_current VALUES(expected->>'signature',to_jsonb(p));
  INSERT INTO publication_successor_templates VALUES(expected->>'signature',expected->'bodyParts');
 END LOOP;
 IF (SELECT array_agg(signature ORDER BY signature COLLATE "C") FROM native_retained_contract_helpers) IS DISTINCT FROM ${arr(retainedGuardRoster)}
  OR EXISTS(SELECT 1 FROM native_retained_contract_helpers h LEFT JOIN publication_expected_current e USING(signature)
   WHERE e.signature IS NULL OR h.fingerprint<>encode(sha256(convert_to(e.metadata::text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'publication_retained_registry_changed';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE OR native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'publication_predecessor_contract_changed';END IF;
 IF EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE NOT h.signature=ANY(${arr(signatures)}))
 THEN RAISE EXCEPTION 'publication_unreviewed_registry_member';END IF;
 -- Direct source replacements will already equal their successor templates at
 -- the propagation loop. Classify their ORIGINAL consumers before any DDL.
 FOR expected IN SELECT to_jsonb(r) FROM publication_reviewed_contracts r WHERE r.signature IN
  ('publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','native_turn_complete_publication()')
  OR EXISTS(SELECT 1 FROM pg_temp.publication_legacy_acl_repairs repair WHERE repair.signature=r.signature) LOOP
  IF EXISTS(SELECT 1 FROM pg_proc c WHERE ${persistentCaller}
   AND strpos(c.prosrc,expected->>'fingerprint')>0
   AND NOT EXISTS(SELECT 1 FROM publication_successor_templates t WHERE t.signature=c.oid::regprocedure::text))
  THEN RAISE EXCEPTION 'publication_unreviewed_pin_consumer: %',expected->>'signature';END IF;
 END LOOP;
END $authenticate$;
${legacyAclPhase('after_auth')}
`
const oldTableSource=await readFile(new URL('../../migrations/8188_native_turn_shared_publication.sql',directory),'utf8')
const oldTableExpression=oldTableSource.split('expression:=$query$')[1]?.split('$query$;')[0]
if(!oldTableExpression)throw new Error('Reviewed publication table expression missing')
const newTableExpression=oldTableExpression.replaceAll("'native_turn_publication_debt'::regclass]","'native_turn_publication_debt'::regclass,'native_conversation_publications'::regclass]")
const oldGuardPart=manifest.contracts.find(c=>c.signature==='native_turn_helpers_current()').bodyParts.find(p=>typeof p==='string'&&p.includes('array_agg(h.signature ORDER BY h.signature)='))
const rosterStart=oldGuardPart.indexOf('array_agg(h.signature ORDER BY h.signature)=')+'array_agg(h.signature ORDER BY h.signature)='.length
const oldRoster=oldGuardPart.slice(rosterStart,oldGuardPart.indexOf('::text[]',rosterStart))
const oldRegistryNames=[...oldRoster.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replaceAll("''","'"))
if(oldRegistryNames.length<100||new Set(oldRegistryNames).size!==oldRegistryNames.length)throw new Error('Reviewed registry roster malformed')
const nextRoster=arr([...oldRegistryNames,...newSignatures].sort()).replace(/::text\[\]$/,'')
const tableContract=`
-- The independently checked source successor snapshot is the only input to the
-- new table literal. Every unchanged byte comes from the reviewed body template.
DO $table_plan$ DECLARE actual jsonb;expected jsonb;part jsonb;next_parts jsonb:='[]';count_expression integer:=0;count_literal integer:=0;text text;BEGIN
 ${newTableExpression.replace(/^SELECT /,'SELECT ')} INTO actual;
 SELECT snapshot INTO STRICT expected FROM publication_verified_table_snapshot;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_successor_table_changed';END IF;
 FOR part IN SELECT value FROM jsonb_array_elements((SELECT t.parts FROM publication_successor_templates t WHERE signature='native_turn_publication_contract()')) LOOP
  IF jsonb_typeof(part)='string' THEN
   text:=part#>>'{}';
   IF strpos(text,${lit(oldTableExpression)})>0 THEN
    IF (length(text)-length(replace(text,${lit(oldTableExpression)},'')))/length(${lit(oldTableExpression)})<>1 THEN RAISE EXCEPTION 'publication_ambiguous_table_expression';END IF;
    text:=replace(text,${lit(oldTableExpression)},${lit(newTableExpression)});count_expression:=count_expression+1;
   END IF;
   next_parts:=next_parts||jsonb_build_array(text);
  ELSIF part#>>'{slot,kind}'='catalogLiteral' AND part#>'{slot,template,tables}' IS NOT NULL THEN
   next_parts:=next_parts||jsonb_build_array(quote_literal(expected::text));count_literal:=count_literal+1;
  ELSE next_parts:=next_parts||jsonb_build_array(part);END IF;
 END LOOP;
 IF count_expression<>1 OR count_literal<>1 THEN RAISE EXCEPTION 'publication_table_template_shape';END IF;
 UPDATE publication_successor_templates SET parts=next_parts WHERE signature='native_turn_publication_contract()';
END $table_plan$;
`
const propagate=`
DO $roster_plan$ DECLARE part jsonb;next_parts jsonb:='[]';text text;changed integer:=0;routine text;p pg_proc;expected jsonb;BEGIN
 FOREACH routine IN ARRAY ${arr(newSignatures)} LOOP
  SELECT metadata INTO STRICT expected FROM publication_expected_current WHERE signature=routine;
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(routine);
  IF to_jsonb(p) IS DISTINCT FROM expected OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=routine)
  THEN RAISE EXCEPTION 'publication_new_contract_not_source_verified: %',routine;END IF;
  INSERT INTO native_turn_contract_helpers VALUES(routine,p);
 END LOOP;
 FOR part IN SELECT value FROM jsonb_array_elements((SELECT t.parts FROM publication_successor_templates t WHERE signature='native_turn_helpers_current()')) LOOP
  IF jsonb_typeof(part)='string' THEN
   text:=part#>>'{}';
   IF strpos(text,${lit(oldRoster)})>0 THEN
    IF (length(text)-length(replace(text,${lit(oldRoster)},'')))/length(${lit(oldRoster)})<>1 THEN RAISE EXCEPTION 'publication_ambiguous_roster_slot';END IF;
    text:=replace(text,${lit(oldRoster)},${lit(nextRoster)});changed:=changed+1;
   END IF;
   next_parts:=next_parts||jsonb_build_array(text);
  ELSE next_parts:=next_parts||jsonb_build_array(part);END IF;
 END LOOP;
 IF changed<>1 THEN RAISE EXCEPTION 'publication_registry_template_shape';END IF;
 UPDATE publication_successor_templates t SET parts=next_parts WHERE signature='native_turn_helpers_current()';
 -- Only the two explicitly source-replaced predecessor bodies differ before
 -- typed slot propagation. Their complete expected rows came from trusted DDL.
 FOREACH routine IN ARRAY ARRAY['publish_native_session_message_batch(uuid,uuid,jsonb,text,jsonb,jsonb)','native_turn_complete_publication()'] LOOP
  SELECT metadata INTO STRICT expected FROM publication_expected_current WHERE signature=routine;
  SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(routine);
  IF to_jsonb(p) IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM native_turn_contract_helpers h JOIN publication_reviewed_contracts old ON old.signature=h.signature
   WHERE h.signature=routine AND to_jsonb(h.contract)=old.metadata) THEN RAISE EXCEPTION 'publication_direct_successor_changed: %',routine;END IF;
  UPDATE native_turn_contract_helpers SET contract=p WHERE signature=routine;
 END LOOP;
END $roster_plan$;
-- Whole owning bodies are rerendered from reviewed literal/typed parts. No hash
-- substring replacement and no enrollment of arbitrary live prosrc deltas.
DO $pins$ DECLARE routine record;caller record;p pg_proc;after_row pg_proc;expected jsonb;next_expected jsonb;body text;definition text;
 old_hash text;new_hash text;passes integer:=0;changes integer;
BEGIN
 LOOP
  passes:=passes+1;IF passes>100 THEN RAISE EXCEPTION 'publication_pin_cycle';END IF;changes:=0;
  FOR routine IN SELECT t.signature,t.parts FROM publication_successor_templates t ORDER BY t.signature LOOP
   SELECT metadata INTO STRICT expected FROM publication_expected_current WHERE signature=routine.signature;
   SELECT * INTO STRICT p FROM pg_proc WHERE oid=to_regprocedure(routine.signature);
   IF to_jsonb(p) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'publication_unreviewed_successor_change: %',routine.signature;END IF;
   body:=pg_temp.publication_source_body(routine.signature,routine.parts,true);
   IF (p.prosrc COLLATE "C") IS NOT DISTINCT FROM (body COLLATE "C") THEN CONTINUE;END IF;
   old_hash:=encode(sha256(convert_to(expected::text,'UTF8')),'hex');
   FOR caller IN SELECT c.oid::regprocedure::text signature FROM pg_proc c WHERE ${persistentCaller} AND strpos(c.prosrc,old_hash)>0 LOOP
    IF NOT EXISTS(SELECT 1 FROM publication_successor_templates t WHERE t.signature=caller.signature)
    THEN RAISE EXCEPTION 'publication_unreviewed_pin_consumer: %',caller.signature;END IF;
   END LOOP;
   definition:=pg_get_functiondef(p.oid);
   IF p.prosrc='' OR (length(definition)-length(replace(definition,p.prosrc,'')))/length(p.prosrc)<>1 THEN RAISE EXCEPTION 'publication_owning_body_shape';END IF;
   EXECUTE replace(definition,p.prosrc,body);
   SELECT * INTO STRICT after_row FROM pg_proc WHERE oid=p.oid;
   next_expected:=jsonb_set(expected,'{prosrc}',to_jsonb(body));
   IF to_jsonb(after_row) IS DISTINCT FROM next_expected THEN RAISE EXCEPTION 'publication_rendered_metadata_changed: %',routine.signature;END IF;
   IF EXISTS(SELECT 1 FROM native_turn_contract_helpers h WHERE h.signature=routine.signature AND to_jsonb(h.contract) IS DISTINCT FROM expected)
   THEN RAISE EXCEPTION 'publication_registry_predecessor_changed: %',routine.signature;END IF;
   UPDATE native_turn_contract_helpers SET contract=after_row WHERE signature=routine.signature;
   new_hash:=encode(sha256(convert_to(next_expected::text,'UTF8')),'hex');
   IF EXISTS(SELECT 1 FROM native_retained_contract_helpers h WHERE h.signature=routine.signature AND h.fingerprint<>old_hash)
   THEN RAISE EXCEPTION 'publication_retained_predecessor_changed: %',routine.signature;END IF;
   UPDATE native_retained_contract_helpers SET fingerprint=new_hash WHERE signature=routine.signature AND fingerprint=old_hash;
   UPDATE publication_expected_current SET metadata=next_expected WHERE signature=routine.signature;
   changes:=changes+1;
  END LOOP;
  EXIT WHEN changes=0;
 END LOOP;
 IF EXISTS(SELECT 1 FROM publication_expected_current e LEFT JOIN pg_proc current_fn ON current_fn.oid=to_regprocedure(e.signature) WHERE to_jsonb(current_fn) IS DISTINCT FROM e.metadata)
  OR EXISTS(SELECT 1 FROM native_turn_contract_helpers h JOIN pg_proc current_fn ON current_fn.oid=to_regprocedure(h.signature) WHERE current_fn IS DISTINCT FROM h.contract)
 THEN RAISE EXCEPTION 'publication_registry_successor_mismatch';END IF;
 IF native_turn_helpers_current() IS NOT TRUE OR native_turn_publication_contract() IS NOT TRUE OR native_retained_helpers_current() IS NOT TRUE
 THEN RAISE EXCEPTION 'publication_successor_contract_changed';END IF;
END $pins$;
`
if(process.argv.includes('--source-specs')){await writeFile('/private/tmp/m1-publication-source-specs.json',JSON.stringify(sourceSpecs,null,2));process.exit(0)}
const successorSource=await readFile(new URL('publication-recovery-successor.sql',directory),'utf8')
const successorPhases=new Map([...successorSource.matchAll(/^-- phase: (\w+)\n([\s\S]*?)(?=^-- phase: |$(?![\s\S]))/gm)].map(m=>[m[1],m[2]]))
if(successorPhases.size!==2||!successorPhases.has('before_installer')||!successorPhases.has('after_installer'))throw new Error('Successor validation phase structure changed')
const renderSuccessorPhase=name=>successorPhases.get(name).replaceAll('__PUBLICATION_SOURCE_SPECS__',()=>lit(JSON.stringify(sourceSpecs))).replaceAll('__PUBLICATION_TABLE_EXPRESSION__',()=>newTableExpression)
const migration=`-- [COMP:api/native-turn-frame] Authenticated atomic buffered-web publication receipts.
-- Generated by scripts/conversation-store/build-publication-recovery.mjs; no applied predecessor is rewritten.
BEGIN;
${authentication}
CREATE TEMP TABLE publication_predecessor_table_snapshot AS SELECT (${oldTableExpression}) AS snapshot;
${schema}
${messages}
${legacy}
${completion}
${renderSuccessorPhase('before_installer')}
-- Existing recovery owner enrolls the new protected relation and preserves old trigger identities.
SELECT public.crm_install_erasure_capture();
${renderSuccessorPhase('after_installer')}
${tableContract}
${propagate}
COMMIT;
`
if(process.argv.includes('--check')){if(await readFile(target,'utf8')!==migration)throw new Error('Durable publication migration differs from reviewed sources');console.log('Durable publication migration matches sources')}
else{await writeFile(target,migration);console.log('Generated durable publication forward migration')}
