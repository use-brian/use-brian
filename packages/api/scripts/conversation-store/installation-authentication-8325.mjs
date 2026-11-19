// [COMP:api/portable-restore] Authenticate scoped CRM alongside conversation.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource as conversationSource } from './installation-authentication-8323.mjs'
import { currentOfficeSource, officeMigration } from './build-conversation-office-evidence.mjs'
import { authenticateCrmSuccessor, composeCrmSource, readPinnedCrmScope } from './crm-release-catalog.mjs'

const migrationSha = 'a7db1e872ecf75591b97c59a29ce35fab53f255a03f094d1cd16d529e008127e'
const sha = value => createHash('sha256').update(value).digest('hex')
const inventory = Object.freeze({
  scopeSha256: '49e4a5dd4a7e3ea61f89dcf3d541b4219b36d458885ef6194555e34db949cb08',
  sha256: '54091f0a92f7ed9c134522196ff8610ae78facc1fc55ed8fd67ba3cd5c6c185d',
  routines: 73,
  relations: 21,
  types: 1,
  triggers: 44,
})

export async function currentInstallationAuthenticationSource(options = {}) {
  const sourceRoot = options.sourceRoot ?? fileURLToPath(new URL('../../', import.meta.url))
  const [telegram, crmScope, migration] = await Promise.all([
    conversationSource({ sourceRoot }),
    readPinnedCrmScope(sourceRoot),
    readFile(resolve(sourceRoot,'migrations',officeMigration)),
  ])
  if (sha(migration) !== migrationSha) throw Error('installation_source_migration_changed')
  const conversation = currentOfficeSource(telegram)
  const sourceDigest = sha(JSON.stringify({ predecessor:telegram.sourceDigest, migrationSha }))
  return composeCrmSource({ ...conversation, sourceDigest, migrationSha }, inventory, crmScope)
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
