/** Assemble the unpacked Firefox extension beside the Chromium build. */
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSourceHash } from './build-hash.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const compiled = join(root, 'dist')
const output = join(root, 'dist-firefox')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

// Hand-maintained, and load-bearing: a module imported by anything below but
// missing from this list is not a type error and not a test failure — the
// Firefox extension simply fails to load at runtime. Add to it whenever a
// firefox-* module gains an import.
const runtimeFiles = [
  'build-info.js',
  'firefox-allow.js',
  'firefox-background.js',
  'firefox-native-client.js',
  'firefox-popup.js',
  'pairing.js',
  'popup-status.js',
  'protocol.js',
  'relay-client.js',
  'tab-eligibility.js',
  'task-gate.js',
]
for (const file of runtimeFiles) cpSync(join(compiled, file), join(output, file))
for (const file of readdirSync(join(root, 'static-firefox'))) {
  cpSync(join(root, 'static-firefox', file), join(output, file), { recursive: true })
}

// Same fingerprint as the Chromium build: both are cut from the same source,
// and a Firefox install that reports a different hash would read as stale.
const build = computeSourceHash(root)
writeFileSync(
  join(output, 'build-info.json'),
  `${JSON.stringify({ build, builtAt: new Date().toISOString() }, null, 2)}\n`,
)

console.log(`firefox extension assembled at apps/browser-extension/dist-firefox - build ${build}`)
