// [COMP:api/native-turn-frame] Generate the reviewed conversation evidence and lineage successor.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { contextCostReplacements, fusedPrivacyCostReplacements } from './conversation-context-cost.mjs'
import { lineageCostReplacements } from './conversation-memory-lineage-cost.mjs'
import { captureSignature, fusedMembers } from './fused-admission.mjs'
import { executableProjection } from './executable-record.mjs'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8331.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'

const migration = '8332_conversation_context_cost.sql'
const predecessor = '8331_workspace_mcp_dispatch.sql'
const defaultSourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const prefix = 'a8314_'
const priorRenderer = prefix + 'conversion_source_body'
const successorRenderer = 'conversation_context_cost_body'
const recordingSignature = 'recording_source_read_allowed(uuid,text,uuid)'
const lineageSignature = 'application_scope_lineage(uuid,text[],uuid[],text[])'
const fusedPrivacySignature = 'fused_f_privacy(uuid,jsonb)'
const memoryScopeSignature = 'read_scope_source_before_knowledge_binding(uuid,text,uuid)'
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2)
    throw Error('conversation_context_cost_installation_source_changed: ' + before.slice(0, 120))
  return source.replace(before, () => after)
}

const scopeTableCheck = "  IF tab IS NULL THEN RAISE EXCEPTION 'scope_evidence_missing'; END IF;"
// A Memory read uses the same resolved table, exact row lock and scope fields.
// The generic reader still owns other mappings and the other resource kinds.
const memoryScopeReplacements = [[scopeTableCheck, `${scopeTableCheck}
  IF p_kind='memory' AND tab='memories' THEN
    SELECT CASE WHEN m.scope_version IS NOT NULL THEN
      jsonb_build_object('workspaceId',m.workspace_id,'userId',m.user_id,'assistantId',m.assistant_id,
        'sensitivity',m.sensitivity,'compartments',m.compartments,'projectIds',m.project_ids,
        'resourceKind',p_kind,'resourceId',p_id,'version',m.scope_version::text,
        'held',m.scope_held,'validTo',m.valid_to,'retractedAt',m.retracted_at) END
    INTO row_json FROM public.memories m
    WHERE m.id=p_id AND coalesce(m.workspace_id=p_workspace,false) FOR SHARE;
    RETURN row_json;
  END IF;`]]

const replacements = [...contextCostReplacements, ...lineageCostReplacements, [memoryScopeSignature, memoryScopeReplacements],
  [fusedPrivacySignature, fusedPrivacyCostReplacements]]
const signatures = replacements.map(([signature]) => literal(signature)).join(',')
function renderReplacements(signature, replacements) {
  const edits = replacements.map(([before, after]) => `
  marker:=${literal(before)};
  IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  THEN RAISE EXCEPTION 'conversation_context_cost_body_marker_changed: %',left(marker,120);END IF;
  body:=replace(body,marker,${literal(after)});`).join('')
  return `IF signature=${literal(signature)} AND successor THEN${edits}
 END IF;`
}
const renderSuccessor = replacements.map(([signature, edits]) => renderReplacements(signature, edits)).join('\n ')

const fusedPrivacy = fusedMembers.find(member => member.name === 'fused_f_privacy')
if (!fusedPrivacy) throw Error('conversation_context_cost_fused_privacy_source_missing')
const fusedPrivacyBody = fusedPrivacyCostReplacements.reduce(
  (body, [before, after]) => replaceOnce(body, before, after), fusedPrivacy.body)
// The previous release compares this compiled member against a temporary
// reference. Add it to the propagation tables after that comparison succeeds.
const fusedPrivacyTemplate = `INSERT INTO pg_temp.${prefix}publication_expected_current
 SELECT ${literal(fusedPrivacySignature)},to_jsonb(p) FROM pg_catalog.pg_proc p
 WHERE p.oid=${literal('public.' + fusedPrivacySignature)}::regprocedure;
INSERT INTO pg_temp.${prefix}publication_successor_templates
 SELECT ${literal(fusedPrivacySignature)},jsonb_build_array(p.prosrc) FROM pg_catalog.pg_proc p
 WHERE p.oid=${literal('pg_temp.' + prefix + 'f_r_' + fusedPrivacySignature)}::regprocedure;`

