import { describe, expect, it } from 'vitest'
import { ApplicationPlatformError, applicationClientInputSchema, applicationCommandSchema, applicationDecimalSchema,
  applicationDecimalAdd, applicationDecimalCompare, applicationDecimalText, applicationGrantInputSchema, applicationQuerySchema, applicationResourceRefSchema, applicationResourceSchema } from '../application-platform.js'

describe('[COMP:shared/application-platform] application wire boundaries', () => {
  const ref = { workspaceId: '10000000-0000-4000-8000-000000000001', origin: { kind: 'native', moduleKey: 'operations' },
    typeKey: 'purchase', id: 'same-local-id', version: '7' }
  it('requires a complete origin, workspace, type, ID and version', () => {
    expect(applicationResourceRefSchema.parse(ref)).toEqual(ref)
    for (const missing of ['workspaceId', 'origin', 'typeKey', 'id', 'version']) {
      expect(applicationResourceRefSchema.safeParse(Object.fromEntries(Object.entries(ref).filter(([key]) => key !== missing))).success).toBe(false)
    }
    expect(applicationResourceRefSchema.safeParse({ ...ref, ownerUserId: 'injected' }).success).toBe(false)
    expect(applicationResourceRefSchema.safeParse({ ...ref, origin: { kind: 'external', connectorInstanceId: ref.workspaceId } }).success).toBe(false)
  })
  it('rejects duplicate field and enum catalogs and inverted bounds', () => {
    const resource = { typeKey: 'purchase', origin: ref.origin, schemaVersion: '1' }
    const field = { key: 'state', label: 'State', kind: 'enum', options: ['open'] }
    expect(applicationResourceSchema.safeParse({ ...resource, fields: [field, field] }).success).toBe(false)
    expect(applicationResourceSchema.safeParse({ ...resource, fields: [{ ...field, options: ['open', 'open'] }] }).success).toBe(false)
    expect(applicationResourceSchema.safeParse({ ...resource, fields: [{ key: 'amount', label: 'Amount', kind: 'number', minimum: 10, maximum: 1 }] }).success).toBe(false)
  })
  it('caps query and batch vocabulary and refuses unknown operators/SQL', () => {
    expect(applicationQuerySchema.parse({}).limit).toBe(50)
    for (const input of [{ limit: 101 }, { limit: 0 }, { sql: 'SELECT *' }, { filters: [{ field: 'cost', op: 'execute', value: 1 }] }]) {
      expect(applicationQuerySchema.safeParse(input).success).toBe(false)
    }
  })
  it('preserves lossless decimals and rejects exponent, whitespace and non-finite inputs', () => {
    expect(applicationDecimalSchema.parse('12345678901234567890.123456789012345678')).toBe('12345678901234567890.123456789012345678')
    for (const value of ['1e2', ' 1', '01', 'NaN', '1.1234567890123456789', 1.2]) expect(applicationDecimalSchema.safeParse(value).success).toBe(false)
  })
  it('adds and compares decimals exactly and expands finite numeric JSON exponent spellings', () => {
    expect(applicationDecimalAdd('9007199254740993.123456789012345678','0.000000000000000001')).toBe('9007199254740993.123456789012345679')
    expect(applicationDecimalAdd('0.1','0.2')).toBe('0.3')
    expect(applicationDecimalAdd('-12.30','12.3')).toBe('0')
    expect(applicationDecimalCompare('9007199254740993','9007199254740992')).toBe(1)
    expect(applicationDecimalCompare('1.00',1)).toBe(0)
    expect(applicationDecimalText(1e-7)).toBe('0.0000001')
    for (const value of [9007199254740992,Infinity,'1e2','1.1234567890123456789']) expect(() => applicationDecimalText(value)).toThrow()
  })
  it('requires semantic idempotency and JSON input without provider code', () => {
    expect(applicationCommandSchema.safeParse({ input: {}, idempotencyKey: '' }).success).toBe(false)
    expect(applicationCommandSchema.safeParse({ input: { amount: Infinity }, idempotencyKey: 'once' }).success).toBe(false)
    expect(applicationCommandSchema.safeParse({ input: { run: () => 1 }, idempotencyKey: 'once' }).success).toBe(false)
  })
  it('keeps uncertain effect state separate from safe retry', () => {
    const error = new ApplicationPlatformError('outcome_uncertain', 'Reconcile the saved receipt.', 'uncertain')
    expect(error.retrySafe).toBe(false)
    expect(error.effect).toBe('uncertain')
  })
  it('accepts only a closed grant proposal without caller-authored issuer, status or captured authority', () => {
    const proposal = { principal: { kind: 'external_user', userId: ref.workspaceId }, origin: ref.origin, typeKey: ref.typeKey,
      actions: ['read'], readFields: ['title'], writeFields: [], selector: { kind: 'ids', ids: ['record-1'] },
      compartments: [], projectIds: [], clearance: 'internal', parentGrantId: null, expiresAt: null }
    expect(applicationGrantInputSchema.safeParse(proposal).success).toBe(true)
    for (const patch of [{ actions: ['read', 'read'] }, { readFields: ['title', 'title'] }, { status: 'active' },
      { issuedByUserId: ref.workspaceId }, { authorityHash: 'invented' }, { principal: { ...proposal.principal, roles: ['owner'] } }]) {
      expect(applicationGrantInputSchema.safeParse({ ...proposal, ...patch }).success).toBe(false)
    }
  })
  it('pins exact browser origins/redirects and allows loopback development without wildcard audiences',()=>{
    const client={workspaceId:ref.workspaceId,moduleKey:'operations',name:'Example app',mode:'external_frontend',origins:['https://app.example'],redirectUris:['https://app.example/callback']}
    expect(applicationClientInputSchema.safeParse(client).success).toBe(true)
    expect(applicationClientInputSchema.safeParse({...client,origins:['http://127.0.0.1:3000'],redirectUris:['http://127.0.0.1:3000/callback']}).success).toBe(true)
    for(const patch of [{origins:['https://app.example/']},{redirectUris:['https://other.example/callback']},{redirectUris:['https://app.example/*']},
      {origins:['http://app.example'],redirectUris:['http://app.example/callback']},{redirectUris:['https://app.example/callback#fragment']}]) {
      expect(applicationClientInputSchema.safeParse({...client,...patch}).success).toBe(false)
    }
  })
  it('retains legacy option IDs and canonical generic property declarations without accepting provider code',()=>{
    const resource={typeKey:'request',schemaVersion:'1',origin:{kind:'generic',entityTypeId:ref.workspaceId}}
    expect(applicationResourceSchema.safeParse({...resource,fields:[{key:'state',label:'State',kind:'enum',options:[ref.workspaceId]}]}).success).toBe(true)
    const field={key:'tags',label:'Tags',kind:'cell',property:{name:'tags',config:{kind:'multi_select',options:[{id:ref.workspaceId,name:'Example choice'}]}}}
    expect(applicationResourceSchema.safeParse({...resource,fields:[field]}).success).toBe(true)
    expect(applicationResourceSchema.safeParse({...resource,fields:[{...field,property:{name:'different',config:{kind:'text'}}}]}).success).toBe(false)
    expect(applicationResourceSchema.safeParse({...resource,fields:[{...field,property:{...field.property,run:()=>1}}]}).success).toBe(false)
  })
})
