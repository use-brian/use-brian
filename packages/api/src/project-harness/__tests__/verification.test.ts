import { describe, expect, it } from 'vitest'
import {
  buildVerificationPreview,
  runAutomaticVerification,
  validateVerificationResult,
  type VerificationPreview,
  type VerificationPreviewInput,
} from '../verification.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function fixture(): VerificationPreviewInput {
  return {
    runId: uuid(1),
    revision: {
      id: uuid(2), workspaceId: uuid(3), projectId: uuid(4),
      scope: { kind: 'component', productId: uuid(5), componentId: uuid(6) },
      revision: 7, createdBy: uuid(8), createdAt: '2026-01-01T00:00:00Z',
      definition: {
        schemaVersion: 1,
        rules: [{ key: 'internal-rule', kind: 'local', value: 'Do not forward internal rules' }],
        codeChecks: [{ key: 'unit', kind: 'unit', instructions: 'Internal test instructions', command: 'pnpm test' }],
        acceptanceScenarios: [{
          key: 'calendar', title: 'Choose a date',
          preconditions: ['Calendar is empty'], steps: ['Open calendar', 'Choose January 2'],
          criteria: [
            { key: 'visible', observation: 'Calendar appears', evidence: 'Screenshot of visible calendar' },
            { key: 'selected', observation: 'January 2 is selected', evidence: 'Screenshot of selected date' },
          ],
        }, {
          key: 'unrelated', title: 'Unrelated scenario', preconditions: ['Other state'],
          steps: ['Other action'], criteria: [{ key: 'other', observation: 'Other observation', evidence: 'Other evidence' }],
        }],
      },
    },
    scenarioKey: 'calendar',
    build: { buildId: 'build-123', deploymentId: 'deployment-456' },
    target: { url: 'https://app.example.test/calendar', permittedOrigins: ['https://app.example.test'] },
    environment: { environmentId: 'qa', locale: 'en-US', timezone: 'UTC', viewport: { width: 1280, height: 720 } },
  }
}
function report(packet: VerificationPreview) {
  return {
    binding: {
      runId: packet.runId, packetSha256: packet.packetSha256,
      specification: structuredClone(packet.specification),
      build: { ...packet.build }, scenarioKey: packet.scenario.key,
    },
    status: 'passed',
    criteria: packet.scenario.criteria.map(c => ({ criterionKey: c.key, status: 'passed', evidenceIds: [`e-${c.key}`], reason: undefined as string | undefined })),
    evidence: packet.scenario.criteria.map(c => ({ id: `e-${c.key}`, criterionKey: c.key, kind: 'screenshot', reference: `artifact-${c.key}` })),
  }
}

// Deliberate invalid fields at unknown-input runtime boundaries.
function add(object: object, field: string, value: unknown = 'contamination') {
  Object.assign(object, { [field]: value })
}