// Some source routines also have older, normalized body pins in the compiled
// fused artifact. Continue checking the fused source against that historical
// input while the canonical verifier below checks both live successors.
function renderHistoricalFusedPins(sql) {
  const anchor = "  ELSE p.prosrc END,'[0-9a-f]{64}',repeat('0',64),'g')"
  const historicalSignatures = [
    'conversation_capture_privacy(uuid,jsonb)',
    lineageSignature,
    recordingSignature,
  ].filter(signature => replacements.some(([edited]) => signature === edited))
  if (historicalSignatures.length === 0) return sql
  return replaceOnce(sql, anchor, `  WHEN x.signature IN(${historicalSignatures.map(literal).join(',')}) THEN
  pg_temp.${priorRenderer}(x.signature,(SELECT parts FROM pg_temp.${prefix}publication_successor_templates WHERE signature=x.signature),false)
${anchor}`)
}

const displayPin = `DO $conversation_context_cost_display$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.private_session_display_contract d
  JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(d.signature)
  WHERE d.signature=${literal('public.' + lineageSignature)}
   AND d.fingerprint=encode(sha256(convert_to(to_jsonb(p)::text,'UTF8')),'hex'))
 THEN RAISE EXCEPTION 'conversation_context_cost_display_pin_changed';END IF;
END $conversation_context_cost_display$;
`

function reviewedAuthentication(previous) {
  const header = `CREATE FUNCTION pg_temp.${priorRenderer}(signature text,parts jsonb,successor boolean)`
  const tail = ' RETURN body; END $private_page_body$;'
  const start = previous.sql.indexOf(header)
  const finish = previous.sql.indexOf(tail, start)
  if (start < 0 || finish < start || previous.sql.indexOf(header, start + header.length) >= 0)
    throw Error('conversation_context_cost_authentication_renderer_changed')
  const rendered = previous.sql.slice(0, finish) +
    ' ' + renderSuccessor + '\n' + tail +
    previous.sql.slice(finish + tail.length)
  // The initial catalog pass verifies metadata and ACLs for these signatures.
  // Their bodies are checked against the rendered successor in verify_current.
  const bodyCheck = `AND (actual.prosrc COLLATE "C") IS DISTINCT FROM (body COLLATE "C"))`
  const tailSignature = literal('native_turn_frame_payload_shape(jsonb)')
  const deferred = replacements.map(([signature]) => signature)
    .filter(signature => signature !== captureSignature && signature !== fusedPrivacySignature)
  const current = replaceOnce(rendered, `${tailSignature}) ${bodyCheck}`,
    `${[tailSignature, ...deferred.map(literal)].join(',')}) ${bodyCheck}`)
  const marker = `SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $conversation_context_cost_receipt$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(migration)})
 THEN RAISE EXCEPTION 'conversation_context_cost_release_missing';END IF;
END $conversation_context_cost_receipt$;
`
  const fusedSuccessor = replaceOnce(current, literal(fusedPrivacy.body), literal(fusedPrivacyBody))
  const sql = marker + displayPin + renderHistoricalFusedPins(fusedSuccessor)
  assertAuthenticationReadOnly(sql)
  return sql
}

