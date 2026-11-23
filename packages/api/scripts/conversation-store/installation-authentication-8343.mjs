// [COMP:api/portable-restore] Verify both conversation capture functions using
// their original source contracts, including installation-local guard slots.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'
import { assertAuthenticationReadOnly } from './installation-authentication-8315.mjs'
import { currentInstallationAuthenticationSource as predecessor, memoryHistoryClassification } from './installation-authentication-8342.mjs'

const migration = '8343_conversation_capture_linear_aggregation.sql'
const sha = text => createHash('sha256').update(text).digest('hex')
const encoded = text => JSON.stringify(text).slice(1, -1).replaceAll("'", "''")
const guardSlot = '__CAPTURE_GUARD_FINGERPRINT__'

export function captureClassification(classification) {
  const previous = memoryHistoryClassification(classification)
  return { ...previous, ledgerCount: previous.ledgerCount + 1 }
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, original, numbered] = await Promise.all([
    predecessor({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', '8269_canonical_conversation_publication.sql'), 'utf8'),
    readFile(resolve(sourceRoot, 'migrations', migration), 'utf8'),
  ])
  const migrationSha = sha(numbered)
  if (migrationSha !== '82fd79155830472c4bece33751bbb7137eb813740b1437e7223ecb0552b2199c') throw Error('conversation_capture_migration_changed')
  const replacements = [...numbered.matchAll(/\$before\$([\s\S]*?)\$before\$,\s*\$after\$([\s\S]*?)\$after\$/g)]
  const used = new Set()
  let sql = previous.sql
  for (const name of ['capture_conversation_selection', 'capture_conversation_query']) {
    const definition = original.split('CREATE OR REPLACE FUNCTION public.' + name + '(')
    if (definition.length !== 2) throw Error('conversation_capture_original_missing')
    const body = definition[1].split('AS $function$')[1].split('$function$;')[0]
    for (const part of body.split(guardSlot)) {
      let updated = part
      for (const replacement of replacements) {
        const [, before, after] = replacement
        if (!updated.includes(before)) continue
        if (used.has(replacement) || updated.split(before).length !== 2) throw Error('conversation_capture_delta_ambiguous')
        used.add(replacement)
        updated = updated.replace(before, () => after)
      }
      if (updated === part) continue
      const reference = encoded(part)
      if (sql.split(reference).length !== 2) throw Error('conversation_capture_reference_changed')
      sql = sql.replace(reference, () => encoded(updated))
    }
  }
  if (!used.size || used.size !== replacements.length) throw Error('conversation_capture_delta_missing')
  assertAuthenticationReadOnly(sql)
  return { ...previous, sql, migrationSha,
    portableSuccessor: { ...previous.portableSuccessor, migrations: [...previous.portableSuccessor.migrations, migration] },
    sourceDigest: sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, verifier: sha(sql) })),
  }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
