// [COMP:api/native-chat-read-cost] Minimal adapters over checksum-bound canonical reducers.
import {createHash} from 'node:crypto'

export const queryCachePredecessors={
 scan:'7fb479137370a384bd417ee4515a742da8d1b87cd239648bffaac0e696293bdd',
 domain:'7fd5badb63e7d68c82cfa4e266c2ff35caa83703b3f9f7c286e5283569b4fe2b',
 envelope:'ad8339ec66f3144c25efe8fdc60aa1aa2825a550edc45e74ea016bd25d75a098',
 field:'eb933c5f96df29237167f291cf3f01f41cf928eb7be0f981bc90764ba16313cc',
}

export async function queryCacheSource(historicalSource){
 const original=await historicalSource('8199_native_turn_compact_requirements.sql','4731e8c3e80e598a4f9a6ca3c8da95bd4b16fb05741e9ef2c882add532ebd6a1')
 const replaceOnce=(source,old,value)=>{
  if(source.split(old).length!==2)throw new Error(`Canonical query adapter anchor changed: ${old}`)
  return source.replace(old,()=>value)
 }
 const adapters=Object.entries(queryCachePredecessors).map(([name,sha])=>{
  const match=original.match(new RegExp(`CREATE FUNCTION public\\.native_turn_compact_${name}\\([^;]*?AS \\$compact\\$([\\s\\S]*?)\\$compact\\$;`))
  if(!match||createHash('sha256').update(match[1]).digest('hex')!==sha)throw new Error(`Canonical query adapter predecessor changed: ${name}`)
  let source=replaceOnce(match[0],`native_turn_compact_${name}(`,`native_retained_cached_${name}(`)
  source=replaceOnce(source,') RETURNS jsonb',',query_envelope_slots jsonb,query_envelope_values jsonb[]) RETURNS jsonb')
  if(name==='scan'){
   source=replaceOnce(source,'attempts integer:=0;','attempts integer:=0;query_fields text[];')
   source=replaceOnce(source,' WITH selected AS MATERIALIZED(',` query_fields:=ARRAY(SELECT DISTINCT key FROM unnest(fields) key ORDER BY key);
 WITH selected AS MATERIALIZED(`)
   source=replaceOnce(source,"native_turn_compact_envelope(w,t,m.id,'query',fields,memo,worklist_frame,completed_points)->'value'",
    'native_retained_query_value(w,worklist_frame,jsonb_build_array(t,m.id,query_fields)::text,query_envelope_slots,query_envelope_values)')
  }else if(name==='domain'){
   source=replaceOnce(source,"native_turn_compact_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo,worklist_frame,completed_points)",
    "native_retained_cached_scan(w,(frozen.domain->>'sessionId')::uuid,t,(frozen.domain->>'throughSequence')::integer,fields,frozen.domain->'bounds',frozen.domain->'visibility',memo,worklist_frame,completed_points,query_envelope_slots,query_envelope_values)")
  }else if(name==='envelope'){
   source=replaceOnce(source,'BEGIN\n',`BEGIN
 IF selection IS DISTINCT FROM 'query_domain' OR t='memory' THEN
  RETURN native_turn_compact_envelope(w,t,i,selection,fields,memo,worklist_frame,completed_points);END IF;
`)
   source=replaceOnce(source,'native_turn_compact_domain(w,t,i,keys,memo,worklist_frame,completed_points)',
    'native_retained_cached_domain(w,t,i,keys,memo,worklist_frame,completed_points,query_envelope_slots,query_envelope_values)')
   source=replaceOnce(source,` FOR child IN SELECT value FROM jsonb_array_elements(children) LOOP
  sources:=sources||jsonb_build_array(child->'source')||coalesce(child->'sources','[]');
 END LOOP;
 SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (SELECT DISTINCT value FROM jsonb_array_elements(sources)) unique_sources;`,
    ` SELECT coalesce(jsonb_agg(value ORDER BY value::text),'[]') INTO sources FROM (
  SELECT DISTINCT expanded.value FROM jsonb_array_elements(children) AS child_row(value)
  CROSS JOIN LATERAL jsonb_array_elements(jsonb_build_array(child_row.value->'source')||coalesce(child_row.value->'sources','[]')) expanded(value)
 ) unique_sources;`)
  }else{
   source=replaceOnce(source," IF NOT FOUND THEN RETURN '{}'::jsonb;END IF;",` IF NOT FOUND THEN RETURN '{}'::jsonb;END IF;
 IF resource.selection IS DISTINCT FROM 'query_domain' OR resource.type_key='memory' THEN
  RETURN native_turn_compact_field(w,i,v,memo,worklist_frame,completed_points,completed_fields);END IF;`)
   source=replaceOnce(source,'native_turn_compact_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,worklist_frame,completed_points)',
    'native_retained_cached_envelope(w,resource.type_key,resource.resource_id,resource.selection,resource.fields,memo,worklist_frame,completed_points,query_envelope_slots,query_envelope_values)')
  }
  return source
 })
 return `-- Private completed canonical query envelopes; never shared between acquisitions.
CREATE FUNCTION native_retained_query_value(w uuid,frame jsonb,point_key text,slots jsonb,completed_values jsonb[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $cached$
DECLARE slot integer;
BEGIN
 IF frame->>'workspaceId' IS DISTINCT FROM w::text OR frame->>'closed' IS DISTINCT FROM 'true'
  OR NOT coalesce(slots ? point_key,false) OR jsonb_typeof(slots->point_key) IS DISTINCT FROM 'number' THEN
  RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
 slot:=(slots->>point_key)::integer;
 IF slot NOT BETWEEN 1 AND coalesce(cardinality(completed_values),0) THEN
  RAISE EXCEPTION 'native_turn_requirement_unresolved' USING ERRCODE='PNT01';END IF;
 -- A present slot containing SQL NULL is the canonical completed-negative result.
 RETURN completed_values[slot];
END $cached$;
${adapters.join('\n\n')}\n`
}
