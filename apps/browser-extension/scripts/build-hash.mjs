/**
 * The extension's source fingerprint — the one thing that can answer "is the
 * build loaded in this browser the build this repo describes?"
 *
 * Why a content hash and not a version string: `static/manifest.json` sat at
 * `0.1.0` from the extension's first commit through every fix that followed,
 * including three that each mattered to a real user. A signal a human has to
 * remember to bump is a signal that rots, and this one rotted immediately. A
 * hash cannot be forgotten because nobody types it.
 *
 * THIS FILE IS THE ONLY IMPLEMENTATION. `scripts/assemble.mjs` imports it to
 * stamp `dist/build-info.json`, and the platform's `pnpm check` invariant
 * SHELLS OUT to it rather than reimplementing the algorithm — two
 * implementations of a hash agree right up until the day they don't, and the
 * disagreement would read as "your extension is stale" forever.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * What the build is made of. Tests are excluded on purpose: they change the
 * repo without changing a single byte Chrome loads, and flagging every
 * installed extension stale because a test gained a case would train people to
 * ignore the warning.
 */
function sourceFiles(appRoot) {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === '__tests__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (entry.endsWith('.ts')) files.push(full)
    }
  }
  walk(join(appRoot, 'src'))
  files.push(join(appRoot, 'static', 'manifest.json'))
  return files
}

/**
 * Path-and-content, folded in sorted order. Paths are POSIX-normalised and
 * hashed alongside the bytes so a pure rename still moves the fingerprint, and
 * so the result is identical on Windows.
 */
export function computeSourceHash(appRoot = APP_ROOT) {
  const fold = createHash('sha256')
  for (const file of sourceFiles(appRoot).sort()) {
    const rel = relative(appRoot, file).split(sep).join('/')
    const entry = createHash('sha256')
    entry.update(rel)
    entry.update('\0')
    entry.update(readFileSync(file))
    fold.update(entry.digest('hex'))
  }
  return fold.digest('hex').slice(0, 12)
}

// Run directly (`node scripts/build-hash.mjs`) to print the hash. This is the
// interface `pnpm check` consumes; keep it a bare hash on stdout.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(computeSourceHash())
}
