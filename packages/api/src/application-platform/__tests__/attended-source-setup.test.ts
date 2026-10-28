import { describe, expect, it } from 'vitest'
import { attendedSourceSetupInput, validateAttendedSourceEndpoints } from '../attended-source-onboarding.js'
import { applicationManagementCommandSchema } from '../management.js'

describe('[COMP:api/attended-source-setup] fixed protected source destinations', () => {
  it('accepts a same-origin API prefix without requiring an HTTP record endpoint', () => {
    expect(() => validateAttendedSourceEndpoints('https://source.example/api','https://source.example/api/mcp','https://source.example')).not.toThrow()
    expect(() => validateAttendedSourceEndpoints('http://127.0.0.1:4567/api','http://127.0.0.1:4567/api/mcp','https://source.example')).not.toThrow()
  })
  it.each([
    ['https://other.example/api','https://source.example/api/mcp','https://source.example'],
    ['https://source.example/api/','https://source.example/api/mcp','https://source.example'],
    ['http://source.example/api','http://source.example/api/mcp','https://source.example'],
    ['https://source.example/api?target=foreign','https://source.example/api/mcp','https://source.example'],
    ['https://source.example/api','https://secret@source.example/api/mcp','https://source.example'],
    ['https://source.example/api','https://source.example/api/mcp','http://source.example'],
  ])('refuses ambiguous or unprotected endpoint authority (%s)', (base,mcp,audience) => {
    expect(() => validateAttendedSourceEndpoints(base,mcp,audience)).toThrow()
  })
  it('refuses retired effect authoring and injected identity while validating attended action selection', () => {
    const input = { instanceId: '11111111-1111-4111-8111-111111111111', tenant: 'fictional', audience: 'https://source.example',
      sourceBaseUrl: 'https://source.example/api', probeTool: 'readRecord', probeInput: { id: 'record-1' } }
    expect(attendedSourceSetupInput.safeParse(input).success).toBe(true)
    for (const extra of [{ effectBinding: 'command_v1' }, { userId: input.instanceId }, { privateKey: 'untrusted' }]) {
      expect(attendedSourceSetupInput.safeParse({ ...input, ...extra }).success).toBe(false)
    }
    expect(applicationManagementCommandSchema.safeParse({ kind: 'connector.source.review', input }).success).toBe(true)
    expect(attendedSourceSetupInput.safeParse({...input,actions:{tools:['updateRecord'],idempotencyMetadataKey:'source/operation-key'}}).success).toBe(true)
    for(const actions of [{tools:['updateRecord'],idempotencyMetadataKey:'Authorization'},
      {tools:['updateRecord','updateRecord'],idempotencyMetadataKey:'source/operation-key'}]){
      expect(attendedSourceSetupInput.safeParse({...input,actions}).success).toBe(false)
    }
  })
})
