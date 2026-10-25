import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import type { ApplicationResourceDefinition } from '@use-brian/shared'
import { createExecutionContext, type ApplicationOperationContext, type PropertyDef } from '@use-brian/core'
import { createHash } from 'node:crypto'

const state = vi.hoisted(() => ({ application: false, fields: [] as Array<Record<string, unknown>> }))
vi.mock('../execution-context.js', async original => ({ ...await original<typeof import('../execution-context.js')>(),
  getApplicationExecutionBinding: () => state.application ? { state: { fingerprint: 'fixture' } } : undefined }))
vi.mock('../native-resources.js', () => ({ canonicalNativeResourceDefinitions: () => [{
  typeKey: 'company', origin: { kind: 'native', moduleKey: 'native' }, schemaVersion: '1', fields: state.fields,
}] }))

import { canonicalGenericResource } from '../generic-reader.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { readCanonicalNativeQueryDefinition, validateCanonicalNativeResource } from '../native-reader.js'

const workspaceId = '10000000-0000-4000-8000-000000000001'
const typeId = '10000000-0000-4000-8000-000000000002'
const fieldId = '10000000-0000-4000-8000-000000000003'
const title: PropertyDef = { name: 'title', config: { kind: 'text' }, unique: true }
const relation: PropertyDef = { name: 'supplier', config: { kind: 'relation', targetEntityTypeRef: { kind: 'builtin', name: 'company' } } }
const crm = { id: fieldId, entityKind: 'company', fieldKey: 'region', label: 'Region', fieldType: 'text',
  options: [], isRequired: true, position: 0 }
function context(rows: unknown[]) {
  const transaction = { query: vi.fn(async () => ({ rows })) } as unknown as PoolClient
  const execution = createExecutionContext({
    identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: fieldId } }, ownership: { kind: 'workspace', workspaceId },
    access: { workspaceId, userId: fieldId, assistantId: typeId, assistantKind: 'primary', clearance: 'internal',
      compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: [] },
    writeDefaults: { compartments: [], projectIds: [] }, authority: { assertCurrent: async () => {}, execute: operation => operation() },
    lifecycle: { sessionId: 'catalog-fixture', sessionPersisted: false, channelType: 'test', channelId: 'catalog', abortSignal: new AbortController().signal },
  })
  const operation: ApplicationOperationContext<PoolClient> = { transaction, execution, idempotencyKey: '', afterCommit: () => {} }
  return { operation, read: { transaction, workspaceId } }
}
function generic(properties: PropertyDef[] = [title]) {
  return { id: typeId, schemaVersion: 1, properties }
}
function boundGeneric(properties: PropertyDef[] = [title]) {
  return { typeKey: `record.${typeId}`, origin: { kind: 'generic', entityTypeId: typeId }, schemaVersion: '1',
    fields: properties.map(property => ({ key: property.name, label: property.name, kind: 'cell', property })) }
}
beforeEach(() => {
  state.application = false
  state.fields.splice(0, state.fields.length, { key: 'name', label: 'Name', kind: 'text' })
})

