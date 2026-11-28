// [COMP:api/portable-restore] Authenticate the ordered generic proof collector.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as predecessor, recordingChannelLockClassification } from './installation-authentication-8353.mjs'
import { genericSignature } from './fused-admission.mjs'

export const migration = '8354_conversation_evidence_collect.sql'
const migrationSha = '7d61be0333edb3b6e163eb17e658d07c2f540de141bdf92c10cfca585b8c481c'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const literal = value => "'" + value.replaceAll("'", "''") + "'"

export function conversationEvidenceCollectionClassification(classification) {
  const previous = recordingChannelLockClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

function updateVerifier(sql, numbered) {
  const replacements = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\s*\$after\$([\s\S]*?)\$after\$/g)]
  const header = 'CREATE FUNCTION pg_temp.a8314_conversion_source_body(signature text,parts jsonb,successor boolean)'
  const tail = ' RETURN body; END $private_page_body$;'
  const start = sql.indexOf(header)
  const finish = sql.indexOf(tail, start)
  if (start < 0 || finish < start || sql.indexOf(header, start + header.length) >= 0 || replacements.length !== 6)
    throw Error('conversation_evidence_collection_renderer_changed')
  const edits = replacements.map(([, before, after]) => `
  marker:=${literal(before)};
  IF (length(body)-length(replace(body,marker,'')))/length(marker)<>1
  THEN RAISE EXCEPTION 'conversation_evidence_collection_marker_changed: %',left(marker,120);END IF;
  body:=replace(body,marker,${literal(after)});`).join('')
  return sql.slice(0, finish) +
    ` IF signature=${literal(genericSignature)} AND successor THEN${edits}\n END IF;\n` +
    sql.slice(finish)
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
  ])
  if (sha(numbered) !== migrationSha) throw Error('conversation_evidence_collection_migration_changed')
  const sql = updateVerifier(previous.sql, numbered)
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
