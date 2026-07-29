/** Assemble the unpacked Firefox extension beside the Chromium build. */
import { cpSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const compiled = join(root, 'dist')
const output = join(root, 'dist-firefox')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })

const runtimeFiles = [
  'firefox-allow.js',
  'firefox-background.js',
  'firefox-native-client.js',
  'firefox-popup.js',
  'pairing.js',
  'protocol.js',
  'relay-client.js',
  'tab-eligibility.js',
  'task-gate.js',
]
for (const file of runtimeFiles) cpSync(join(compiled, file), join(output, file))
for (const file of readdirSync(join(root, 'static-firefox'))) {
  cpSync(join(root, 'static-firefox', file), join(output, file), { recursive: true })
}

console.log('firefox extension assembled at apps/browser-extension/dist-firefox')
