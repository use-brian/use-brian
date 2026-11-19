// [COMP:api/native-turn-frame] Exact source-owned historical collation operations.
import {createHash} from 'node:crypto'
const sha=value=>createHash('sha256').update(value).digest('hex')
const signature='native_turn_helpers_current()'
const sourceFile='8269_canonical_conversation_publication.sql'
const sourceSha='d17106c521097797416a2a51ba53d07fce978ea1da587dae82d066da4575ec39'
const templateSha='38f25a69243672f67d012fc4aa85ce984269069f5682fc82c0b0ecae9c3c48ea'
const predicateClause="SELECT string_agg('('||predicate||')',' AND ' ORDER BY predicate) INTO predicates\n FROM (SELECT DISTINCT predicate FROM conversation_contract_predicates) contracts;"
const rosterClause="SELECT 'ARRAY['||string_agg(quote_literal(h.signature),',' ORDER BY h.signature)||']' INTO new_array FROM native_turn_contract_helpers h;"
const lit=value=>`'${value.replaceAll("'","''")}'`
const array=names=>'ARRAY['+names.map(lit).join(',')+']'
export function reviewedSourceOrdering(manifest,source){
 const parts=manifest.contracts.find(c=>c.signature===signature)?.bodyParts
 if(sha(source)!==sourceSha||manifest.source[sourceFile]!==sourceSha
  ||source.split(predicateClause).length!==2||source.split(rosterClause).length!==2
  ||!parts||sha(JSON.stringify(parts))!==templateSha)throw new Error('publication_source_ordering_provenance_changed')
 const prefix='\n SELECT native_turn_publication_contract() AND ('
 const middle=parts[2],tail=parts[4],firstEnd=middle.indexOf(' AND '),secondEnd=tail.indexOf(' AND ')
 if(parts.length!==5||!parts[0].startsWith(prefix)||firstEnd!==8||secondEnd!==10
  ||middle.slice(0,firstEnd)!=='::jsonb)'||tail.slice(0,secondEnd)!=='::jsonb)))')throw new Error('publication_source_ordering_fragment_changed')
 const anchor='array_agg(h.signature ORDER BY h.signature)=',start=tail.indexOf(anchor)+anchor.length,end=tail.indexOf('::text[]',start)
 const oldRoster=tail.slice(start,end),names=[...oldRoster.matchAll(/'((?:[^']|'')*)'/g)].map(m=>m[1].replaceAll("''","'"))
 if(names.length!==268||new Set(names).size!==268||oldRoster!==array(names)||JSON.stringify(names)!==JSON.stringify([...names].sort()))throw new Error('publication_source_ordering_roster_changed')
 const profile={format:1,signature,source:{file:sourceFile,sha256:sourceSha},templateSha256:templateSha,
  operations:[{identity:'table_predicates',sourceSha256:sha(predicateClause),members:2},
   {identity:'signature_roster',sourceSha256:sha(rosterClause),members:names.length,membersSha256:sha(JSON.stringify(names))}]}
 if(JSON.stringify(manifest.sourceOrdering)!==JSON.stringify(profile))throw new Error('publication_source_ordering_profile_changed')
 return{profile,sql(newSignatures){
  const nextNames=[...names,...newSignatures].sort(),nextRoster=array(nextNames)
  if(new Set(nextNames).size!==nextNames.length)throw new Error('publication_source_ordering_successor_roster_changed')
  return `
-- Reproduce only the two immutable 8269 ORDER BY operations. No live prosrc or
-- target registry value supplies an expected string. Every other byte is exact.
CREATE FUNCTION pg_temp.publication_source_body(routine text,parts jsonb,successor boolean)
RETURNS text LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $source_order$
DECLARE source_parts jsonb:=${lit(JSON.stringify(parts))}::jsonb;expected_parts jsonb;
 first_predicate text;second_predicate text;predicates text;ordered_roster text;roster text;body text;
BEGIN
 IF routine<>${lit(signature)} THEN RETURN pg_temp.publication_body(parts);END IF;
 expected_parts:=CASE WHEN successor THEN jsonb_set(source_parts,'{4}',to_jsonb(replace(source_parts->>4,${lit(oldRoster)},${lit(nextRoster)}))) ELSE source_parts END;
 IF successor IS NULL OR parts IS DISTINCT FROM expected_parts THEN RAISE EXCEPTION 'publication_source_ordering_template_changed';END IF;
 first_predicate:=pg_temp.publication_body(jsonb_build_array(substring(parts->>0 FROM ${prefix.length+1}),parts->1,substring(parts->>2 FROM 1 FOR ${firstEnd})));
 second_predicate:=pg_temp.publication_body(jsonb_build_array(substring(parts->>2 FROM ${firstEnd+6}),parts->3,substring(parts->>4 FROM 1 FOR ${secondEnd-1})));
 -- Historical synthesis wrapped each complete source predicate after sorting.
 SELECT string_agg('('||predicate||')',' AND ' ORDER BY predicate) INTO predicates FROM(VALUES
  (substring(first_predicate FROM 2 FOR length(first_predicate)-2)),
  (substring(second_predicate FROM 2 FOR length(second_predicate)-2))) source(predicate);
 SELECT 'ARRAY['||string_agg(quote_literal(value),',' ORDER BY value)||']' INTO ordered_roster
 FROM jsonb_array_elements_text(CASE WHEN successor THEN ${lit(JSON.stringify(nextNames))}::jsonb ELSE ${lit(JSON.stringify(names))}::jsonb END) source(value);
 body:=${lit(prefix)}||predicates||substring(parts->>4 FROM ${secondEnd});
 roster:=CASE WHEN successor THEN ${lit(nextRoster)} ELSE ${lit(oldRoster)} END;
 IF (length(body)-length(replace(body,roster,'')))/length(roster)<>1 THEN RAISE EXCEPTION 'publication_source_ordering_roster_slot_changed';END IF;
 RETURN replace(body,roster,ordered_roster);
END $source_order$;
`
 }}
}
