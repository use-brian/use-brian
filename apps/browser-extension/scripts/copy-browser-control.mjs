import { cpSync } from 'node:fs'
import { join } from 'node:path'

/** Replace emitted package shims with the canonical browser-loadable modules. */
export function copyBrowserControl(root, output) {
  for (const name of ["executor", "snapshot", "dom-settle", "action-cursor", "fill-form", "tab-eligibility", "relay-client", "protocol"]) {
    cpSync(join(root, '../../packages/browser-control/dist', `${name}.js`), join(output, `${name}.js`))
  }
}
