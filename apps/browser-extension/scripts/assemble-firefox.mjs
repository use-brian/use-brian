/** Assemble the unpacked Firefox extension beside the Chromium build. */
import { cpSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSourceHash } from './build-hash.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, 'dist-firefox')
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

// Replace package re-export shims with browser-loadable shared modules.
for (const name of ["executor", "snapshot", "dom-settle", "action-cursor", "fill-form", "tab-eligibility", "relay-client", "protocol"]) {
  cpSync(join(root, '../../packages/browser-control/dist', `${name}.js`), join(output, `${name}.js`))
}