describe('[COMP:api/application-records] canonical adapter catalog validation', () => {
  it.each([false, true])('validates unsupported Doc properties in the application-bound=%s generic catalog', async application => {
    state.application = application
    const properties = [{ name: 'title', config: { kind: 'formula' } }] as unknown as PropertyDef[]
    const { operation } = context(application ? [{ resource: boundGeneric(properties) }] : [generic(properties)])
    await expect(createCanonicalGenericApplicationModule().resolveResources!(operation)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it.each([false, true])('retains scalar generic uniqueness and canonical relation keys in application-bound=%s catalogs', async application => {
    state.application = application
    const resource = canonicalGenericResource(generic([title, relation]))
    const { operation } = context(application ? [{ resource }] : [generic([title, relation])])
    const result = await createCanonicalGenericApplicationModule().resolveResources!(operation)
    expect(result[0].fields[0]).toMatchObject({ property: { unique: true } })
    expect(result[0].fields[1]).toMatchObject({ relationshipResolverKey: `relation.${createHash('sha256').update('supplier').digest('hex')}` })
  })

  it('refuses a substituted relationship resolver in the projected SQL generic catalog', async () => {
    state.application = true
    const resource = boundGeneric([relation])
    const { operation } = context([{ resource: { ...resource, fields: [{ ...resource.fields[0], relationshipResolverKey: `relation.${'0'.repeat(64)}` }] } }])
    await expect(createCanonicalGenericApplicationModule().resolveResources!(operation)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it('refuses CRM declarations in the canonical generic catalog', async () => {
    state.application = true
    const resource = boundGeneric([])
    const { operation } = context([{ resource: { ...resource, fields: [{ key: 'custom.region', label: 'Region', kind: 'crm', required: true, definition: crm }] } }])
    await expect(createCanonicalGenericApplicationModule().resolveResources!(operation)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it('refuses unsupported scalar uniqueness at the canonical generic schema owner', () => {
    expect(() => canonicalGenericResource(generic([{ name: 'tags', unique: true, config: { kind: 'multi_select', options: [] } }]))).toThrow()
  })

  it.each([false, true])('preserves canonical CRM field keys and required metadata in application-bound=%s native catalogs', async application => {
    state.application = application
    const { operation } = context(application ? [{ value: { typeKey: 'company', fields: ['name'], customFields: [crm] } }] : [{ definition: crm }])
    const [resource] = await createCanonicalNativeApplicationModule().resolveResources!(operation)
    expect(resource.fields[1]).toMatchObject({ key: 'custom.region', kind: 'crm', required: true, definition: crm })
  })

  it('refuses a CRM definition attached to a different canonical entity kind', async () => {
    state.application = true
    const { operation } = context([{ value: { typeKey: 'company', fields: ['name'], customFields: [{ ...crm, entityKind: 'person' }] } }])
    await expect(createCanonicalNativeApplicationModule().resolveResources!(operation)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it.each([false, true])('refuses invalid CRM definitions in application-bound=%s native catalogs', async application => {
    state.application = application
    const definition = { ...crm, fieldType: 'unsupported' }
    const { operation } = context(application ? [{ value: { typeKey: 'company', fields: ['name'], customFields: [definition] } }] : [{ definition }])
    await expect(createCanonicalNativeApplicationModule().resolveResources!(operation)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it.each([false, true])('validates CRM entity binding in native query template=%s catalogs', async completeTemplate => {
    const { read } = context([{ value: { typeKey: 'company', fields: ['name'], customFields: [{ ...crm, entityKind: 'person' }] } }])
    await expect(readCanonicalNativeQueryDefinition(read, 'company', completeTemplate)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it.each([false, true])('preserves valid CRM definitions in native query template=%s catalogs', async completeTemplate => {
    const { read } = context([{ value: { typeKey: 'company', fields: ['name'], customFields: [crm] } }])
    const resource = await readCanonicalNativeQueryDefinition(read, 'company', completeTemplate)
    expect(resource.fields[1]).toMatchObject({ key: 'custom.region', kind: 'crm', required: true, definition: crm })
  })

  it.each([false, true])('preserves the full internal SQL schema identity in native query template=%s catalogs', async completeTemplate => {
    const sourceVersion = createHash('sha256').update('fictional canonical schema').digest('hex')
    const { read } = context([{ value: { typeKey: 'company', fields: ['name'], customFields: [], schemaVersion: sourceVersion } }])
    const resource = await readCanonicalNativeQueryDefinition(read, 'company', completeTemplate)
    const expected = `${sourceVersion}:${createHash('sha256').update(JSON.stringify(state.fields)).digest('hex')}`
    expect(expected).toHaveLength(129)
    expect(resource.schemaVersion).toBe(expected)
    expect(resource.fields).toEqual(state.fields)
  })

  it('preserves the full internal SQL schema identity in the dynamic application native catalog', async () => {
    state.application = true
    const sourceVersion = createHash('sha256').update('fictional canonical schema').digest('hex')
    const { operation } = context([{ value: { typeKey: 'company', fields: ['name'], customFields: [], schemaVersion: sourceVersion } }])
    const [resource] = await createCanonicalNativeApplicationModule().resolveResources!(operation)
    const expected = `${sourceVersion}:${createHash('sha256').update(JSON.stringify(state.fields)).digest('hex')}`
    expect(expected).toHaveLength(129)
    expect(resource.schemaVersion).toBe(expected)
    expect(resource.fields).toEqual(state.fields)
  })

  it('preserves the existing native-member catalog identity without an upstream SQL version', async () => {
    const { operation } = context([])
    const [resource] = await createCanonicalNativeApplicationModule().resolveResources!(operation)
    expect(resource.schemaVersion).toBe(`1:${createHash('sha256').update(JSON.stringify(state.fields)).digest('hex')}`)
  })

  it('validates native semantics without replacing an internal declaration or its opaque version', () => {
    const sourceVersion = createHash('sha256').update('fictional canonical schema').digest('hex')
    const resource: ApplicationResourceDefinition = { typeKey: 'company', origin: { kind: 'native', moduleKey: 'native' },
      schemaVersion: `${sourceVersion}:${createHash('sha256').update('fictional compiled field dictionary').digest('hex')}`,
      fields: [{ key: 'name', label: 'Name', kind: 'text' }] }
    expect(validateCanonicalNativeResource(resource)).toBe(resource)
  })

  it('refuses uniqueness unsupported by the compiled built-in native writer', () => {
    state.fields[0].unique = true
    expect(() => createCanonicalNativeApplicationModule()).toThrow(expect.objectContaining({ code: 'invalid_schema' }))
  })

  it.each([false, true])('refuses unsupported built-in native uniqueness in query template=%s catalogs', async completeTemplate => {
    state.fields[0].unique = true
    const { read } = context([{ value: { typeKey: 'company', fields: ['name'], customFields: [] } }])
    await expect(readCanonicalNativeQueryDefinition(read, 'company', completeTemplate)).rejects.toMatchObject({ code: 'invalid_schema' })
  })

  it.each([{ key: 'custom.other' }, { required: false }])('refuses a substituted compiled CRM binding %j', change => {
    state.fields.push({ key: 'custom.region', label: 'Region', kind: 'crm', required: true, definition: crm, ...change })
    expect(() => createCanonicalNativeApplicationModule()).toThrow()
  })
})
