// [COMP:api/conversation-visibility] Read-only public receiving attestation.
import { createHash } from 'node:crypto'
import { currentInstallationAuthenticationSource as previousSource, assertAuthenticationReadOnly } from './installation-authentication-8309.mjs'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { publicReceivingSectionEnd, publicReceivingSectionStart, reviewedPublicConversationReceiving } from './build-conversation-public-receiving.mjs'

const roster = [
  { name: 'classify_conversation_envelope', exposed: false },
  { name: 'public_conversation_session_current', exposed: false },
  { name: 'pin_public_member_conversation_publication', exposed: true },
  { name: 'read_public_conversation_history', exposed: false },
]
const hash = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('public_receiving_profile_source_changed')
  return source.replace(before, () => after)
}

export async function publicReceivingInstallationSource(migration, options) {
  const [previous, { source }] = await Promise.all([previousSource(options), reviewedPublicConversationReceiving(options)])
  if (migration.split(publicReceivingSectionStart).length !== 2 || migration.split(publicReceivingSectionEnd).length !== 2
    || !migration.includes(publicReceivingSectionStart + source + publicReceivingSectionEnd))
    throw Error('public_receiving_profile_definition_changed')
  const names = [...source.matchAll(/^CREATE (?:OR REPLACE )?FUNCTION public\.([a-z_]+)\(/gm)].map(match => match[1])
  if (JSON.stringify(names) !== JSON.stringify(roster.map(({ name }) => name))
    || [...source.matchAll(/^GRANT /gm)].length !== 1
    || !source.includes('GRANT EXECUTE ON FUNCTION public.pin_public_member_conversation_publication(uuid,jsonb,uuid,text,text,uuid,bigint,uuid) TO app_user;'))
    throw Error('public_receiving_profile_roster_changed')
  const references = roster.map(({ name }, index) => receivingOwnerDeclaration(source, name)
    .replace(/^CREATE (?:OR REPLACE )?FUNCTION public\.[a-z_]+/, 'CREATE FUNCTION pg_temp.public_receiving_reviewed_' + index))
  const proof = `DO $public_receiving_references$ BEGIN
${references.map(reference => ' EXECUTE ' + literal(reference) + ';').join('\n')}
END $public_receiving_references$;
CREATE TEMP TABLE public_receiving_reviewed_oids(oid oid PRIMARY KEY) ON COMMIT DROP;
DO $public_receiving_catalog$
DECLARE item record;actual pg_proc;reviewed pg_proc;
 owner_id oid:=(SELECT relowner FROM pg_class WHERE oid='public.sessions'::regclass);
 app_id oid:=(SELECT oid FROM pg_roles WHERE rolname='app_user');
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ${roster.map(({ name, exposed }, i) => `(${literal(name)},${literal('public_receiving_reviewed_' + i)},${exposed})`).join(',')}
 ) declarations(name,reference,exposed) LOOP
  SELECT * INTO STRICT reviewed FROM pg_proc WHERE pronamespace=pg_my_temp_schema() AND proname=item.reference;
  SELECT * INTO actual FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=item.name AND proargtypes=reviewed.proargtypes;
  IF actual.oid IS NULL OR actual.proowner<>owner_id
   OR actual.proacl IS DISTINCT FROM (CASE WHEN item.exposed THEN
    ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
   ELSE ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false)] END)
   OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
    (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
  THEN RAISE EXCEPTION 'public_receiving_function_changed: %',item.name;END IF;
  INSERT INTO pg_temp.public_receiving_reviewed_oids VALUES(actual.oid);
 END LOOP;
END $public_receiving_catalog$;`
  const start = 'SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.a8309_publication_expected_current)::text'
  let sql = once(previous.sql, start, proof + '\n' + start)
  const receipt = sql.indexOf(start)
  sql = sql.slice(0, receipt) + once(sql.slice(receipt), "::text,'UTF8')),'hex') local_digest,",
    "::text||(SELECT jsonb_agg(to_jsonb(p) ORDER BY p.oid::regprocedure::text COLLATE \"C\") FROM pg_proc p JOIN pg_temp.public_receiving_reviewed_oids r USING(oid))::text,'UTF8')),'hex') local_digest,")
  sql = once(sql, ')::int functions,', '+' + roster.length + ')::int functions,')
  sql = sql.replaceAll('a8309_', 'a8310_')
  assertPublicReceivingAuthenticationReadOnly(sql)
  const cleanup = previous.cleanup + `
DO $public_receiving_cleanup$ DECLARE f record;BEGIN
 FOR f IN SELECT p.oid::regprocedure identity FROM pg_proc p WHERE p.pronamespace=pg_my_temp_schema()
  AND p.proname=ANY(ARRAY[${roster.map((_, i) => literal('public_receiving_reviewed_' + i)).join(',')}])
 LOOP EXECUTE 'DROP FUNCTION '||f.identity;END LOOP;
END $public_receiving_cleanup$;`
  return { ...previous, sql, cleanup: cleanup.replaceAll('a8309_', 'a8310_'), functions: previous.functions + roster.length,
    sourceDigest: hash(migration), migrationSha: hash(migration) }
}

export function assertPublicReceivingAuthenticationReadOnly(sql) {
  assertAuthenticationReadOnly(sql.replaceAll('a8310_', 'a8309_'))
}
