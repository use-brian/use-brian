/** [COMP:crm/assurance-fixture] Exact maintained canonical/runtime ACL installation. */
import { readFile } from 'node:fs/promises'

// Both the shell rig and programmatic fixture execute this single maintained SQL contract.
export async function runtimeRoleSql(phase, { role, password } = {}) {
  const source = await readFile(new URL('../rig-admin-role.sql', import.meta.url), 'utf8')
  const parts = /^([\s\S]*?)\\if :prepare\n([\s\S]*?)\\else\n([\s\S]*?)\\endif\s*$/.exec(source)
  if (!parts) throw new Error('Maintained runtime installer structure changed')
  if (phase === 'prepare') return parts[2]
  if (phase !== 'converge' || !/^[a-z][a-z0-9_]{0,62}$/.test(role ?? '') || !/^[a-f0-9]{64}$/.test(password ?? '')) throw new Error('Unsafe runtime role installer arguments')
  return parts[3].replaceAll('admin_fixture_app', role).replaceAll("'fixture-only'", "'" + password + "'")
}

export async function prepareRuntimeRole(connection) {
  await connection.query(await runtimeRoleSql('prepare'))
}
export async function convergeRuntimeRole(connection, options) {
  await connection.query(await runtimeRoleSql('converge', options))
}
