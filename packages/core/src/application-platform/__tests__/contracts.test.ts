import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WORKSPACE_MODULES } from '@use-brian/shared'
import { defineApplicationModules, type ApplicationModuleDefinition } from '../contracts.js'

function module(key: string, dependencies: string[] = []): ApplicationModuleDefinition<unknown> {
  return { key, defaultState: 'disabled', application: { version: '1', dependencies, resources: [],
    queries: ['list'], commands: ['create'], events: [`${key}.changed`], policyCapabilities: [], backgroundHandlers: [], uiContributions: [] },
  queries: { list: { input: z.object({}).strict(), authorize: async () => {}, execute: async () => [] } },
  commands: { create: { eventKey: `${key}.changed`, input: z.object({}).strict(), authorize: async () => {}, execute: async () => [], authorizeResult: async () => {} } } }
}
describe('[COMP:security/application-access] deployed application module registration', () => {
  it('registers two independent modules through the existing lifecycle catalog', () => {
    const result = defineApplicationModules([module('purchasing'), module('stock', ['purchasing'])], WORKSPACE_MODULES)
    expect(result.workspaceModules.association).toBe(WORKSPACE_MODULES.association)
    expect(result.workspaceModules.stock.defaultState).toBe('disabled')
    expect(result.applications.get('stock')?.application.dependencies).toEqual(['purchasing'])
  })
  it('refuses duplicate modules, missing/cyclic dependencies and catalog-only handlers', () => {
    for (const definitions of [[module('association')], [module('one'), module('one')], [module('one', ['missing'])],
      [module('one', ['two']), module('two', ['one'])]]) {
      expect(() => defineApplicationModules(definitions, WORKSPACE_MODULES)).toThrow()
    }
    const invalid = module('one'); invalid.application.commands = ['uploadRuntimeCode']
    expect(() => defineApplicationModules([invalid], WORKSPACE_MODULES)).toThrow()
  })
  it('requires a resource to use its native module identity', () => {
    const invalid = module('one')
    invalid.application.resources = [{ typeKey: 'order', schemaVersion: '1', origin: { kind: 'native', moduleKey: 'other' }, fields: [] }]
    expect(() => defineApplicationModules([invalid], WORKSPACE_MODULES)).toThrow()
  })
  it('requires references to resolve in the declared dependency catalog', () => {
    const first = module('one')
    first.application.resources = [{ typeKey: 'order', schemaVersion: '1', origin: { kind: 'native', moduleKey: 'one' },
      fields: [{ key: 'company', label: 'Company', kind: 'reference', targetTypeKey: 'missing' }] }]
    expect(() => defineApplicationModules([first], WORKSPACE_MODULES)).toThrow()
  })
})
