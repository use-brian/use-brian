import { describe, expect, it } from 'vitest'
import { CrmManifestSchema } from '../manifest.js'

const base = { schemaVersion: 1, sourceLabel: 'Fictional community fixture' }
const field = { ref: 'level', value: { entityKind: 'person', fieldKey: 'level', label: 'Level', fieldType: 'multi_select', options: ['Standard', 'Plus'] } }
const definition = { ref: 'application', sensitiveFieldKeys: ['private_note'], value: {
  definitionKey: 'application', label: 'Application', definition: { identityPolicy: 'new_or_review', fields: [
    { key: 'name', label: 'Name', type: 'text', mapping: { kind: 'base_field', field: 'name' } },
    { key: 'private_note', label: 'Private note', type: 'text', mapping: { kind: 'submission_only' } },
  ] },
} }

describe('[COMP:crm/manifest] Versioned canonical manifest schema', () => {
  it('derives canonical defaults and accepts typed configuration without command authority', () => {
    const result = CrmManifestSchema.parse({ ...base, recordFields: [field], intakeDefinitions: [definition],
      pipelines: [{ ref: 'pipeline', value: { name: 'Review' } }],
      pipelineStages: [{ ref: 'new', pipelineRef: 'pipeline', value: { name: 'New', category: 'open', probability: 10 } }],
    })
    expect(result.recordFields[0].value).toMatchObject({ isRequired: false })
    expect(result.recordFields[0].value).not.toHaveProperty('kind')
    expect(result.intakeDefinitions[0].value.definition).toMatchObject({ maxPayloadBytes: 65_536, queueKey: 'general', consentMappings: [] })
    expect(result.pipelineStages[0].value.requiredFields).toEqual([])
    expect(result.segments).toEqual([])
  })

  it('rejects unknown types, silent compatibility-schema properties, authority, versions and broken references', () => {
    for (const value of [
      { ...base, schemaVersion: 2 },
      { ...base, token: 'fictional_secret' },
      { ...base, recordFields: [{ ...field, value: { ...field.value, fieldType: 'string_array' } }] },
      { ...base, recordFields: [field, { ...field, ref: 'another' }] },
      { ...base, intakeDefinitions: [{ ...definition, value: { ...definition.value, expectedVersion: 1 } }] },
      { ...base, intakeDefinitions: [{ ...definition, value: { ...definition.value, definition: { ...definition.value.definition, invented: true } } }] },
      { ...base, pipelineStages: [{ ref: 'stage', pipelineRef: 'absent', value: { name: 'New', category: 'open', probability: 10 } }] },
      { ...base, recordFields: [field], pipelines: [{ ref: field.ref, value: { name: 'Review' } }] },
    ]) expect(CrmManifestSchema.safeParse(value).success).toBe(false)
  })

  it('keeps sensitive fields submission-only and refuses trusted setup or malformed predicates', () => {
    const changed = structuredClone(definition)
    changed.value.definition.fields[1].mapping = { kind: 'base_field', field: 'name' }
    expect(CrmManifestSchema.safeParse({ ...base, intakeDefinitions: [changed] }).success).toBe(false)
    expect(CrmManifestSchema.safeParse({ ...base, intakeDefinitions: [{ ...definition, value: { ...definition.value,
      definition: { ...definition.value.definition, identityPolicy: 'trusted_verified_email' } } }] }).success).toBe(false)
    // The unverified reuse policy needs no owner setup, so a manifest may declare it.
    expect(CrmManifestSchema.safeParse({ ...base, intakeDefinitions: [{ ...definition, value: { ...definition.value,
      definition: { ...definition.value.definition, identityPolicy: 'existing_or_new' } } }] }).success).toBe(true)
    expect(CrmManifestSchema.safeParse({ ...base, segments: [{ ref: 'segment', value: {
      segmentKey: 'segment', name: 'Segment', entityKind: 'person', predicate: { arbitrary: true },
    } }] }).success).toBe(false)
  })

  it('accepts string wording versions and derives supported locales and plan/event enums', () => {
    const purpose = { ref: 'news', value: { purposeKey: 'news', label: 'News', wordingVersion: '1', wording: 'Receive fictional news.',
      defaultLocale: 'en', localeWordings: { en: 'Receive fictional news.' } } }
    expect(CrmManifestSchema.parse({ ...base, consentPurposes: [purpose] }).consentPurposes[0].value.wordingVersion).toBe('1')
    expect(CrmManifestSchema.safeParse({ ...base, consentPurposes: [{ ...purpose, value: { ...purpose.value, wordingVersion: 1 } }] }).success).toBe(false)
    expect(CrmManifestSchema.safeParse({ ...base, consentPurposes: [{ ...purpose, value: { ...purpose.value, archived: true } }] }).success).toBe(false)
    expect(CrmManifestSchema.safeParse({ ...base, consentPurposes: [{ ...purpose, value: { ...purpose.value, localeWordings: { unsupported: 'Words' } } }] }).success).toBe(false)
    expect(CrmManifestSchema.safeParse({ ...base, entitlementPlans: [{ ref: 'plan', value: { key: 'plan', name: 'Plan', currency: 'usd', feeMinor: 0, billingPeriod: 'invalid' } }] }).success).toBe(false)
  })
})
