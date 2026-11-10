import { describe, expect, it } from 'vitest'
import { deliveryAudienceFailureKind, deliveryFailureAnalytics, deliveryFailureMetadata } from '../delivery-failure.js'

describe('[COMP:api/delivery-authority] safe failure diagnostics', () => {
  it('retains only recognized phase and SQLSTATE class through nested causes', () => {
    const database = Object.assign(new Error('PRIVATE query and source'), { code: '57014', detail: 'PRIVATE labels', query: 'PRIVATE SQL' })
    const scoped = Object.assign(new Error('PRIVATE scope', { cause: database }), { verificationPhase: 'native_proof' })
    const outer = new Error('PRIVATE wrapper', { cause: scoped })
    expect(deliveryFailureMetadata(outer)).toEqual({ verificationPhase: 'native_proof', verificationSqlstateClass: '57' })
    expect(deliveryFailureAnalytics(outer)).toEqual({ verification_phase: 'native_proof', verification_sqlstate_class: '57' })
    expect(JSON.stringify(deliveryFailureAnalytics(outer))).not.toContain('PRIVATE')
  })

  it.each(['PRIVATE', '57ABC', 'source_unverifiable', '57014 SELECT PRIVATE', 'private:57014'])(
    'omits unknown code %s and unrecognized phase/class properties', code => {
      expect(deliveryFailureMetadata({ code, verificationPhase: 'PRIVATE', verificationSqlstateClass: 'PRIVATE' })).toEqual({})
    },
  )

  it('bounds cause traversal and terminates cycles', () => {
    const cyclic: { cause?: unknown; code: string } = { code: '57014' }
    cyclic.cause = cyclic
    expect(deliveryFailureMetadata(cyclic)).toEqual({ verificationSqlstateClass: '57' })
    let deep: unknown = { code: '57014' }
    for (let index = 0; index < 8; index++) deep = { cause: deep }
    expect(deliveryFailureMetadata(deep)).toEqual({})
  })

  it('does not turn diagnostic extraction failure into an authorization failure', () => {
    expect(deliveryFailureMetadata({ get code() { throw new Error('PRIVATE') } }, 'native_proof')).toEqual({ verificationPhase: 'native_proof' })
    expect(deliveryFailureMetadata(null, 'PRIVATE' as never)).toEqual({})
  })

  it('snapshots changing getters once before validating and exposing metadata', () => {
    let phaseReads = 0, classReads = 0, codeReads = 0
    const error = {
      get verificationPhase() { return ++phaseReads === 1 ? 'native_proof' : 'PRIVATE SQL' },
      get verificationSqlstateClass() { return ++classReads === 1 ? '57' : 'PRIVATE source id' },
      get code() { return ++codeReads === 1 ? '57014' : 'PRIVATE labels' },
    }
    expect(deliveryFailureAnalytics(error)).toEqual({ verification_phase: 'native_proof', verification_sqlstate_class: '57' })
    expect([phaseReads, classReads, codeReads]).toEqual([1, 1, 1])
  })

  it('preserves explicit coarse legacy reasons, while uncertainty overrides historical details', () => {
    expect(deliveryAudienceFailureKind({ detail: 'unbound' })).toBe('unbound')
    expect(deliveryAudienceFailureKind({ detail: 'evidence_exceeds_audience' })).toBe('restriction')
    expect(deliveryAudienceFailureKind({ detail: 'evidence_exceeds_audience', diagnostic: 'source_unverifiable' })).toBe('unverified')
    expect(deliveryAudienceFailureKind({ detail: 'unbound', diagnostic: 'verification_error' })).toBe('unverified')
    expect(deliveryAudienceFailureKind({ diagnostic: 'binding_expired' })).toBe('unbound')
    expect(deliveryAudienceFailureKind({ diagnostic: 'teams' })).toBe('restriction')
    expect(deliveryAudienceFailureKind({ diagnostic: 'PRIVATE' })).toBe('unverified')
    expect(deliveryAudienceFailureKind({})).toBe('unverified')
  })
})
