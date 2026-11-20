import { registerHooks } from 'node:module'

const current = new URL('../../../workspace-access/admission-policy-read.ts', import.meta.url).href
const compiled = new URL('../../../../dist/workspace-access/admission-policy-read.js', import.meta.url).href
const historical = new URL('./embedded-brain-admission-policy-8273.ts', import.meta.url).href

// This loader is passed only to the fixture's embedded 8273 product processes.
// The managed target always runs with the maintained source and SQL head.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context)
    return result.url === current || result.url === compiled ? nextResolve(historical, context) : result
  },
})
