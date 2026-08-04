/**
 * Assemble the unpacked extension: dist/ holds the tsc output; copy the
 * static assets (manifest + pages) beside it so `dist/` loads directly via
 * chrome://extensions "Load unpacked".
 *
 * Also stamps `dist/build-info.json`. The stamp is what makes a stale install
 * visible: the extension reports it to the relay on hello, the popup shows it,
 * and the assistant can name it as the cause instead of paraphrasing whatever
 * Chrome said. Written here rather than compiled in, so `tsc` output is never
 * rewritten after the fact.
 */
import { cpSync, readdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSourceHash } from './build-hash.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = join(root, 'static')
const dist = join(root, 'dist')

for (const entry of readdirSync(staticDir)) {
  cpSync(join(staticDir, entry), join(dist, entry), { recursive: true })
}

const build = computeSourceHash(root)
writeFileSync(
  join(dist, 'build-info.json'),
  `${JSON.stringify({ build, builtAt: new Date().toISOString() }, null, 2)}\n`,
)

console.log(
  `browser-extension assembled at apps/browser-extension/dist (Load unpacked) - build ${build}`,
)
