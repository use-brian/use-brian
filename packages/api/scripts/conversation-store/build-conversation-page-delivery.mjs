// [COMP:api/page-thread-audience] Source-bound Page read and private frame identity.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { currentInstallationAuthenticationSource } from './installation-authentication-8310.mjs'
import { executableProjection } from './executable-record.mjs'
import { receivingOwnerDeclaration } from './build-conversation-receiving-owners.mjs'

const literal = value => "'" + value.replaceAll("'", "''") + "'"
const prefix = 'a8310_'
const previousRenderer = prefix + 'conversion_source_body'
const renderer = 'conversation_page_frame_body'
export const pageDeliverySectionStart = '-- BEGIN REVIEWED CONVERSATION PAGE DELIVERY\n'
export const pageDeliverySectionEnd = '-- END REVIEWED CONVERSATION PAGE DELIVERY'
export const pageDeliveryMigrationName = '8311_conversation_page_delivery.sql'

const originalUser = "n->>'userId' IS NOT NULL AND n->>'userId' IS DISTINCT FROM r.user_id::text"
const compatibleUser = `${originalUser}
   AND NOT (f.format=2 AND r.user_id IS NULL AND n->>'assistantId' IS NULL AND
    public.private_conversation_page_frame_source(w,r.session_id,n->>'resourceKind',(n->>'resourceId')::uuid,n->>'version',(n->>'userId')::uuid))`
const originalCompiledUser = 'n.user_id IS NOT NULL AND n.user_id IS DISTINCT FROM r.user_id'
export const pageFrameChanges = Object.freeze({
  'native_turn_frame_pair(uuid,uuid)': [originalUser, compatibleUser],
  'native_conversation_frame_requirement_input(uuid,uuid)': [originalUser, compatibleUser],
  'native_conversation_compiled_frame_pair(uuid,uuid)': [originalCompiledUser, `${originalCompiledUser}
   AND NOT (f.format=2 AND r.user_id IS NULL AND n.assistant_id IS NULL AND
    public.private_conversation_page_frame_source(w,r.session_id,n.kind,n.id,n.version,n.user_id))`],
})

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('conversation_page_source_changed: ' + before.slice(0, 80))
  return source.replace(before, () => after)
}

export function pageFrameRenderer(name, predecessor) {
  const clauses = Object.entries(pageFrameChanges).map(([signature, [before, after]]) =>
    `WHEN ${literal(signature)} THEN marker:=${literal(before)};
 IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'private_page_frame_source_changed: %',signature; END IF;
 body:=replace(body,marker,${literal(after)});`).join('\n')
  return `CREATE FUNCTION pg_temp.${name}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $private_page_body$
DECLARE body text:=pg_temp.${predecessor}(signature,parts,successor);marker text;
BEGIN CASE signature
${clauses}
ELSE NULL; END CASE; RETURN body; END $private_page_body$;`
}

export async function reviewedConversationPageDeliverySource() {
  const [frame, admission, page] = await Promise.all([
    'conversation-page-frame-source.sql', 'conversation-record-admission.sql', 'conversation-page-delivery.sql',
  ].map(file => readFile(new URL(file, import.meta.url), 'utf8')))
  const original = receivingOwnerDeclaration(admission, 'conversation_record_turn_facts')
  const named = once(original, 'CREATE FUNCTION public.conversation_record_turn_facts(',
    'CREATE FUNCTION public.conversation_page_turn_facts(')
  // Pin the Page in the original workspace/session/envelope lock order. The
  // pin already applies the same live member tier, once after the anchor locks.
  const pinned = once(named, 'public.conversation_member_read_current(w,sid,actor) IS NOT TRUE',
    "s.anchor_kind IS DISTINCT FROM 'doc_thread'\n  OR public.lock_conversation_member_read(w,sid,actor) IS NOT TRUE")
  return [frame, pinned,
    'REVOKE ALL ON FUNCTION public.conversation_page_turn_facts(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text) FROM PUBLIC,app_user;',
    page].join('\n')
}

async function pageFrameSuccessor() {
  const [consumers, installer] = await Promise.all(['conversion-original-consumers.sql','conversion-install.mjs']
    .map(file => readFile(new URL(file, import.meta.url), 'utf8')))
  const configure = source => source.replaceAll('publication_expected_current',prefix+'publication_expected_current')
    .replaceAll('publication_successor_templates',prefix+'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body','pg_temp.'+renderer)
  const begin = installer.indexOf('DO $conversion_propagate$')
  const end = installer.indexOf('END $conversion_propagate$;', begin)
  if (begin < 0 || end < 0) throw Error('conversation_page_propagation_source_changed')
  let propagate = configure(installer.slice(begin, end+'END $conversion_propagate$;'.length))
  propagate = once(propagate,'SET contract=after_row','SET contract='+executableProjection('after_row'))
  propagate = once(propagate,'p IS DISTINCT FROM h.contract',executableProjection('p')+' IS DISTINCT FROM h.contract')
  propagate = once(propagate,'to_jsonb(h.contract) IS DISTINCT FROM expected','h.contract IS DISTINCT FROM '+executableProjection('actual'))
  const signatures = Object.keys(pageFrameChanges).map(literal).join(',')
  return [
    configure(once(consumers,"WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
      `WHERE signature IN(${signatures});`)),
    pageFrameRenderer(renderer, previousRenderer), propagate,
    'DROP FUNCTION pg_temp.'+renderer+'(text,jsonb,boolean);',
  ].join('\n')
}

export async function buildConversationPageDeliveryCandidate(options = {}) {
  const [previous, page, successor] = await Promise.all([currentInstallationAuthenticationSource(options),
    reviewedConversationPageDeliverySource(), pageFrameSuccessor()])
  return `-- [COMP:api/page-thread-audience] Native Page turns and retained private Page frames.
BEGIN;
DO $page_delivery_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'page_delivery_unreviewed_ddl_trigger'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name='8310_conversation_public_receiving.sql') THEN
  RAISE EXCEPTION 'page_delivery_predecessor_missing'; END IF;
END $page_delivery_predecessor$;
${previous.sql}
${pageDeliverySectionStart}${page}${pageDeliverySectionEnd}
${successor}
DO $page_frame_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE THEN RAISE EXCEPTION 'private_page_frame_witness_changed'; END IF;
END $page_frame_witness$;
${previous.cleanup}
COMMIT;
`
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const [option, target, ...rest] = process.argv.slice(2)
  if (option !== '--candidate' || !target || rest.length) throw Error('Use --candidate PATH')
  await writeFile(resolve(target),await buildConversationPageDeliveryCandidate(),{mode:0o600,flag:'wx'})
}
