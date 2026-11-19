import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')

describe('chat request permission ownership', () => {
  it('binds delivery to the original resolved execution without a snapshot provider', () => {
    expect(source).toContain('const executionInput: ResolveExecutionContextInput = {')
    expect(source).toContain('resolveExecutionContextSystem(executionInput)')
    expect(source).toContain('createTurnDeliveryAdmission(executionContext, scopeAccumulator, session)')
    expect(source).not.toContain('createExecutionPermissionSnapshots')
  })

  it('uses only the request owner for fresh native delivery, retaining fallback boundaries', () => {
    expect(source).toContain('permissionContext, admitOutput: permissionContext.authorizeDelivery')
    expect(source).not.toContain('responsePermissionSnapshot')
    expect(source).not.toContain('nativeOutputBoundary')
    expect(source).toContain('admitOutput:() => assertDeliveryAudience()')
  })

  it('registers the owner for cleanup immediately and disposes before awaited finalization', () => {
    const creation = source.indexOf('const permissionContext = nativeTranscriptAuthority')
    const capture = source.indexOf('requestPermissions = permissionContext', creation)
    expect(capture).toBeGreaterThan(creation)
    // No awaited call or early return can strand a successfully created owner.
    const handoff = source.slice(creation, capture)
    expect(handoff).not.toMatch(/\bawait\b|\breturn\b/)
    const cleanup = source.indexOf('} finally {\n      requestPermissions?.dispose()')
    expect(cleanup).toBeGreaterThan(capture)
    const finalization = source.indexOf('await turnOwner?.finish()', cleanup)
    expect(finalization).toBeGreaterThan(cleanup)
    expect(source.indexOf('requestPermissions?.dispose()', cleanup)).toBeLessThan(finalization)
  })
})
