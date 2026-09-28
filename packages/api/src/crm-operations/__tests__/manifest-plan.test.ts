import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const { planManifest, manifestCommand, sameManifestBefore } = await import(new URL('../../../../../scripts/crm/manifest-plan.mjs', import.meta.url).href)
const { parseManifest } = await import(new URL('../../../../../scripts/crm/manifest-client.mjs', import.meta.url).href)
const fixture = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/community-manifest.v1.json', import.meta.url), 'utf8'))
const empty = () => ({ recordFields: [], pipelines: [], consentPurposes: [], entitlementPlans: [], events: [], intakeDefinitions: [], segments: [],
  segmentCatalogs: { person: [], company: [], deal: [] } })
const base = { schemaVersion: 1, sourceLabel: 'Planner fixture' }
const pipeline = (id = randomUUID(), name = 'Review', isDefault = false) => ({ id, name, isDefault, stages: [], archivedAt: null })

describe('[COMP:crm/manifest] Pure identity resolution and command planning', () => {
  it('projects every fixture dependency without inventing an id for an uncreated parent', () => {
    const catalog = empty(), before = structuredClone(catalog)
    const planned = planManifest(fixture, catalog)
    expect(planned.changes).toHaveLength(9)
    expect(catalog).toEqual(before)
    const stage = planned.steps.find((step: { resource: string }) => step.resource === 'pipelineStages')
    expect(stage.pipelineId).toBeNull()
    expect(() => manifestCommand(stage)).toThrow('unresolved_pipeline_reference')
    expect(manifestCommand(planned.steps[0]).kind).toBe('create_record_field')
  })

  it('rejects ambiguous names, foreign ids, duplicate id bindings and archived matches', () => {
    const one = pipeline(), two = pipeline()
    const input = { ...base, pipelines: [{ ref: 'review', value: { name: 'Review' } }] }
    expect(() => planManifest(input, { ...empty(), pipelines: [one, two] })).toThrow('ambiguous_configuration')
    expect(() => planManifest({ ...base, pipelines: [{ ref: 'review', id: randomUUID(), value: { name: 'Review' } }] }, { ...empty(), pipelines: [one] })).toThrow('configuration_id_unavailable')
    expect(() => planManifest(input, { ...empty(), pipelines: [{ ...one, archivedAt: '2099-01-01T00:00:00Z' }] })).toThrow('archived_configuration')
    expect(() => planManifest({ ...base, pipelines: [
      { ref: 'one', id: one.id, value: { name: 'First' } }, { ref: 'two', id: one.id, value: { name: 'Second' } },
    ] }, { ...empty(), pipelines: [one] })).toThrow('duplicate_id_binding')
  })

  it('uses explicit ids for rename and refuses immutable field identity/type changes', () => {
    const row = pipeline()
    const plan = planManifest({ ...base, pipelines: [{ ref: 'rename', id: row.id, value: { name: 'Approval' } }] }, { ...empty(), pipelines: [row] })
    expect(manifestCommand(plan.steps[0])).toMatchObject({ kind: 'update_pipeline', pipelineId: row.id, name: 'Approval' })
    const field = { id: randomUUID(), ...fixture.recordFields[0].value, isRequired: false, archivedAt: null }
    expect(() => planManifest({ ...base, recordFields: [{ ref: 'field', id: field.id, value: { ...fixture.recordFields[0].value, fieldKey: 'changed' } }] },
      { ...empty(), recordFields: [field] })).toThrow('immutable_configuration_identity')
    expect(() => planManifest({ ...base, recordFields: [{ ...fixture.recordFields[0], value: { ...fixture.recordFields[0].value, fieldType: 'text' } }] },
      { ...empty(), recordFields: [field] })).toThrow('immutable_field_type')
  })

  it('switches the default before clearing a declared old default, and refuses default removal without a replacement', () => {
    const old = pipeline(randomUUID(), 'Old', true)
    const plan = planManifest({ ...base, pipelines: [
      { ref: 'old', id: old.id, value: { name: 'Old', isDefault: false } },
      { ref: 'new', value: { name: 'New', isDefault: true } },
    ] }, { ...empty(), pipelines: [old] })
    expect(plan.changes.map((change: { ref: string }) => change.ref)).toEqual(['new'])
    expect(() => planManifest({ ...base, pipelines: [{ ref: 'old', value: { name: 'Old' } }] }, { ...empty(), pipelines: [old] })).toThrow('choose_default_pipeline')
  })

  it('normalizes money/instants and preserves optional values when building replacement commands', () => {
    const event = { id: randomUUID(), ...fixture.events[0].value, description: '', metadata: {},
      startsAt: '2099-06-01T12:00:00+02:00', endsAt: '2099-06-01T13:00:00+02:00' }
    expect(planManifest({ ...base, events: fixture.events }, { ...empty(), events: [event] }).changes).toEqual([])
    const changed = { ...fixture.events[0], value: { ...fixture.events[0].value, title: 'Changed' } }; delete changed.value.venue
    const step = planManifest({ ...base, events: [changed] }, { ...empty(), events: [event] }).steps[0]
    expect(manifestCommand(step).venue).toBe('Fictional community room')
    expect(sameManifestBefore(step, { ...step, before: { ...step.before, venue: 'Concurrent optional venue' } })).toBe(true)
    expect(sameManifestBefore(step, { ...step, before: { ...step.before, title: 'Concurrent title' } })).toBe(false)
    const plan = { id: randomUUID(), ...fixture.entitlementPlans[0].value, planKey: 'community', feeMinor: '0', benefits: [] }
    expect(planManifest({ ...base, entitlementPlans: fixture.entitlementPlans }, { ...empty(), entitlementPlans: [plan] }).changes).toEqual([])
  })

  it('retains attachment policy in an existing intake-definition projection', () => {
    const parsed = parseManifest(fixture)
    const value = parsed.intakeDefinitions[0].value
    const catalog = {
      ...empty(),
      recordFields: [{ id: randomUUID(), ...fixture.recordFields[0].value, isRequired: false, archivedAt: null }],
      consentPurposes: [{ id: randomUUID(), description: '', archivedAt: null, ...fixture.consentPurposes[0].value }],
    }
    const row = {
      id: randomUUID(), definitionKey: value.definitionKey, label: value.label, active: true,
      currentVersion: 1, ...value.definition,
    }
    expect(planManifest({ ...base, intakeDefinitions: parsed.intakeDefinitions }, {
      ...catalog, intakeDefinitions: [row],
    }).changes).toEqual([])
    const missing = structuredClone(row)
    delete missing.attachments
    expect(planManifest({ ...base, intakeDefinitions: parsed.intakeDefinitions }, {
      ...catalog, intakeDefinitions: [missing],
    }).changes).toMatchObject([{ resource: 'intakeDefinitions', ref: 'community_application', action: 'update' }])
  })

  it('updates an unverified intake definition in either direction but leaves a trusted one to its owner', () => {
    const parsed = parseManifest(fixture)
    const value = parsed.intakeDefinitions[0].value
    const catalog = {
      ...empty(),
      recordFields: [{ id: randomUUID(), ...fixture.recordFields[0].value, isRequired: false, archivedAt: null }],
      consentPurposes: [{ id: randomUUID(), description: '', archivedAt: null, ...fixture.consentPurposes[0].value }],
    }
    const row = (identityPolicy: string) => ({
      id: randomUUID(), definitionKey: value.definitionKey, label: value.label, active: true,
      currentVersion: 1, ...value.definition, identityPolicy,
    })
    const reuse = [{ ...parsed.intakeDefinitions[0], value: { ...value, definition: { ...value.definition, identityPolicy: 'existing_or_new' } } }]
    expect(planManifest({ ...base, intakeDefinitions: reuse }, { ...catalog, intakeDefinitions: [row('new_or_review')] }).changes)
      .toMatchObject([{ resource: 'intakeDefinitions', action: 'update' }])
    expect(planManifest({ ...base, intakeDefinitions: reuse }, { ...catalog, intakeDefinitions: [row('existing_or_new')] }).changes).toEqual([])
    expect(() => planManifest({ ...base, intakeDefinitions: reuse }, { ...catalog, intakeDefinitions: [row('trusted_verified_email')] }))
      .toThrow('trusted_definition_requires_owner')
  })
})