async function buildMigration(previous) {
  // These recipes ship with the verifier. The portable release directory
  // supplies numbered SQL and ledger aliases, never compiler code.
  const read = name => readFile(new URL(name, import.meta.url), 'utf8')
  const [consumers, installer] = await Promise.all([
    read('conversion-original-consumers.sql'),
    read('conversion-install.mjs'),
  ])
  const configure = sql => sql
    .replaceAll('publication_expected_current', prefix + 'publication_expected_current')
    .replaceAll('publication_successor_templates', prefix + 'publication_successor_templates')
    .replaceAll('pg_temp.conversion_source_body', 'pg_temp.' + successorRenderer)
  const start = installer.indexOf('DO $conversion_propagate$')
  const endMarker = 'END $conversion_propagate$;'
  const end = installer.indexOf(endMarker, start)
  if (start < 0 || end < start) throw Error('conversation_context_cost_propagation_source_missing')
  let propagate = configure(installer.slice(start, end + endMarker.length))
  // Only the changed owners and authenticated consumers of their fingerprints can
  // change. Unaffected definitions stay in the final full catalog comparison
  // with their original metadata, including amendments from later releases.
  propagate = replaceOnce(propagate,
    `SELECT t.signature,t.parts FROM ${prefix}publication_successor_templates t ORDER BY t.signature COLLATE "C"`,
    `SELECT t.signature,t.parts FROM ${prefix}publication_successor_templates t
   JOIN conversion_affected_functions a ON a.signature=t.signature ORDER BY t.signature COLLATE "C"`)
  propagate = replaceOnce(propagate, 'SET contract=after_row', 'SET contract=' + executableProjection('after_row'))
  propagate = replaceOnce(propagate, 'p IS DISTINCT FROM h.contract', executableProjection('p') + ' IS DISTINCT FROM h.contract')
  propagate = replaceOnce(propagate, 'to_jsonb(h.contract) IS DISTINCT FROM expected', 'h.contract IS DISTINCT FROM ' + executableProjection('actual'))
  const retainedPin = '   UPDATE native_retained_contract_helpers SET fingerprint=new_hash WHERE signature=routine.signature AND fingerprint=old_hash;'
  propagate = replaceOnce(propagate, retainedPin, `${retainedPin}
   IF EXISTS(SELECT 1 FROM public.private_session_display_contract WHERE signature='public.'||routine.signature) THEN
    UPDATE public.private_session_display_contract SET fingerprint=new_hash
     WHERE signature='public.'||routine.signature AND fingerprint=old_hash;
    IF NOT FOUND THEN RAISE EXCEPTION 'conversation_context_cost_display_pin_changed';END IF;
   END IF;`)
  const classify = replaceOnce(consumers, "WHERE signature IN('native_turn_helpers_current()','native_turn_publication_contract()');",
    `WHERE signature IN(${signatures});`)
  return `-- [COMP:api/native-turn-frame] Bound repeated work in native conversation evidence and lineage.
BEGIN;
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $conversation_context_cost_predecessor$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D')
  OR NOT EXISTS(SELECT 1 FROM public._migrations WHERE name=${literal(predecessor)})
 THEN RAISE EXCEPTION 'conversation_context_cost_predecessor_changed';END IF;
END $conversation_context_cost_predecessor$;
${previous.sql}
${displayPin}
${fusedPrivacyTemplate}
${configure(classify)}
DO $conversation_context_cost_sources$ BEGIN
 IF (SELECT count(*) FROM pg_temp.conversion_affected_functions WHERE signature IN(${signatures}))<>${replacements.length}
 THEN RAISE EXCEPTION 'conversation_context_cost_canonical_roster_changed';END IF;
END $conversation_context_cost_sources$;
CREATE FUNCTION pg_temp.${successorRenderer}(signature text,parts jsonb,successor boolean) RETURNS text
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $conversation_context_cost_body$
DECLARE body text:=pg_temp.${priorRenderer}(signature,parts,successor);marker text;
BEGIN
 ${renderSuccessor}
 RETURN body;
END $conversation_context_cost_body$;
${propagate}
DROP FUNCTION pg_temp.${successorRenderer}(text,jsonb,boolean);
${displayPin}
DO $conversation_context_cost_witness$ BEGIN
 IF public.native_turn_contract_witness_refresh() IS NOT TRUE OR public.native_turn_helpers_current() IS NOT TRUE
  OR public.native_turn_publication_contract() IS NOT TRUE OR public.native_retained_helpers_current() IS NOT TRUE
  OR public.native_conversation_conversion_contract() IS NOT TRUE
 THEN RAISE EXCEPTION 'conversation_context_cost_successor_witness_changed';END IF;
END $conversation_context_cost_witness$;
${previous.cleanup}
COMMIT;
`.replace(/^ +$/gm, '')
}

export async function currentConversationContextCostReleaseSource({ sourceRoot = defaultSourceRoot } = {}) {
  const previous = await previousSource({ sourceRoot })
  const path = resolve(sourceRoot, 'migrations', migration)
  const [numbered, expected] = await Promise.all([readFile(path, 'utf8'), buildMigration(previous)])
  if (numbered !== expected) throw Error('conversation_context_cost_numbered_source_changed')
  const sql = reviewedAuthentication(previous)
  const migrationSha = sha(numbered)
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, authenticationSha: sha(sql) }))
  return { ...previous, sql, sourceDigest, migrationSha }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, output, ...extra] = process.argv.slice(2)
  if (extra.length) throw Error('Use --candidate PATH or --check')
  if (mode === '--candidate' && output) {
    const previous = await previousSource({ sourceRoot: defaultSourceRoot })
    await writeFile(resolve(output), await buildMigration(previous), { flag: 'wx', mode: 0o600 })
  } else if (mode === '--check' && !output) await currentConversationContextCostReleaseSource()
  else throw Error('Use --candidate PATH or --check')
}
