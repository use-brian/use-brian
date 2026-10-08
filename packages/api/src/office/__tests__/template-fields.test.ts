import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { documentFixture, spreadsheetFixture } from '../../../../office-model/src/__tests__/fixtures.js'
import { inferOfficeTemplateRouting } from '@use-brian/core'
import type { OfficeTemplateBundle } from '@use-brian/office-model'
import { replaceTemplateRuns, validateTemplateFieldValues } from '../template-fields.js'
import { generateDocumentFromTemplate } from '../document-generation.js'
import { generateSpreadsheetFromTemplate } from '../spreadsheet-generation.js'

function fixture() {
  const snapshot = documentFixture()
  const node = snapshot.sections[0]!.nodes[0]!
  if (node.kind !== 'paragraph') throw new Error('fixture')
  node.runs[0]!.text = '{{X}}'
  return { snapshot, node, template: { family: 'document', snapshot, fields: inferOfficeTemplateRouting(snapshot).fields, resources: [], lockedObjectIds: [], description: 'Test' } as unknown as OfficeTemplateBundle }
}

describe('[COMP:api/office-template-fields] configured template completion', () => {
  it('preserves runs, blank nodes and start-token styling across split runs', () => {
    const { node } = fixture()
    const run = node.runs[0]!
    const runs = ['Untouched ', '{{', 'X}} after', ''].map((text, i) => ({ ...run, id: String(i), text, style: { ...run.style, bold: i === 1 } }))
    const result = replaceTemplateRuns(runs, { X: 'Filled' })
    expect(result.map((r) => r.text)).toEqual(['Untouched ', 'Filled', ' after', ''])
    expect(result[0]).toBe(runs[0])
    expect(result[3]).toBe(runs[3])
    expect(result[1]!.style.bold).toBe(true)
    expect(result[2]!.style.bold).toBe(false)
    expect(replaceTemplateRuns(runs, {})).toBe(runs)
  })
  it('validates required, type, length and exact keys with optional legacy fallback', () => {
    const { template } = fixture()
    const field = template.fields[0]!
    field.required = true
    for (const value of ['', '   ']) expect(() => validateTemplateFieldValues(template, { X: value })).toThrow('required fields: X')
    field.maxLength = 3
    expect(() => validateTemplateFieldValues(template, { X: 'long' })).toThrow('maxLength')
    expect(() => validateTemplateFieldValues(template, { Y: 'hi' })).toThrow('do not match')
    field.type = 'number'
    expect(() => validateTemplateFieldValues(template, { X: 'abc' })).toThrow('number')
    expect(() => validateTemplateFieldValues(template, { X: { valueType: 'string', value: '12' } })).toThrow('number')
    expect(() => validateTemplateFieldValues(template, { X: { valueType: 'number', value: 12 } })).not.toThrow()
    field.type = 'date'
    field.maxLength = 100
    expect(() => validateTemplateFieldValues(template, { X: '2026-02-30' })).toThrow('ISO date')
    expect(() => validateTemplateFieldValues(template, { X: '2026-02-28' })).not.toThrow()
    template.fields = []
    expect(() => validateTemplateFieldValues(template, { X: '' })).not.toThrow()
  })
  it('generates custom letter tokens without dropping blank nodes or untouched runs', async () => {
    const { snapshot, node, template } = fixture()
    const run = node.runs[0]!
    node.runs = [{ ...run, text: '{{LETTER_BODY}} / {{X}}' }]
    snapshot.sections[0]!.nodes.push({ ...node, id: snapshot.rootId, runs: [{ ...run, id: snapshot.workspaceId, text: '' }] })
    template.fields = []
    const provider = { async *stream() {
      yield { type: 'text_delta', text: JSON.stringify({ title: 'Letter', values: { LETTER_BODY: 'One\nTwo', X: 'custom' } }) }
    } }
    const generated = await generateDocumentFromTemplate({ template, provider: provider as never, model: 'test', artifactId: snapshot.artifactId, workspaceId: snapshot.workspaceId, templateVersionId: snapshot.templateVersionId!, outcome: 'Letter', audience: 'Team' })
    expect(generated.sections[0]!.nodes).toHaveLength(3)
    expect(JSON.stringify(generated)).toContain('One / custom')
    expect(JSON.stringify(generated)).toContain('Two / custom')
    expect(generated.sections[0]!.nodes[2]).toEqual(snapshot.sections[0]!.nodes[1])
  })
  it.each([true, false])('preserves expanded letter metadata and split-token fit scope (configured=%s)', async configured => {
    const { snapshot, node, template } = fixture()
    const run = node.runs[0]!
    const paragraphStart = { id: randomUUID(), alignment: 'center' as const, spacingAfterPt: 7 }
    node.runs = [
      { ...run, text: '{{LETTER_', href: 'https://example.com', paragraphStart, style: { ...run.style, bold: true } },
      { ...run, id: randomUUID(), text: 'BODY}}' },
      { ...run, id: randomUUID(), text: ' / {{SUBJECT}}', style: { ...run.style, italic: true } },
    ]
    const optional = { ...node, id: randomUUID(), runs: [{ ...run, id: randomUUID(), text: '{{RECIPIENT_TITLE}}' }] }
    const blank = { ...node, id: randomUUID(), runs: [{ ...run, id: randomUUID(), text: '' }] }
    snapshot.sections[0]!.nodes.push(optional, blank)
    template.fields = configured ? inferOfficeTemplateRouting(snapshot).fields : []
    const original = structuredClone(snapshot)
    const response = configured
      ? { title: 'Letter', values: { LETTER_BODY: 'One\nTwo', SUBJECT: 'Topic', RECIPIENT_TITLE: '' } }
      : { title: 'Letter', letterDate: '2026-01-01', recipientName: 'Team', recipientTitle: '', recipientOrganisation: '', recipientAddress: [], subject: 'Topic', salutation: 'Hello', bodyParagraphs: ['One', 'Two'], closing: 'Regards', signatoryName: 'Sender', signatoryTitle: '' }
    const provider = { async *stream() { yield { type: 'text_delta', text: JSON.stringify(response) } } }
    const onFitPolicy = vi.fn()
    const generated = await generateDocumentFromTemplate({ template, provider: provider as never, model: 'test', artifactId: snapshot.artifactId, workspaceId: snapshot.workspaceId, templateVersionId: snapshot.templateVersionId!, outcome: 'Letter', audience: 'Team', onFitPolicy })
    const nodes = generated.sections[0]!.nodes
    expect(nodes).toHaveLength(3)
    expect(nodes[2]).toEqual(blank)
    const eligible: string[] = []
    const ids = new Set<string>()
    for (const [index, expanded] of nodes.slice(0, 2).entries()) {
      if (expanded.kind !== 'paragraph') throw new Error('fixture')
      expect(expanded.runs.map(run => run.text)).toEqual([index === 0 ? 'One' : 'Two', '', ' / Topic'])
      expect(expanded.runs[0]).toMatchObject({ style: node.runs[0]!.style, href: 'https://example.com', paragraphStart: { alignment: 'center', spacingAfterPt: 7 } })
      expect(expanded.runs[2]!.style).toEqual(node.runs[2]!.style)
      for (const id of [expanded.id, ...expanded.runs.map(run => run.id), expanded.runs[0]!.paragraphStart!.id]) {
        expect(ids.has(id)).toBe(false)
        expect(JSON.stringify(original)).not.toContain(id)
        ids.add(id)
      }
      eligible.push(expanded.runs[0]!.id)
    }
    expect(onFitPolicy).toHaveBeenCalledWith({ eligibleTargetIds: eligible, lockedTargetIds: [], maxAttempts: 3 })
    expect(snapshot).toEqual(original)
  })

  it('enforces configured document types before filling split tokens', async () => {
    const { snapshot, node, template } = fixture()
    const run = node.runs[0]!
    node.runs = [{ ...run, text: '{{' }, { ...run, id: randomUUID(), text: 'X}}' }]
    template.fields = inferOfficeTemplateRouting(snapshot).fields
    template.fields[0]!.type = 'number'
    template.fields[0]!.required = true
    template.fields[0]!.maxLength = 3
    let value = 'abc'
    const provider = { async *stream() { yield { type: 'text_delta', text: JSON.stringify({ title: 'Amount', values: { X: value } }) } } }
    const onFitPolicy = vi.fn()
    const generate = () => generateDocumentFromTemplate({ template, provider: provider as never, model: 'test', artifactId: snapshot.artifactId, workspaceId: snapshot.workspaceId, templateVersionId: snapshot.templateVersionId!, outcome: 'Fill', audience: 'Team', onFitPolicy })
    await expect(generate()).rejects.toThrow('requires a number')
    value = ''
    await expect(generate()).rejects.toThrow('required fields: X')
    value = '1234'
    await expect(generate()).rejects.toThrow('maxLength')
    expect(onFitPolicy).not.toHaveBeenCalled()
    value = '12'
    await expect(generate()).resolves.toBeDefined()
    expect(onFitPolicy).toHaveBeenCalledWith(expect.objectContaining({ eligibleTargetIds: [run.id] }))
  })

  it('enforces configured spreadsheet number fields before writing typed cells', async () => {
    const snapshot = spreadsheetFixture()
    const cell = snapshot.worksheets[0]!.cells[0]!
    snapshot.worksheets[0]!.cells = [{ ...cell, value: '{{AMOUNT}}', valueType: 'string', formula: undefined }]
    const template = { family: 'spreadsheet', snapshot, fields: inferOfficeTemplateRouting(snapshot).fields, resources: [], lockedObjectIds: [], description: 'Test' } as unknown as OfficeTemplateBundle
    template.fields[0]!.type = 'number'
    template.fields[0]!.required = true
    let value: unknown = { valueType: 'blank', value: null }
    const provider = { async *stream() { yield { type: 'text_delta', text: JSON.stringify({ title: 'Result', values: { AMOUNT: value } }) } } }
    const generate = () => generateSpreadsheetFromTemplate({ template, provider: provider as never, model: 'test', artifactId: snapshot.artifactId, workspaceId: snapshot.workspaceId, templateVersionId: snapshot.templateVersionId!, outcome: 'Fill', audience: 'Team' })
    await expect(generate()).rejects.toThrow('required fields: AMOUNT')
    value = { valueType: 'string', value: '12' }
    await expect(generate()).rejects.toThrow('requires a number')
    value = { valueType: 'number', value: 12 }
    const generated = await generate()
    expect(generated.worksheets[0]!.cells[0]).toMatchObject({ id: cell.id, valueType: 'number', value: 12, style: cell.style })
    expect(snapshot.worksheets[0]!.cells[0]!.value).toBe('{{AMOUNT}}')
  })

  it('rejects locked field metadata and locked source tokens, including legacy bundles', () => {
    const { template, node, snapshot } = fixture()
    template.fields[0]!.locked = true
    expect(() => validateTemplateFieldValues(template, { X: 'value' })).toThrow('Locked template tokens')
    template.fields = []
    template.lockedObjectIds = [node.id]
    expect(() => validateTemplateFieldValues(template, { X: 'value' })).toThrow('Locked template tokens')
    template.lockedObjectIds = [node.runs[0]!.id]
    expect(() => validateTemplateFieldValues(template, { X: 'value' })).toThrow('Locked template tokens')
    // An unrelated locked node does not lock header tokens in the same section.
    snapshot.sections[0]!.header = [{ ...node.runs[0]!, id: snapshot.rootId, text: '{{HEADER}}' }]
    node.runs[0]!.text = 'Fixed text'
    expect(() => validateTemplateFieldValues(template, { HEADER: 'value' })).not.toThrow()
    const workbook = spreadsheetFixture()
    const cell = workbook.worksheets[0]!.cells[0]!
    workbook.worksheets[0]!.cells = [{ ...cell, valueType: 'string', value: '{{X}}', locked: true, formula: undefined }]
    template.snapshot = workbook
    template.family = 'spreadsheet'
    template.lockedObjectIds = []
    expect(() => validateTemplateFieldValues(template, { X: 'value' })).toThrow('Locked template tokens')
  })

})
