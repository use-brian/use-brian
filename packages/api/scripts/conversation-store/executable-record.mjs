// [COMP:api/native-turn-frame] Complete inputtable PG18 executable metadata.
// Source-defined field order; no pg_node_tree input, JSON-to-pg_proc cast, or
// target-catalog-derived type definition. Only the two parse-tree outputs use text.
export const executableFields = Object.freeze([
 ['oid','oid'],['proname','name','C'],['pronamespace','oid'],['proowner','oid'],['prolang','oid'],
 ['procost','real'],['prorows','real'],['provariadic','oid'],['prosupport','regproc'],
 ['prokind','"char"'],['prosecdef','boolean'],['proleakproof','boolean'],['proisstrict','boolean'],['proretset','boolean'],
 ['provolatile','"char"'],['proparallel','"char"'],['pronargs','smallint'],['pronargdefaults','smallint'],['prorettype','oid'],
 ['proargtypes','oidvector'],['proallargtypes','oid[]'],['proargmodes','"char"[]'],['proargnames','text[]','C'],
 ['proargdefaults','text','C'],['protrftypes','oid[]'],['prosrc','text','C'],['probin','text','C'],['prosqlbody','text','C'],
 ['proconfig','text[]','C'],['proacl','aclitem[]'],
].map(field=>Object.freeze(field)))
const identifier=name=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('executable_projection_requires_source_identifier');return name}
const qualifiedType=type=>'pg_catalog.'+({real:'float4',boolean:'bool',smallint:'int2'}[type]??type)
export const executableRecordType='public.native_executable_contract_v1'
export function executableProjection(alias,{compositeColumn=false}={}){
 const source=compositeColumn?'('+identifier(alias)+')':identifier(alias)
 return 'ROW('+executableFields.map(([name])=>source+'.'+name+(['proargdefaults','prosqlbody'].includes(name)?'::text':'')).join(',')+')::'+executableRecordType
}
export const executableRecordSql=`CREATE TYPE ${executableRecordType} AS(\n ${executableFields.map(([name,type,collation])=>name+' '+qualifiedType(type)+(collation?' COLLATE pg_catalog."'+collation+'"':'')).join(',\n ')}\n);
REVOKE ALL ON TYPE ${executableRecordType} FROM PUBLIC,app_user;`
export const convertCanonicalRegistrySql=`ALTER TABLE public.native_turn_contract_helpers ALTER COLUMN contract TYPE ${executableRecordType}
USING ${executableProjection('contract',{compositeColumn:true})};`
const quote=value=>"'"+value.replaceAll("'","''")+"'"
// Complete local representation shape: fields, types, typmods, collations and
// absence of defaults/generated/identity/dropped/column grants all remain exact.
export const executableRecordShapeSql=`(
 SELECT t.typtype='c' AND t.typnamespace='public'::regnamespace
 AND t.typowner=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass)
 AND t.typinput='pg_catalog.record_in'::regproc AND t.typoutput='pg_catalog.record_out'::regproc
 AND t.typreceive='pg_catalog.record_recv'::regproc AND t.typsend='pg_catalog.record_send'::regproc
 AND t.typmodin=0 AND t.typmodout=0 AND t.typsubscript=0 AND t.typanalyze=0
 AND t.typelem=0 AND t.typbasetype=0 AND t.typnotnull=false AND t.typisdefined
 AND t.typcategory='C' AND t.typlen=-1 AND NOT t.typbyval AND t.typalign='d' AND t.typstorage='x'
 AND t.typcollation=0 AND t.typdefault IS NULL AND t.typdefaultbin IS NULL
 AND t.typacl IS NOT DISTINCT FROM ARRAY[makeaclitem(t.typowner,t.typowner,'USAGE',false)]
 AND EXISTS(SELECT 1 FROM pg_attribute registry_column WHERE registry_column.attrelid='public.native_turn_contract_helpers'::regclass
  AND registry_column.attname='contract' AND registry_column.atttypid=t.oid AND registry_column.attnotnull
  AND NOT registry_column.attisdropped AND NOT registry_column.atthasdef AND registry_column.attacl IS NULL)
 AND(SELECT count(*) FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0)=${executableFields.length}
 AND NOT EXISTS(SELECT 1 FROM pg_attribute a FULL JOIN(VALUES
 ${executableFields.map(([name,type,collation],index)=>'('+(index+1)+','+quote(name)+','+quote(qualifiedType(type))+'::regtype::oid,'+(collation?quote('pg_catalog."'+collation+'"')+'::regcollation::oid':'0::oid')+')').join(',\n ')}
 ) expected(position,name,type_oid,collation_oid) ON a.attnum=expected.position
 WHERE a.attrelid=t.typrelid AND a.attnum>0 AND(a.attname::text IS DISTINCT FROM expected.name OR a.atttypid IS DISTINCT FROM expected.type_oid
 OR a.attcollation IS DISTINCT FROM expected.collation_oid OR a.atttypmod<>-1 OR a.attnotnull OR a.attisdropped
 OR a.atthasdef OR a.atthasmissing OR a.attgenerated<>'' OR a.attidentity<>'' OR a.attacl IS NOT NULL))
 FROM pg_type t WHERE t.oid=${quote(executableRecordType)}::regtype
)`
// Portable export of the canonical registry (portable-restore.mjs). Archived
// records are original source proof only: complete inputtable text per
// signature. They are never imported, cast into a target registry or used to
// repin target records; the target registry is rendered by the shipped
// installer and authenticated by installation-authentication.mjs.
export const executableRegistryProofSql=`SELECT h.signature,h.contract::text record FROM public.native_turn_contract_helpers h ORDER BY h.signature COLLATE "C"`
/** Logical identity check: the archived and target registries name the same signatures. */
export function compareExecutableRegistryRosters(source,target){
 const names=rows=>{
  if(!Array.isArray(rows)||rows.some(row=>typeof row?.signature!=='string'||typeof row.record!=='string'||!row.record.startsWith('(')))throw Error('executable_registry_proof_malformed')
  const list=rows.map(row=>row.signature)
  if(new Set(list).size!==list.length)throw Error('executable_registry_proof_malformed')
  return list.join('\n')
 }
 if(names(source)!==names(target))throw Object.assign(Error('portable_restore_derived_roster_mismatch: native_turn_contract_helpers'),{code:'portable_restore_derived_roster_mismatch'})
 return source.length
}
