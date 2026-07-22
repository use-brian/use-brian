/**
 * Assemble the unpacked extension: dist/ holds the tsc output; copy the
 * static assets (manifest + pages) beside it so `dist/` loads directly via
 * chrome://extensions "Load unpacked".
 */
import { cpSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staticDir = join(root, 'static')
const dist = join(root, 'dist')

for (const entry of readdirSync(staticDir)) {
  cpSync(join(staticDir, entry), join(dist, entry), { recursive: true })
}

console.log('browser-extension assembled at apps/browser-extension/dist (Load unpacked)')
