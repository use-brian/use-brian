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
    expect(result.workspaceModules.association).toEqual(WORKSPACE_MODULES.association)
    expect(result.workspaceModules.association).not.toBe(WORKSPACE_MODULES.association)
    expect(result.workspaceModules.stock.defaultState).toBe('disabled')
    expect(result.applications.get('stock')?.application.dependencies).toEqual(['purchasing'])
  })
  it('enriches an existing lifecycle identity without replacing its default or blocker mapping', () => {
    const definition = module('association')
    const result = defineApplicationModules([definition], WORKSPACE_MODULES)
    expect(Object.keys(result.workspaceModules)).toEqual(Object.keys(WORKSPACE_MODULES))
    expect(result.workspaceModules.association).toMatchObject(WORKSPACE_MODULES.association)
    expect(result.applications.get('association')?.commands.create.execute).toBe(definition.commands.create.execute)
    expect(result.applications.get('association')?.blockingCountCompatibility).toEqual(WORKSPACE_MODULES.association.blockingCountCompatibility)
    expect(definition.blockingCountCompatibility).toBeUndefined()
    expect(WORKSPACE_MODULES.association).not.toHaveProperty('application')
  })
  it('uses the same composition rules for any supplied lifecycle key', () => {
    const existing = { warehouse: { key: 'warehouse', defaultState: 'disabled' as const,
      blockingCountCompatibility: { field: 'pendingWork', blockerKey: 'pending_work' } },
      other: { key: 'other', defaultState: 'enabled' as const } }
    const definition = module('warehouse')
    definition.blockingCountCompatibility = { ...existing.warehouse.blockingCountCompatibility }
    const result = defineApplicationModules([definition], existing)
    expect(result.workspaceModules.warehouse).toMatchObject(existing.warehouse)
    expect(result.workspaceModules.other).toEqual(existing.other)
    expect(() => Object.assign(result.applications.get('warehouse')!.blockingCountCompatibility!, { field: 'changed' })).toThrow(TypeError)
  })
  it('refuses lifecycle metadata mismatches and replacing an already registered application', () => {
    const changedDefault = { ...module('association'), defaultState: 'enabled' as const }
    const changedBlocker = { ...module('association'), blockingCountCompatibility: { field: 'pendingOrders', blockerKey: 'different' } }
    const changedProjection = { ...module('association'), blockingCountCompatibility: { field: 'different', blockerKey: 'pending_orders' } }
    for (const definition of [changedDefault, changedBlocker, changedProjection]) {
      expect(() => defineApplicationModules([definition], WORKSPACE_MODULES)).toThrow()
    }
    const first = defineApplicationModules([module('association')], WORKSPACE_MODULES)
    expect(() => defineApplicationModules([module('association')], first.workspaceModules)).toThrow()
    expect(() => defineApplicationModules([module('association'), module('association')], WORKSPACE_MODULES)).toThrow()
  })
  it('refuses duplicate modules, missing/cyclic dependencies and catalog-only handlers', () => {
    for (const definitions of [[module('one'), module('one')], [module('one', ['missing'])],
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
  it('keeps structural catalog and owning-module checks independent of canonical dialects', () => {
    const resource = { typeKey: 'request', schemaVersion: '1', origin: { kind: 'native' as const, moduleKey: 'one' },
      fields: [{ key: 'code', label: 'Code', kind: 'text' as const, unique: true }] }
    expect(validateApplicationResourceCatalog('one', [resource])).toEqual([resource])
    expect(() => validateApplicationResourceCatalog('one', [resource, resource])).toThrow()
    expect(() => validateApplicationResourceCatalog('other', [resource])).toThrow()
    expect(() => validateApplicationResourceCatalog('one', [{ ...resource, fields: [resource.fields[0], resource.fields[0]] }])).toThrow()
    const definition = module('one')
    definition.application.resources = [resource]
    expect(defineApplicationModules([definition], WORKSPACE_MODULES).applications.get('one')?.application.resources).toEqual([resource])
  })
  it('retains the public catalog schema-version wire bound', () => {
    const resource = { typeKey: 'request', schemaVersion: 'a'.repeat(128), origin: { kind: 'native' as const, moduleKey: 'one' }, fields: [] }
    expect(validateApplicationResourceCatalog('one', [resource])[0].schemaVersion).toHaveLength(128)
    expect(() => validateApplicationResourceCatalog('one', [{ ...resource, schemaVersion: 'a'.repeat(129) }])).toThrow()
  })
  it('captures handler properties without freezing the caller or schema internals', async () => {
    const definition = module('owned')
    const originalCommand = definition.commands.create.execute
    const originalQuery = definition.queries.list.authorize
    const schema = definition.commands.create.input
    const registered = defineApplicationModules([definition], WORKSPACE_MODULES).applications.get('owned')!

    definition.commands.create.execute = async () => { throw new Error('Changed after registration') }
    definition.queries.list.authorize = async () => { throw new Error('Changed after registration') }
    expect(registered.commands.create.execute).toBe(originalCommand)
    expect(registered.queries.list.authorize).toBe(originalQuery)
    expect(() => { registered.commands.create.execute = definition.commands.create.execute }).toThrow(TypeError)
    expect(() => { registered.queries.list.authorize = definition.queries.list.authorize }).toThrow(TypeError)
    expect(Object.isFrozen(definition.commands.create)).toBe(false)
    expect(registered.commands.create.input).toBe(schema)
    expect(Object.isFrozen(schema)).toBe(false)
    expect(schema.safeParse({}).success).toBe(true)
  })

  it('owns and freezes nested catalog data while leaving caller metadata independent', () => {
    const definition = module('owned')
    definition.application.resources = [{ typeKey: 'request', schemaVersion: '1',
      origin: { kind: 'native', moduleKey: 'owned' }, fields: [{ key: 'title', kind: 'text', label: 'Title' }] }]
    const registered = defineApplicationModules([definition], WORKSPACE_MODULES).applications.get('owned')!

    definition.application.resources[0].fields[0].label = 'Changed by caller'
    definition.application.commands.push('later')
    expect(registered.application.resources[0].fields[0].label).toBe('Title')
    expect(registered.application.commands).toEqual(['create'])
    expect(() => { registered.application.resources[0].fields[0].label = 'Changed through registry' }).toThrow(TypeError)
    expect(() => registered.application.commands.push('later')).toThrow(TypeError)
    expect(() => registered.application.resources.splice(0, 1)).toThrow(TypeError)
  })

  it('owns existing lifecycle metadata and new module compatibility metadata', () => {
    const existing = structuredClone(WORKSPACE_MODULES)
    const definition = module('owned')
    definition.blockingCountCompatibility = { field: 'pendingItems', blockerKey: 'pending_items' }
    const registered = defineApplicationModules([definition], existing)
    Object.assign(existing.association.blockingCountCompatibility, { field: 'changed' })
    definition.blockingCountCompatibility.field = 'changed'

    expect(registered.workspaceModules.association.blockingCountCompatibility?.field).toBe('pendingOrders')
    expect(registered.workspaceModules.owned.blockingCountCompatibility?.field).toBe('pendingItems')
    expect(registered.applications.get('owned')?.blockingCountCompatibility?.field).toBe('pendingItems')
    expect(() => Object.assign(registered.workspaceModules.association, { defaultState: 'enabled' })).toThrow(TypeError)
    expect(() => Object.assign(registered.applications.get('owned')!.blockingCountCompatibility!, { field: 'changed' })).toThrow(TypeError)
  })

})
