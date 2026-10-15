import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assessReleaseEvidence } from '../release-readiness.mjs'
import { operatorBundle } from '../operator-bundle.mjs'

function complete() {
  const sha = 'a'.repeat(40), h = 'b'.repeat(64)
  return { evidenceClass: 'fixture', candidate: { ref: 'main', sha }, target: 'fictional-installation', actor: { kind: 'brian', id: 'fictional-brian' },
    requiredChecks: ['build-test'], checks: [{ name: 'build-test', sha, status: 'passed', skipped: false, artifactHash: h }],
    artifacts: [{ sha, target: 'fictional-installation', sha256: h }],
    route: { kind: 'manual', source: 'fictional-fixed-release-route', target: 'fictional-installation', actorId: 'fictional-brian', sha,
      available: true, authorized: true, policyVerified: true, permissionEvidence: h, nativePolicyEvidence: h }, remoteSettings: 'verified',
    health: { verified: true, sha, target: 'fictional-installation' }, rollback: { verified: true, target: 'fictional-installation', receipt: h } }
}

describe('[COMP:operations/v1-readiness] release evidence truth', () => {
  it('V10 complete fixture evidence verifies only the fixture and never claims live release readiness', () => {
    assert.deepEqual(assessReleaseEvidence(complete()), { status: 'fixture_verified', localEvidenceValid: true, liveVerified: false, reasons: [] })
  })
  it('V10 wrong SHA, skipped checks, missing Brian route, target mismatch and unverified settings cannot pass', () => {
    for (const mutate of [e => { e.checks[0].sha = 'c'.repeat(40) }, e => { e.checks[0].skipped = true },
      e => { e.artifacts[0].sha = 'c'.repeat(40) }, e => { e.artifacts[0].target = 'other' }, e => { e.route.actorId = 'maintainer' },
      e => { e.route.available = false }, e => { e.route.nativePolicyEvidence = null }, e => { e.remoteSettings = 'not_checked' },
      e => { e.route.authorized = false }, e => { e.route.permissionEvidence = null }, e => { e.requiredChecks = [] },
      e => { e.health.sha = 'c'.repeat(40) }, e => { e.rollback.verified = false }, e => { e.checks = [] },
      e => { e.route.kind = 'file-write' }, e => { e.route.policyVerified = false }, e => { e.evidenceClass = 'live' }]) {
      const e = complete(); mutate(e)
      assert.equal(assessReleaseEvidence(e).status, 'blocked')
    }
  })
  it('V13 operator bundle keeps blockers, owner bindings and unstarted review consistent with machine results', () => {
    const report = { verdicts: { codeHarness: 'passed', localReadiness: 'not_ready' }, source: { oss: { sha: 'a' }, platform: { sha: 'b' }, digest: 'c' },
      dependencies: { F07: { id: 'F07', plan: 'routine-work-intake-implementation.md', status: 'blocked', reasons: ['mail_source_missing'] } },
      cases: { V06: { id: 'V06', description: 'CoS', status: 'blocked', reasons: ['mail_source_missing'] } }, artifacts: [] }
    const texts = operatorBundle(report, { recipes: [{ unresolvedBindings: ['assistantId', 'taskAllowance'] }] }, { gaps: [] })
    assert.equal(Object.keys(texts).length, 4)
    assert.match(texts['readiness.md'], /not_ready/)
    assert.match(texts['remaining-work.md'], /mail_source_missing/)
    assert.match(texts['remaining-work.md'], /Accountable role/)
    assert.match(texts['activation-checklist.md'], /readyToActivate: false/)
    assert.match(texts['day-seven-review.md'], /Pilot has not started/)
  })
})
