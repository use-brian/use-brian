import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WORKSPACE_MODULES } from '@use-brian/shared'
import { defineApplicationModules, validateApplicationResourceCatalog, type ApplicationModuleDefinition } from '../contracts.js'

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
  it('uses the same canonical property and owning-module checks for operation-time catalogs', () => {
    const value = { typeKey: 'request', schemaVersion: '1', origin: { kind: 'generic' as const, entityTypeId: '10000000-0000-4000-8000-000000000001' },
      fields: [{ key: 'title', label: 'Title', kind: 'cell' as const, property: { name: 'title', config: { kind: 'text' } } }] }
    expect(validateApplicationResourceCatalog('one', [value])).toEqual([value])
    expect(() => validateApplicationResourceCatalog('one', [value, value])).toThrow()
    expect(() => validateApplicationResourceCatalog('one', [{ ...value, origin: { kind: 'native', moduleKey: 'other' } }])).toThrow()
    expect(() => validateApplicationResourceCatalog('one', [{ ...value, fields: [{ ...value.fields[0], property: { name: 'title', config: { kind: 'formula' } } }] }])).toThrow()
  })
  it('binds a native CRM declaration to its canonical entity kind and custom field key', () => {
    const definition = { id: '10000000-0000-4000-8000-000000000002', entityKind: 'company', fieldKey: 'region', label: 'Region',
      fieldType: 'text', options: [], isRequired: false, position: 0 }
    const resource = { typeKey: 'company', origin: { kind: 'native' as const, moduleKey: 'native' }, schemaVersion: '1',
      fields: [{ key: 'custom.region', kind: 'crm' as const, label: 'Region', definition }] }
    expect(validateApplicationResourceCatalog('native', [resource])).toEqual([resource])
    expect(() => validateApplicationResourceCatalog('native', [{ ...resource, typeKey: 'person' }])).toThrow()
    expect(() => validateApplicationResourceCatalog('native', [{ ...resource, fields: [{ ...resource.fields[0], key: 'name' }] }])).toThrow()
  })
})
