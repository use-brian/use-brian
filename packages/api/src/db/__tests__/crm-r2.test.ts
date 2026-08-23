import { describe, expect, it } from 'vitest'
import {
  buildCrmReport,
  buildCrmEmailReviewThread,
  crmRowsToCsv,
  findCrmDuplicateGroups,
  validateCustomFieldValue,
  type CrmConfig,
  type CrmRecordRow,
} from '../crm-r2.js'

const CONFIG: CrmConfig = {
  pipelines: [{
    id: 'pipeline-1',
    name: 'Sales',
    isDefault: true,
    position: 0,
    stages: [
      { id: 'lead-id', pipelineId: 'pipeline-1', name: 'Lead', legacyKey: 'lead', category: 'open', position: 0, probability: 10, requiredFields: [] },
      { id: 'won-id', pipelineId: 'pipeline-1', name: 'Won', legacyKey: 'won', category: 'won', position: 1, probability: 100, requiredFields: [] },
      { id: 'lost-id', pipelineId: 'pipeline-1', name: 'Lost', legacyKey: 'lost', category: 'lost', position: 2, probability: 0, requiredFields: [] },
    ],
  }],
  fields: [],
}

function row(overrides: Partial<CrmRecordRow>): CrmRecordRow {
  return {
    id: 'record-1',
    kind: 'deal',
    name: 'Example deal',
    attributes: {},
    archivedAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
    ...overrides,
  }
}

describe('[COMP:crm/r2-store] deterministic CRM R2 projections', () => {
  it('finds exact email/domain duplicates and normalized-name candidates', () => {
    const groups = findCrmDuplicateGroups([
      row({ id: 'p1', kind: 'person', name: 'Jane Doe', attributes: { email: 'Jane <JANE@example.test>' } }),
      row({ id: 'p2', kind: 'person', name: 'Jane  Doe', attributes: { email: 'jane@example.test' } }),
      row({ id: 'c1', kind: 'company', name: 'Acme One', attributes: { domain: 'https://www.acme.example/about' } }),
      row({ id: 'c2', kind: 'company', name: 'Acme Two', attributes: { domain: 'acme.example' } }),
      row({ id: 'p3', kind: 'person', name: '陳 大文', attributes: {} }),
      row({ id: 'p4', kind: 'person', name: '陳大文', attributes: {} }),
    ])
    expect(groups.some((g) => g.reason === 'email' && g.records.length === 2)).toBe(true)
    expect(groups.some((g) => g.reason === 'name' && g.records.length === 2)).toBe(true)
    expect(groups.some((g) => g.reason === 'domain' && g.records.length === 2)).toBe(true)
    expect(groups.some((g) => g.reason === 'name' && g.value === '陳大文')).toBe(true)
  })

  it('groups currency totals, weights open value, and refuses to invent velocity', () => {
    const report = buildCrmReport([
      row({ id: 'd1', attributes: { pipeline_stage_id: 'lead-id', amount: 1000, currency_code: 'USD' } }),
      row({ id: 'd2', attributes: { pipeline_stage_id: 'won-id', stage: 'won', amount: 500, currency_code: 'EUR', owner_id: 'u1' } }),
      row({ id: 'd3', attributes: { pipeline_stage_id: 'lost-id', stage: 'lost', amount: 200, currency_code: 'EUR', owner_id: 'u1' } }),
      row({ id: 'd4', attributes: { pipeline_stage_id: 'lead-id', stage: 'won', amount: 300, currency_code: 'USD', owner_id: 'u1' } }),
    ], CONFIG)
    expect(report.openValue).toEqual({ USD: 1000 })
    expect(report.weightedForecast).toEqual({ USD: 100 })
    expect(report.winRate).toBeCloseTo(66.67)
    expect(report.stageVelocityDays.every((stage) => stage.medianDays === null)).toBe(true)
  })

  it('validates bounded custom-field types', () => {
    expect(validateCustomFieldValue({ fieldType: 'number', options: [], isRequired: true }, 12)).toBe(true)
    expect(validateCustomFieldValue({ fieldType: 'number', options: [], isRequired: true }, '12')).toBe(false)
    expect(validateCustomFieldValue({ fieldType: 'single_select', options: ['A'], isRequired: false }, 'B')).toBe(false)
    expect(validateCustomFieldValue({ fieldType: 'date', options: [], isRequired: false }, '2026-02-29')).toBe(false)
    expect(validateCustomFieldValue({ fieldType: 'date', options: [], isRequired: false }, '2028-02-29')).toBe(true)
    expect(validateCustomFieldValue({ fieldType: 'entity_reference', options: ['company'], isRequired: false }, 'd126f352-7f5c-48b2-88d0-66694be0c93d')).toBe(true)
    expect(validateCustomFieldValue({ fieldType: 'entity_reference', options: ['company'], isRequired: false }, 'Example Company')).toBe(false)
  })

  it('exports RFC-style escaped CSV without merging currencies', () => {
    const csv = crmRowsToCsv([
      row({ name: 'Deal, one', attributes: { stage: 'lead', amount: 10, currency_code: 'HKD' } }),
    ], 'deal')
    expect(csv).toContain('currency_code')
    expect(csv).toContain('"Deal, one"')
    expect(csv).toContain('HKD')
  })

  it('exports typed custom fields as re-importable columns', () => {
    const csv = crmRowsToCsv([
      row({ attributes: { custom_fields: { work_type: 'SaaS', audiences: ['Portfolio', 'Partners'] } } }),
    ], 'deal', [
      { id: 'f1', entityKind: 'deal', fieldKey: 'work_type', label: 'Work type', fieldType: 'single_select', options: ['SaaS'], isRequired: false, position: 0 },
      { id: 'f2', entityKind: 'deal', fieldKey: 'audiences', label: 'Audiences', fieldType: 'multi_select', options: ['Portfolio', 'Partners'], isRequired: false, position: 1 },
    ])
    expect(csv.split('\n')[0]).toContain('Work type,Audiences')
    expect(csv).toContain('SaaS,Portfolio|Partners')
  })

  it('anchors an oldest-first bounded archived email thread with honest truncation', () => {
    const messages = Array.from({ length: 102 }, (_, index) => ({
      id: `row-${index}`,
      providerMessageId: `INBOX:${index + 1}`,
      folder: 'INBOX',
      fromAddr: index % 2 ? 'Sales <sales@example.test>' : 'Client <client@example.test>',
      toAddrs: [index % 2 ? 'client@example.test' : 'sales@example.test'],
      ccAddrs: [],
      sentAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
      subject: index === 0 ? 'Contract question' : 'Re: Contract question',
      bodyText: index === 101 ? 'x'.repeat(12_001) : `Message ${index + 1}`,
      rfcMessageId: `<message-${index + 1}@example.test>`,
      inReplyTo: index === 0 ? null : `<message-${index}@example.test>`,
      referencesIds: index === 0 ? [] : [`<message-1@example.test>`, `<message-${index}@example.test>`],
    }))
    const thread = buildCrmEmailReviewThread(messages, 'INBOX:102')
    expect(thread?.messages).toHaveLength(100)
    expect(thread?.messages[0].id).toBe('INBOX:3')
    expect(thread?.messages.at(-1)?.id).toBe('INBOX:102')
    expect(thread?.messages.at(-1)?.body).toHaveLength(12_000)
    expect(thread?.messages.at(-1)?.bodyTruncated).toBe(true)
    expect(thread?.truncated).toBe(true)
  })
})
