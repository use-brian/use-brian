// [COMP:api/conversation-visibility] Read-only provider publication profile.
import { createHash } from 'node:crypto'
import { assertAuthenticationReadOnly as previousReadOnly } from './page-delivery-authentication.mjs'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'
import { channelPublicationPredecessor, channelPublicationSectionEnd, channelPublicationSectionStart,
  reviewedChannelPublication } from './build-conversation-verified-channel-publication.mjs'

const previousPrefix = 'a8311_'
const prefix = 'a8312_'
const owner = 'pin_verified_channel_conversation_append'
const args = '(uuid,uuid,uuid,uuid,text,text,boolean,boolean,bigint,uuid,uuid)'
const review = 'verified_channel_publication_reviewed'
const literal = value => "'" + value.replaceAll("'", "''") + "'"
const hash = value => createHash('sha256').update(value).digest('hex')

function once(source,before,after) {
  if (source.split(before).length!==2) throw Error('verified_channel_publication_profile_changed')
  return source.replace(before,()=>after)
}

export function assertAuthenticationReadOnly(sql) {
  previousReadOnly(sql.replaceAll(prefix,previousPrefix))
}

export async function verifiedChannelPublicationInstallationSource(migration,options) {
  const [previous,source] = await Promise.all([channelPublicationPredecessor(options),reviewedChannelPublication()])
  if (migration.split(channelPublicationSectionStart).length!==2 || migration.split(channelPublicationSectionEnd).length!==2
    || !migration.includes(channelPublicationSectionStart+source+channelPublicationSectionEnd))
    throw Error('verified_channel_publication_definition_changed')
  const reference=once(receivingOwnerDeclaration(source,owner),'CREATE FUNCTION public.'+owner,'CREATE FUNCTION pg_temp.'+review)
  const proof=`DO $verified_channel_publication_reference$ BEGIN
 EXECUTE ${literal(reference)};
END $verified_channel_publication_reference$;
DO $verified_channel_publication_catalog$
DECLARE actual pg_proc;reviewed pg_proc;owner_id oid;app_id oid;
BEGIN
 SELECT relowner INTO STRICT owner_id FROM pg_class WHERE oid='public.sessions'::regclass;
 SELECT oid INTO STRICT app_id FROM pg_roles WHERE rolname='app_user';
 SELECT * INTO STRICT reviewed FROM pg_proc WHERE oid='pg_temp.${review}${args}'::regprocedure;
 SELECT * INTO actual FROM pg_proc WHERE oid=to_regprocedure('public.${owner}${args}');
 IF actual.oid IS NULL OR actual.proowner<>owner_id
  OR actual.proacl IS DISTINCT FROM ARRAY[makeaclitem(owner_id,owner_id,'EXECUTE',false),makeaclitem(app_id,owner_id,'EXECUTE',false)]
  OR (to_jsonb(actual)-ARRAY['oid','proname','pronamespace','proacl']) IS DISTINCT FROM
     (to_jsonb(reviewed)-ARRAY['oid','proname','pronamespace','proacl'])
 THEN RAISE EXCEPTION 'verified_channel_publication_function_changed';END IF;
END $verified_channel_publication_catalog$;`
  const receipt='SELECT encode(sha256(convert_to((SELECT jsonb_agg(metadata ORDER BY signature COLLATE "C") FROM pg_temp.'+previousPrefix+'publication_expected_current)::text'
  let sql=once(previous.sql,receipt,proof+'\n'+receipt+`||(SELECT to_jsonb(p) FROM pg_proc p WHERE p.oid='public.${owner}${args}'::regprocedure)::text`)
  sql=once(sql,')::int functions,','+1)::int functions,').replaceAll(previousPrefix,prefix)
  assertAuthenticationReadOnly(sql)
  const cleanup=(previous.cleanup+`\nDROP FUNCTION pg_temp.${review}${args};`).replaceAll(previousPrefix,prefix)
  return {...previous,sql,cleanup,functions:previous.functions+1,sourceDigest:hash(migration),migrationSha:hash(migration)}
}
