/**
 * `brian-app lint` — the CI gate for a custom Home app repo.
 *
 * Runs the SAME validator the import path runs (that is the point of this
 * package existing), so a repo that lints clean here imports cleanly, and a
 * repo that does not fails in CI rather than at install time in front of an
 * admin who is being asked to grant it scopes.
 *
 * Exit codes: 0 clean (advisory findings still print), 1 schema violation.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  MANIFEST_FILENAME,
  contentTypeFor,
  lintBundle,
  validateBundle,
  type BundleFile,
} from './index.js'

/** Directories that are never part of a bundle. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.github', '.next'])

function walk(root: string, dir = root, out: BundleFile[] = []): BundleFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, full, out)
    } else if (entry.isFile()) {
      out.push({
        path: relative(root, full).split(sep).join('/'),
        bytes: statSync(full).size,
      })
    }
  }
  return out
}

function main(): void {
  const root = process.argv[2] ?? process.cwd()

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(readFileSync(join(root, MANIFEST_FILENAME), 'utf8'))
  } catch (err) {
    console.error(`✗ ${MANIFEST_FILENAME}: ${(err as Error).message}`)
    process.exit(1)
  }

  // Filter to bundle assets, exactly as the GitHub import does. A repo
  // CONTAINS a bundle; README/LICENSE/CI config are repo furniture. If the CLI
  // and the importer disagreed about this, CI green would mean nothing.
  const files = walk(root).filter(
    (f) => f.path === MANIFEST_FILENAME || contentTypeFor(f.path) !== null,
  )
  const result = validateBundle({ files, manifestJson })
  if (!result.ok) {
    console.error(`✗ ${result.issues.length} problem(s):\n`)
    for (const issue of result.issues) {
      console.error(`  ${issue.path || '(bundle)'} — ${issue.message}`)
    }
    process.exit(1)
  }

  const findings = lintBundle({ files: result.files, manifest: result.manifest })
  for (const f of findings) {
    console.log(`  warning: ${f.path || '(bundle)'} — ${f.message}`)
  }
  console.log(
    `✓ ${result.manifest.name} — ${result.files.length} file(s), ` +
      `${Math.round(result.totalBytes / 1024)} KB, scopes.data=${result.manifest.scopes.data}` +
      // The store tier is the more consequential grant of the two — it reaches
      // money and a public storefront — so a summary that named only the brain
      // scope would understate what this bundle is asking for.
      (result.manifest.scopes.store && result.manifest.scopes.store !== 'none'
        ? `, scopes.store=${result.manifest.scopes.store}`
        : '') +
      (result.manifest.scopes.agent === 'ask' ? ', scopes.agent=ask' : '') +
      (findings.length > 0 ? ` (${findings.length} advisory)` : ''),
  )
}

main()
