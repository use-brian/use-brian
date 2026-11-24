// [COMP:api/portable-restore] Verify the canonical envelope source aggregation.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { updateCaptureVerifier } from './capture-verifier.mjs'
import { currentInstallationAuthenticationSource as predecessor, captureClassification } from './installation-authentication-8343.mjs'

const migration = '8344_conversation_domain_source_aggregation.sql'
const sha = text => createHash('sha256').update(text).digest('hex')

export function envelopeClassification(classification) {
  const previous = captureClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, original, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', '8269_canonical_conversation_publication.sql'), 'utf8'),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
  ])
  const migrationSha = sha(numbered)
  if (migrationSha !== 'd8a089ede2a3c63dfff76ce4428048082e3c80173fb522f5cdcae8f8a542011c') throw Error('conversation_capture_migration_changed')
  const verifier = updateCaptureVerifier(previous.sql, original, numbered, ['conversation_dag_envelope'])
  // The fused reader independently authenticates its canonical counterpart.
  // Both source bodies contain no installation-local fingerprint or OID slots.
  const signature = 'conversation_dag_envelope(uuid,text,uuid,text,text[],jsonb,jsonb,jsonb[])'
  const pin = digest => `('${signature}','${digest}')`
  const originalPin = pin('68ae875f64e99ac4e2a672d17319abdd8c8bd4d6078928215263b718a6279905')
  if (verifier.split(originalPin).length !== 2) throw Error('conversation_envelope_canonical_pin_changed')
  const sql = verifier.replace(originalPin, pin('743bc7d7207e289e9916f899590d48852e6df696744ca5572c18684ddd198368'))
  return { ...previous, sql, migrationSha,
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
