// [COMP:api/portable-restore] Bind the owner-only workspace run dispatch queue.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { currentInstallationAuthenticationSource as previousSource } from './installation-authentication-8330.mjs'
import { authenticateCrmSuccessor } from './crm-release-catalog.mjs'

const migration = '8331_workspace_mcp_dispatch.sql'
const migrationSha = 'b293de989b928d722c0ca7d8e0049f2d4a8888d7c36fcd721589bde021e843f1'
const sha = value => createHash('sha256').update(value).digest('hex')
// Generated on the fresh ordinary-owner OSS chain. The catalog covers routine
// definitions and privileges, relation columns, indexes, constraints, policies
// and the enabled trigger on the protected run table.
const additionalCatalog = {
  scope: {
    functions: ['sync_workspace_mcp_dispatch'],
    tables: ['workspace_mcp_dispatch'],
    types: [],
    triggers: ['workspace_mcp_dispatch_sync'],
  },
  sha256: '5ac941829ecf9af93aad32c28bba7b0fa9500b66b9221816366f52dc2c28f425',
}

export async function currentInstallationAuthenticationSource({ sourceRoot = fileURLToPath(new URL('../../', import.meta.url)) } = {}) {
  const [previous, numbered] = await Promise.all([
    previousSource({ sourceRoot }),
    readFile(resolve(sourceRoot, 'migrations', migration)),
  ])
  if (sha(numbered) !== migrationSha) throw Error('workspace_mcp_dispatch_numbered_source_changed')
  const sourceDigest = sha(JSON.stringify({ predecessor: previous.sourceDigest, migrationSha, additionalCatalog }))
  return { ...previous, migrationSha, additionalCatalog, sourceDigest }
}

export async function authenticateConversationInstallation(owner, options) {
  return authenticateCrmSuccessor(owner, await currentInstallationAuthenticationSource(options))
}