describe('non-dispatchable verifier preview', () => {
  it('allowlists one scenario and pins run, scope, revision, build, deployment and environment', () => {
    const input = fixture()
    const packet = buildVerificationPreview(input)
    expect(packet.kind).toBe('non_dispatchable_acceptance_preview')
    expect(packet.runId).toBe(input.runId)
    expect(packet.specification).toMatchObject({
      workspaceId: input.revision.workspaceId, projectId: input.revision.projectId,
      scope: input.revision.scope, revisionId: input.revision.id, revision: 7,
    })
    expect(packet.specification.definitionSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(packet.specification.scenarioSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(packet.build).toEqual(input.build)
    expect(packet.target).toEqual(input.target)
    expect(packet.environment).toEqual(input.environment)
    expect(packet.scenario).toEqual(input.revision.definition.acceptanceScenarios[0])
    for (const value of ['Internal test instructions', 'pnpm test', 'Do not forward internal rules', 'Unrelated scenario', 'createdBy', 'approved', 'capabilities']) {
      expect(JSON.stringify(packet)).not.toContain(value)
    }
    expect(buildVerificationPreview(fixture())).toEqual(packet)
  })

  it('clones then deeply freezes rather than retaining or freezing caller state', () => {
    const input = fixture()
    const packet = buildVerificationPreview(input)
    const original = JSON.stringify(packet)
    input.revision.definition.acceptanceScenarios[0]!.criteria[0]!.observation = 'Weakened'
    input.revision.definition.acceptanceScenarios[0]!.steps.push('Changed')
    input.build.buildId = 'new-build'
    input.target.permittedOrigins.push('https://evil.test')
    input.environment.viewport.width = 500
    expect(JSON.stringify(packet)).toBe(original)
    expect(Object.isFrozen(input)).toBe(false)
    expect(Object.isFrozen(packet.scenario.criteria[0])).toBe(true)
    expect(Object.isFrozen(packet.target.permittedOrigins)).toBe(true)
    expect(Object.isFrozen(packet.environment.viewport)).toBe(true)
    expect(() => add(packet.scenario.criteria[0]!, 'observation', 'Changed')).toThrow()
    expect(() => add(packet.build, 'buildId', 'Changed')).toThrow()
  })

  it.each(['context', 'source', 'code', 'parentTranscript', 'implementationExplanation', 'credentials', 'cookies', 'headers', 'approved', 'capabilities', 'isolated'])('rejects top-level %s instead of stripping it', field => {
    const input = fixture()
    add(input, field, true)
    expect(() => buildVerificationPreview(input)).toThrow()
  })

  it.each(['revision', 'definition', 'scope', 'scenario', 'criterion', 'build', 'target', 'environment', 'viewport'])('rejects nested contamination in %s', location => {
    const input = fixture()
    const objects: Record<string, object> = {
      revision: input.revision, definition: input.revision.definition, scope: input.revision.scope,
      scenario: input.revision.definition.acceptanceScenarios[0]!,
      criterion: input.revision.definition.acceptanceScenarios[0]!.criteria[0]!,
      build: input.build, target: input.target, environment: input.environment, viewport: input.environment.viewport,
    }
    add(objects[location]!, 'parentTranscript')
    expect(() => buildVerificationPreview(input)).toThrow()
  })

  it('rejects approval assertions on a revision or scenario', () => {
    for (const location of ['revision', 'scenario']) {
      const input = fixture()
      add(location === 'revision' ? input.revision : input.revision.definition.acceptanceScenarios[0]!, 'approved', true)
      expect(() => buildVerificationPreview(input)).toThrow()
    }
  })

  it.each(['unknown-scenario', 'empty-criteria', 'duplicate-criteria', 'missing-evidence-description'])('rejects invalid scenario: %s', issue => {
    const input = fixture()
    const scenario = input.revision.definition.acceptanceScenarios[0]!
    if (issue === 'unknown-scenario') input.scenarioKey = 'absent'
    if (issue === 'empty-criteria') scenario.criteria = []
    if (issue === 'duplicate-criteria') scenario.criteria.push({ ...scenario.criteria[0]! })
    if (issue === 'missing-evidence-description') scenario.criteria[0]!.evidence = ''
    expect(() => buildVerificationPreview(input)).toThrow()
  })

  it.each([
    'http://app.example.test/calendar', 'javascript:alert(1)',
    'https://user:password@app.example.test/calendar',
    'https://app.example.test/calendar?token=secret', 'https://app.example.test/calendar#secret',
    'https://app.example.test/calendar?', 'https://app.example.test/calendar#',
    'https://app.example.test.evil.test/calendar', 'https://app.example.test:8443/calendar',
    'https://evil.test/calendar', 'https://app.example.test/../calendar',
  ])('rejects unsafe/unpermitted target %s', url => {
    const input = fixture()
    input.target.url = url
    expect(() => buildVerificationPreview(input)).toThrow()
  })

  it.each(['*', 'https://*.example.test', 'https://app.example.test/', 'https://app.example.test/path', 'https://app.example.test?token=secret', 'https://user:secret@app.example.test', 'http://app.example.test'])('rejects malformed origin %s', origin => {
    const input = fixture()
    input.target.permittedOrigins.push(origin)
    expect(() => buildVerificationPreview(input)).toThrow()
  })

  it('requires a nonempty unique origin allowlist; accepts an explicitly permitted HTTPS port', () => {
    const input = fixture()
    input.target.permittedOrigins = []
    expect(() => buildVerificationPreview(input)).toThrow()
    input.target.permittedOrigins = ['https://app.example.test', 'https://app.example.test']
    expect(() => buildVerificationPreview(input)).toThrow()
    input.target.url = 'https://app.example.test:8443/calendar'
    input.target.permittedOrigins = ['https://app.example.test:8443']
    expect(buildVerificationPreview(input).target).toEqual(input.target)
  })

  it('changes binding when scenario, definition, environment or target changes', () => {
    const original = buildVerificationPreview(fixture())
    for (const field of ['scenario', 'definition', 'environment', 'target']) {
      const input = fixture()
      if (field === 'scenario') input.revision.definition.acceptanceScenarios[0]!.criteria[0]!.evidence = 'Recording'
      if (field === 'definition') input.revision.definition.codeChecks[0]!.instructions = 'Different check'
      if (field === 'environment') input.environment.locale = 'de-DE'
      if (field === 'target') input.target.url = 'https://app.example.test/other'
      expect(buildVerificationPreview(input).packetSha256).not.toBe(original.packetSha256)
    }
  })
})

describe('structural result validation (not evidence authenticity)', () => {
  it('accepts a complete report, clones/freezes it, and makes no evidence trust claim', () => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    const result = validateVerificationResult(packet, input)
    expect(result.status).toBe('passed')
    expect(result).not.toHaveProperty('trusted')
    input.evidence[0]!.reference = 'changed'
    input.criteria[0]!.evidenceIds.push('changed')
    expect(result.evidence[0]!.reference).toBe('artifact-visible')
    expect(result.criteria[0]!.evidenceIds).toEqual(['e-visible'])
    expect(Object.isFrozen(result.binding.specification.scope)).toBe(true)
    expect(Object.isFrozen(result.evidence[0])).toBe(true)
  })

  it.each(['failed', 'blocked', 'inconclusive'])('accepts reasoned %s without fabricated evidence, not an overall pass', status => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    input.criteria[0] = { criterionKey: 'visible', status, evidenceIds: [], reason: 'Not established' }
    input.evidence.shift()
    input.status = status
    expect(validateVerificationResult(packet, input).status).toBe(status)
    input.status = 'passed'
    expect(() => validateVerificationResult(packet, input)).toThrow()
    input.status = status
    input.criteria[0]!.reason = undefined
    expect(() => validateVerificationResult(packet, input)).toThrow()
  })

  it.each(['empty', 'missing', 'duplicate', 'foreign'])('rejects %s criterion results', issue => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    if (issue === 'empty') input.criteria = []
    if (issue === 'missing') input.criteria.pop()
    if (issue === 'duplicate') input.criteria.push({ ...input.criteria[0]! })
    if (issue === 'foreign') input.criteria[1]!.criterionKey = 'foreign'
    expect(() => validateVerificationResult(packet, input)).toThrow()
  })

  it.each(['no-evidence-on-pass', 'missing-record', 'missing-id', 'duplicate-record', 'duplicate-ref', 'foreign-ref', 'foreign-criterion', 'unreferenced'])('rejects evidence defect %s', issue => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    if (issue === 'no-evidence-on-pass') { input.criteria[0]!.evidenceIds = []; input.evidence.shift() }
    if (issue === 'missing-record') input.evidence.shift()
    if (issue === 'missing-id') input.criteria[0]!.evidenceIds = ['absent']
    if (issue === 'duplicate-record') input.evidence.push({ ...input.evidence[0]! })
    if (issue === 'duplicate-ref') input.criteria[0]!.evidenceIds.push('e-visible')
    if (issue === 'foreign-ref') input.criteria[0]!.evidenceIds = ['e-selected']
    if (issue === 'foreign-criterion') input.evidence[0]!.criterionKey = 'foreign'
    if (issue === 'unreferenced') input.evidence.push({ ...input.evidence[0]!, id: 'unused' })
    expect(() => validateVerificationResult(packet, input)).toThrow()
  })

  it.each(['run', 'packet', 'revision-id', 'revision-number', 'definition-hash', 'scenario-hash', 'workspace', 'project', 'scope', 'scenario', 'build', 'deployment'])('rejects %s binding mismatch', field => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    const binding = input.binding
    if (field === 'run') binding.runId = uuid(99)
    if (field === 'packet') binding.packetSha256 = '0'.repeat(64)
    if (field === 'revision-id') add(binding.specification, 'revisionId', uuid(99))
    if (field === 'revision-number') add(binding.specification, 'revision', 8)
    if (field === 'definition-hash') add(binding.specification, 'definitionSha256', '0'.repeat(64))
    if (field === 'scenario-hash') add(binding.specification, 'scenarioSha256', '0'.repeat(64))
    if (field === 'workspace') add(binding.specification, 'workspaceId', uuid(99))
    if (field === 'project') add(binding.specification, 'projectId', uuid(99))
    if (field === 'scope') add(binding.specification, 'scope', { kind: 'project' })
    if (field === 'scenario') binding.scenarioKey = 'unrelated'
    if (field === 'build') binding.build.buildId = 'other-build'
    if (field === 'deployment') binding.build.deploymentId = 'other-deployment'
    expect(() => validateVerificationResult(packet, input)).toThrow()
  })

  it.each(['result', 'binding', 'criterion', 'evidence'])('rejects extra trust/context claims on %s', field => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    const objects: Record<string, object> = { result: input, binding: input.binding, criterion: input.criteria[0]!, evidence: input.evidence[0]! }
    add(objects[field]!, 'trusted', true)
    expect(() => validateVerificationResult(packet, input)).toThrow()
  })

  it('rejects stale results against a new build or specification', () => {
    const old = buildVerificationPreview(fixture())
    const input = fixture()
    input.build.buildId = 'repair-build'
    expect(() => validateVerificationResult(buildVerificationPreview(input), report(old))).toThrow()
    input.build.buildId = 'build-123'
    input.revision.definition.acceptanceScenarios[0]!.criteria[0]!.observation = 'New expectation'
    expect(() => validateVerificationResult(buildVerificationPreview(input), report(old))).toThrow()
  })

  it('prioritizes failed over blocked and blocked over inconclusive', () => {
    const packet = buildVerificationPreview(fixture())
    const input = report(packet)
    input.evidence = []
    input.criteria.forEach(c => { c.evidenceIds = []; c.reason = 'Not established' })
    input.criteria[0]!.status = 'blocked'
    input.criteria[1]!.status = 'inconclusive'
    input.status = 'blocked'
    expect(validateVerificationResult(packet, input).status).toBe('blocked')
    input.criteria[1]!.status = 'failed'
    input.status = 'failed'
    expect(validateVerificationResult(packet, input).status).toBe('failed')
  })
})

