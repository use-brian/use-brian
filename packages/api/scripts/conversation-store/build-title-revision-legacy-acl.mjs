// [COMP:api/migration-owner-role] Generate the ordered historical prerequisite.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { buildTitleRevisionLegacyAclSql, migrationName } from './title-revision-legacy-acl.mjs'

const [mode, ...extra] = process.argv.slice(2)
if (extra.length || (mode && !['--check', '--print'].includes(mode))) {
  throw new Error('Use --check, --print, or no argument')
}
const folder = new URL('../../migrations/', import.meta.url)
const files = (await readdir(folder)).filter(file => file.endsWith('.sql'))
// Match the native and embedded runners' lexicographic order, including the underscore.
const ordered = [...new Set([...files, migrationName])].sort()
const position = ordered.indexOf(migrationName)
if (ordered[position - 1] !== '8285_owner_forced_rls_retirement.sql' ||
    ordered[position + 1] !== '8286_title_revision_admission.sql') {
  throw new Error('Title ACL prerequisite must run after 8285 and before 8286')
}
const sql = await buildTitleRevisionLegacyAclSql()
const output = new URL(migrationName, folder)
if (mode === '--print') process.stdout.write(sql)
else if (mode === '--check') {
  if (await readFile(output, 'utf8') !== sql) throw new Error(`${migrationName} needs regeneration`)
  console.log(`${migrationName} matches reviewed source`)
} else {
  await writeFile(output, sql, { flag: 'wx' })
  console.log(`Generated ${migrationName}`)
}
