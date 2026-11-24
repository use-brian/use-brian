// [COMP:api/portable-restore] Authenticate the bounded derivation parent lookup.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as predecessor, ordinalEdgesClassification } from './installation-authentication-8350.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

export const migration = '8351_scope_derivation_parent_lookup.sql'
const migrationSha = '61175a111c14dc7e2396cfb0fe567d3b3389b9bd78a98872c7f8cf606ce1a38b'
const dispatcher = 'application_native_source_edges_dispatch(uuid,text,uuid,text)'
const lineage = 'application_scope_lineage(uuid,text[],uuid[],text[])'
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"

export function derivationParentClassification(classification) {
  const previous = ordinalEdgesClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('scope_derivation_lookup_authentication_anchor_changed')
  return source.replace(before, () => after)
}

function derivationVerifier(sql, numbered) {
  const edits = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\s*\$after\$([\s\S]*?)\$after\$/g)]
  const beforeSha = numbered.match(/dispatch_before_sha constant text:='([0-9a-f]{64})'/)?.[1]
  const afterSha = numbered.match(/dispatch_after_sha constant text:='([0-9a-f]{64})'/)?.[1]
  if (edits.length !== 1 || !beforeSha || !afterSha) throw Error('scope_derivation_lookup_authentication_source_changed')
  const [, before, after] = edits[0]
  const header = 'CREATE FUNCTION pg_temp.a8314_conversion_source_body(signature text,parts jsonb,successor boolean)'
  const tail = ' RETURN body; END $private_page_body$;'
  const start = sql.indexOf(header)
  const finish = sql.indexOf(tail, start)
  if (start < 0 || finish < start || sql.indexOf(header, start + header.length) >= 0)
    throw Error('scope_derivation_lookup_authentication_renderer_changed')
  // Keep the original dispatcher body in the source template and independently
  // reconstruct the successor used by the current catalog check.
  const render = `
 IF signature=${literal(dispatcher)} AND successor THEN
  marker:=${literal(before)};
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${literal(beforeSha)}
   OR (length(body)-length(replace(body,marker,'')))/length(marker)<>4
  THEN RAISE EXCEPTION 'scope_derivation_lookup_authentication_predecessor_changed';END IF;
  body:=replace(body,marker,${literal(after)});
  IF encode(sha256(convert_to(body,'UTF8')),'hex')<>${literal(afterSha)}
  THEN RAISE EXCEPTION 'scope_derivation_lookup_authentication_successor_changed';END IF;
 END IF;
 IF signature=${literal(lineage)} AND successor THEN
  DECLARE projection jsonb; before_pin text; after_pin text;
  BEGIN
   SELECT template INTO STRICT projection FROM pg_temp.a8314_publication_historical_projections
    WHERE identity=${literal(dispatcher)};
   before_pin:=encode(sha256(convert_to(pg_temp.a8314_publication_json(projection)::text,'UTF8')),'hex');
   projection:=jsonb_set(projection,'{body}',to_jsonb(pg_temp.a8314_conversion_source_body(
    ${literal(dispatcher)},jsonb_build_array(projection->>'body'),true)));
   after_pin:=encode(sha256(convert_to(pg_temp.a8314_publication_json(projection)::text,'UTF8')),'hex');
   marker:=format('(%s::oid,%L::text)',to_regprocedure(${literal('public.' + dispatcher)})::oid,before_pin);
   IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
    OR (length(body)-length(replace(body,${literal(beforeSha)},'')))/64<>1
   THEN RAISE EXCEPTION 'scope_derivation_lookup_authentication_fingerprint_changed';END IF;
   body:=replace(replace(body,marker,format('(%s::oid,%L::text)',
    to_regprocedure(${literal('public.' + dispatcher)})::oid,after_pin)),${literal(beforeSha)},${literal(afterSha)});
  END;
 END IF;
`
  // The first pass still verifies metadata and ACLs. The final pass compares
  // the dispatcher against its rendered successor, like the surrounding pins.
  const skipBody = `'read_scope_source_before_knowledge_binding(uuid,text,uuid)') AND (actual.prosrc COLLATE "C")`
  return replaceOnce(sql.slice(0, finish) + render + sql.slice(finish), skipBody,
    `${literal(dispatcher)},${skipBody}`)
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
  ])
  if (sha(numbered) !== migrationSha) throw Error('scope_derivation_lookup_migration_changed')
  const sql = `SET LOCAL search_path=pg_catalog;
DO $scope_derivation_lookup_index$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_index i
  WHERE i.indexrelid=to_regclass('public.application_field_observation_sources_by_resource')
   AND i.indrelid='public.application_field_observation_sources'::regclass
   AND i.indisvalid AND i.indisready AND i.indislive
   AND pg_get_indexdef(i.indexrelid)='CREATE INDEX application_field_observation_sources_by_resource ON public.application_field_observation_sources USING btree (workspace_id, resource_id, version)')
 THEN RAISE EXCEPTION 'scope_derivation_lookup_index_changed';END IF;
END $scope_derivation_lookup_index$;
` + derivationVerifier(previous.sql, numbered)
  assertAuthenticationReadOnly(sql)
  return {
    ...previous, sql, migrationSha,
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