describe('automatic execution remains unavailable', () => {
  it('returns blocked isolated_verifier_unavailable for every criterion and no evidence', () => {
    const packet = buildVerificationPreview(fixture())
    const result = runAutomaticVerification(packet)
    expect(result.status).toBe('blocked')
    expect(result.evidence).toEqual([])
    expect(result.criteria).toEqual(packet.scenario.criteria.map(c => ({
      criterionKey: c.key, status: 'blocked', evidenceIds: [], reason: 'isolated_verifier_unavailable',
    })))
    expect(validateVerificationResult(packet, result)).toEqual(result)
  })

  it.each(['approved', 'capabilities', 'parentTranscript', 'browser', 'spawnWorker'])('rejects injected %s rather than enabling a fallback', field => {
    const packet = structuredClone(buildVerificationPreview(fixture()))
    add(packet, field, true)
    expect(() => runAutomaticVerification(packet)).toThrow()
  })

  it('rejects tampered previews and runnable labels', () => {
    const packet = buildVerificationPreview(fixture())
    const changed = structuredClone(packet)
    add(changed.scenario.criteria[0]!, 'observation', 'Changed')
    expect(() => runAutomaticVerification(changed)).toThrow()
    expect(() => validateVerificationResult(changed, report(packet))).toThrow()
    expect(() => runAutomaticVerification({ ...packet, kind: 'approved_runnable' })).toThrow()
  })
})
