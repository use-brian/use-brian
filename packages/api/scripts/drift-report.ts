/**
 * One-shot script: prints the Drift Sweep audit findings on the current
 * checkout. Used to capture the Wave 1 audit deliverable in the PR
 * description and the admin-ui-revamp build-order note.
 *
 * Usage: pnpm --filter @use-brian/api exec tsx scripts/drift-report.ts
 *
 * The migration drift section needs a populated `_migrations` table to
 * be interesting — without DB access it falls back to filesystem-only
 * analysis (duplicate prefixes, etc.).
 */

import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeConnectorToolDriftFromRegistries } from '../src/mcp/drift.ts'
import { computeMigrationDrift } from '../src/db/migration-drift.ts'

async function main() {
  console.log('# Drift Sweep — audit on this checkout\n')

  const ctd = computeConnectorToolDriftFromRegistries()
  console.log('## Connector-tool drift\n')
  console.log(`generatedAt: ${ctd.generatedAt}`)
  console.log(`summary:`, ctd.summary)
  for (const c of ctd.connectors) {
    console.log(`\n[${c.status.toUpperCase()}] ${c.connectorId} (${c.displayName}) — ${c.injectionMode}`)
    console.log(`  registered: ${c.registered.length}`)
    console.log(`  injected:   ${c.injected.length}`)
    if (c.silentInvisible.length > 0) {
      console.log(`  silent-invisible (${c.silentInvisible.length}):`)
      for (const t of c.silentInvisible) console.log(`    - ${t}`)
    }
    if (c.orphan.length > 0) {
      console.log(`  orphan (${c.orphan.length}):`)
      for (const t of c.orphan) console.log(`    - ${t}`)
    }
  }

  console.log('\n## Migration drift (filesystem-only — no DB)\n')
  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsDir = resolve(join(here, '..', 'migrations'))
  const filesOnDisk = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'))
  const md = computeMigrationDrift({ filesOnDisk, applied: [] })
  console.log(`generatedAt: ${md.generatedAt}`)
  console.log(`counts:`, md.counts)
  if (md.duplicatePrefixes.length > 0) {
    console.log('\nduplicate prefixes:')
    for (const d of md.duplicatePrefixes) {
      console.log(`  [${d.sanctioned ? 'sanctioned' : 'UNSANCTIONED'}] ${d.prefix}: ${d.files.join(', ')}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
