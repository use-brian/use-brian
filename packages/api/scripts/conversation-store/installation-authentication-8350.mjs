// [COMP:api/portable-restore] Authenticate the canonical ordinal-edge evaluator.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { telegramKnowledgeClassification, telegramKnowledgeRelease } from './installation-authentication-8349.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { graphSignature } from './conversation-graph-set.mjs'

const migration = '8350_conversation_graph_ordinal_edges.sql'
const migrationSha = '2c7318fdbc1de6025346f698c8093ecbf5ef1293a2915067d14ecfcc287850ce'
const sha = value => createHash('sha256').update(value).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"

export function ordinalEdgesClassification(classification) {
  const previous = telegramKnowledgeClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

function graphVerifier(sql, numbered) {
  const replacements = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\s*\$after\$([\s\S]*?)\$after\$/g)]
  const header = 'CREATE FUNCTION pg_temp.a8314_conversion_source_body(signature text,parts jsonb,successor boolean)'
  const tail = ' RETURN body; END $private_page_body$;'
  const start = sql.indexOf(header)
  const finish = sql.indexOf(tail, start)
  if (start < 0 || finish < start || sql.indexOf(header, start + header.length) >= 0 || !replacements.length)
    throw Error('conversation_ordinal_edges_authentication_renderer_changed')
  const edits = replacements.map(([, before, after]) => `
  marker:=${literal(before)};
  IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  THEN RAISE EXCEPTION 'conversation_ordinal_edges_authentication_marker_changed: %',left(marker,120);END IF;
  body:=replace(body,marker,${literal(after)});`).join('')
  // Keep the fused verifier's independently authenticated historical graph.
  return sql.slice(0, finish) +
    ` IF signature=${literal(graphSignature)} AND successor THEN${edits}\n END IF;\n` +
    sql.slice(finish)
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    telegramKnowledgeRelease.currentInstallationAuthenticationSource({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
  ])
  if (sha(numbered) !== migrationSha) throw Error('conversation_ordinal_edges_migration_changed')
  const sql = graphVerifier(previous.sql, numbered)
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
