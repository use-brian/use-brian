// [COMP:api/page-thread-audience] Read-only attestation of the Page successor.
import { createHash } from 'node:crypto'
import { currentInstallationAuthenticationSource as previousSource, assertAuthenticationReadOnly as previousReadOnly } from './installation-authentication-8310.mjs'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { pageDeliverySectionEnd, pageDeliverySectionStart, reviewedConversationPageDeliverySource,
  pageFrameChanges, pageFrameRenderer } from './build-conversation-page-delivery.mjs'

const prefix = 'a8310_'
const installedPrefix = 'a8311_'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const hash = value => createHash('sha256').update(value).digest('hex')
const roster = [
  { name: 'private_conversation_page_frame_source', exposed: false },
  { name: 'conversation_page_turn_facts', exposed: false },
  { name: 'capture_native_page_turn_delivery', exposed: true },
  { name: 'capture_native_page_turn_anchor', exposed: true },
]

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('conversation_page_authentication_source_changed: ' + before.slice(0, 80))
  return source.replace(before, () => after)
}

export function assertAuthenticationReadOnly(sql) {
  previousReadOnly(sql.replaceAll(installedPrefix, prefix))
}

export async function pageDeliveryInstallationSource(migration, options) {
  const [previous, source] = await Promise.all([previousSource(options), reviewedConversationPageDeliverySource()])
  if (migration.split(pageDeliverySectionStart).length !== 2 || migration.split(pageDeliverySectionEnd).length !== 2
    || !migration.includes(pageDeliverySectionStart + source + pageDeliverySectionEnd)) throw Error('conversation_page_definition_changed')
  const names = [...source.matchAll(/^CREATE FUNCTION public\.([a-z_]+)\(/gm)].map(match => match[1])
  if (JSON.stringify(names) !== JSON.stringify(roster.map(({ name }) => name)) || [...source.matchAll(/^GRANT /gm)].length !== 2)
    throw Error('conversation_page_roster_changed')
  const references = roster.map(({ name }, index) => receivingOwnerDeclaration(source, name)
    .replace(/^CREATE FUNCTION public\.[a-z_]+/, 'CREATE FUNCTION pg_temp.page_delivery_reviewed_' + index))
  const proof = `DO $page_delivery_references$ BEGIN
${references.map(reference => ' EXECUTE ' + literal(reference) + ';').join('\n')}
END $page_delivery_references$;
CREATE TEMP TABLE page_delivery_reviewed_oids(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $page_delivery_catalog$
DECLARE item record;actual pg_proc;reviewed pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 app_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ${roster.map(({ name, exposed }, i) => `(${literal(name)},${literal('page_delivery_reviewed_' + i)},${exposed})`).join(',')}
 ) declarations(name,reference,exposed) LOOP
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=item.reference;
  SELECT * INTO actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=item.name AND proargtypes=reviewed.proargtypes;
  IF actual.oid IS NULL OR actual.proowner<>owner_id
   OR actual.proacl IS DISTINCT FROM (CASE WHEN item.exposed THEN
    ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
   ELSE ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)] END)
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
      (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
  THEN RAISE EXCEPTION 'conversation_page_function_changed: %',item.name; END IF;
  INSERT INTO pg_temp.page_delivery_reviewed_oids VALUES(actual.oid);
 END LOOP;
END $page_delivery_catalog$;`
  const renderer = prefix + 'conversion_source_body'
  const predecessorRenderer = prefix + 'page_delivery_predecessor_body'
  const declaration = `CREATE FUNCTION pg_temp.${renderer}(routine text,parts jsonb,successor boolean)`
  const marker = 'END $record_lineage_renderer$;'
  let sql = once(previous.sql, declaration, declaration.replace(renderer, predecessorRenderer))
  sql = once(sql, marker, marker + '\n' + pageFrameRenderer(renderer, predecessorRenderer))
  // The conversion catalogue has an earlier independent body comparison.
  // Keep its original references for the later transitive renderer.
  const prepare = 'DO $conversion_source_functions$'
  const end = 'END $conversion_source_functions$;'
  const beginIndex = sql.indexOf(prepare), endIndex = sql.indexOf(end, beginIndex)
  if (beginIndex < 0 || endIndex < 0) throw Error('conversation_page_conversion_reference_missing')
  const originalTable = prefix + 'page_delivery_original_sources'
  const earlyRenderer = prefix + 'page_delivery_early_body'
  const converted = ['native_conversation_compiled_frame_pair', 'native_conversation_frame_requirement_input']
  const candidates = converted.map(literal).join(',')
  const compiled = converted[0] + '(uuid,uuid)'
  let early = sql.slice(beginIndex,endIndex)
  const reference = "  SELECT * INTO STRICT reference FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=spec->>'referenceName';"
  early = once(early, reference, reference + `
  IF spec->>'name' IN(${candidates}) THEN
   INSERT INTO pg_temp.${originalTable} VALUES((spec->>'name')||'(uuid,uuid)',reference.prosrc);
  END IF;`)
  const compare = "  IF (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM "
  const owner = '\n   OR actual.proowner<>owner_id'
  const first = early.indexOf(compare)+compare.length, last = early.indexOf(owner,first)
  if (first < compare.length || last<0) throw Error('conversation_page_conversion_comparison_missing')
  const expected = early.slice(first,last)
  const additions = `CASE WHEN spec->>'name' IN(${candidates}) THEN jsonb_build_object('prosrc',
    pg_temp.${earlyRenderer}((spec->>'name')||'(uuid,uuid)',jsonb_build_array(
      CASE WHEN spec->>'name'=${literal(converted[0])} THEN pg_temp.${prefix}record_direct_source_body(${literal(compiled)},jsonb_build_array(reference.prosrc),true)
        ELSE reference.prosrc END),true)) ELSE '{}'::jsonb END`
  early = early.slice(0,first)+'('+expected+'||'+additions+')'+early.slice(last)
  sql = sql.slice(0,beginIndex)+`CREATE TEMP TABLE ${originalTable}(signature text PRIMARY KEY,body text NOT NULL) ON COMMIT DROP;\n`
    +pageFrameRenderer(earlyRenderer,prefix+'record_plain_body')+'\n'+early+sql.slice(endIndex)
  const seed = `CASE WHEN routine_signature=${literal(compiled)} THEN
   (SELECT p.body FROM pg_temp.${prefix}record_conversion_predecessor p) ELSE actual.prosrc END`
  sql = once(sql,seed,`CASE WHEN routine_signature IN(${converted.map(name=>literal(name+'(uuid,uuid)')).join(',')}) THEN
   (SELECT s.body FROM pg_temp.${originalTable} s WHERE s.signature=routine_signature) ELSE actual.prosrc END`)
  const originalBodyCheck = "(expected->>'signature') NOT IN("
  sql = once(sql, originalBodyCheck, originalBodyCheck + Object.keys(pageFrameChanges).map(literal).join(',') + ',')
  // The earlier fused guard pins the pre-successor peer. Verify that
  // version from its archived parts and the actual body through the full
  // successor renderer.
  const fused = sql.indexOf("WHERE p.oid IS NULL OR encode(sha256(convert_to(regexp_replace(regexp_replace(CASE WHEN x.signature=")
  const fallback = sql.indexOf('  ELSE p.prosrc END,',fused)
  if (fused<0 || fallback<0) throw Error('conversation_page_fused_source_missing')
  sql = sql.slice(0,fallback)+`  WHEN x.signature IN(${Object.keys(pageFrameChanges).map(literal).join(',')}) THEN
  pg_temp.${predecessorRenderer}(x.signature,(SELECT parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=x.signature),true)
`+sql.slice(fallback)
  const receipt = 'SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8310_publication_expected_current)::text'
  sql = once(sql, receipt, proof + '\n' + receipt)
  const start = sql.indexOf(receipt)
  sql = sql.slice(0, start) + once(sql.slice(start), "::text,'UTF8')),'hex') local_digest,",
    "::text||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE \"C\") FROM pg_proc p JOIN pg_temp.page_delivery_reviewed_oids r USING(oid))::text,'UTF8')),'hex') local_digest,")
  sql = once(sql, ')::int functions,', '+' + roster.length + ')::int functions,').replaceAll(prefix, installedPrefix)
  assertAuthenticationReadOnly(sql)
  const cleanup = (previous.cleanup + `\nDROP FUNCTION pg_temp.${predecessorRenderer}(text,jsonb,boolean);
DROP FUNCTION pg_temp.${earlyRenderer}(text,jsonb,boolean);
DO $page_delivery_cleanup$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure identity FROM pg_proc p WHERE p.pronamespace=pg_my_temp_schema()
  AND p.proname=ANY(ARRAY[${roster.map((_, i) => literal('page_delivery_reviewed_' + i)).join(',')}])
 LOOP EXECUTE 'DROP FUNCTION '||f.identity;END LOOP;
END $page_delivery_cleanup$;`).replaceAll(prefix, installedPrefix)
  return { ...previous, sql, cleanup, functions: previous.functions + roster.length, sourceDigest: hash(migration), migrationSha: hash(migration) }
}
