/** [COMP:crm/assurance-fixture] Maintained canonical runtime, never ACL cloning. */
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Both maintained fixture callers use these fixed phases. No arbitrary role or target.
export async function runtimeRoleSql(phase, { role = 'app_user', password } = {}) {
  if (role !== 'app_user') throw new Error('Unsupported fixture runtime role; use app_user')
  if (!['prepare', 'transition', 'activate', 'verify'].includes(phase)) throw new Error('Unknown runtime installer phase')
  if (phase === 'activate' && password !== 'fixture-only' && !/^[a-f0-9]{64}$/.test(password ?? '')) throw new Error('Unsafe runtime password')
  const source = await readFile(new URL('../rig-admin-role.sql', import.meta.url), 'utf8')
  const sections = new Map([...source.matchAll(/^-- phase: (\w+)\n([\s\S]*?)(?=^-- phase: |$(?![\s\S]))/gm)].map(match => [match[1], match[2]]))
  if (sections.size !== 5 || !sections.has('safety') || !sections.has(phase)) throw new Error('Maintained runtime installer structure changed')
  const body = phase === 'prepare' ? sections.get(phase) + sections.get('safety') : sections.get('safety') + sections.get(phase)
  return 'BEGIN;\n' + body.replaceAll('__RUNTIME_PASSWORD__', password ?? '') + '\nCOMMIT;\n'
}
export async function prepareRuntimeRole(connection) {
  await connection.query(await runtimeRoleSql('prepare'))
}
export async function activateRuntimeRole(connection, options) {
  await connection.query(await runtimeRoleSql('activate', options))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runtimeRoleSql(process.argv[2], { password: process.argv[2] === 'activate' ? 'fixture-only' : undefined })
    .then(sql => process.stdout.write(sql)).catch(error => { console.error(error.message); process.exitCode = 1 })
}
