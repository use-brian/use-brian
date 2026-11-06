import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')

describe('chat request permission ownership', () => {
  it('shares the trusted input between initial resolution and lazy action selection', () => {
    expect(source).toContain('const executionInput: ResolveExecutionContextInput = {')
    expect(source).toContain('resolveExecutionContextSystem(executionInput)')
    expect(source).toContain('createRequestPermissionContext(resolvedExecution, scopeAccumulator, session, {')
    expect(source).toContain('createActionSnapshots: () => createExecutionPermissionSnapshots(executionInput)')
    expect(source).not.toContain('createWebResponsePermissionSnapshot')
  })

  it('uses only the request owner for native cached delivery, retaining fallback boundaries', () => {
    expect(source).toContain('permissionContext, assertOutputAuthority: permissionContext.authorizeDelivery')
    expect(source).not.toContain('responsePermissionSnapshot')
    expect(source).toContain('const nativeOutputBoundary=!programmatic&&!permissionContext&&nativeTranscriptAuthority')
    expect(source).toContain('assertOutputAuthority:assertDeliveryAudience')
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
    expect(source.slice(cleanup).indexOf('requestPermissions?.dispose()')).toBeLessThan(
      source.slice(cleanup).indexOf('await releaseTurn('),
    )
  })
})
