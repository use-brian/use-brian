import { OfficeMaterialFactMissing } from '@use-brian/core'
import { officeTemplateLockedTokenNames, officeTemplateTokenDiagnostics, officeTemplateTokenTargets, type OfficeTemplateBundle, type OfficeRichTextRun } from '@use-brian/office-model'

export function templateFieldGuidance(template: OfficeTemplateBundle): string {
  const locked = officeTemplateLockedTokenNames(template.snapshot, template.fields, template.lockedObjectIds)
  if (locked.length) throw new Error(`Locked template tokens cannot be filled: ${locked.join(', ')}`)
  if (template.fields.length) {
    const errors = officeTemplateTokenDiagnostics(template.snapshot, template.fields)
    if (errors.length) throw new Error(errors.join('; '))
    return JSON.stringify(template.fields.map(({ name, type, required, maxLength, aiInstruction }) => ({ name, type, required, maxLength, aiInstruction })))
  }
  return JSON.stringify([...officeTemplateTokenTargets(template.snapshot).keys()].map((name) => ({ name, required: false })))
}

export function validateTemplateFieldValues(template: OfficeTemplateBundle, values: Record<string, string | { valueType: string; value: string | number | boolean | null }>): void {
  templateFieldGuidance(template)
  const expected = officeTemplateTokenTargets(template.snapshot)
  if (!expected.size || Object.keys(values).length !== expected.size || [...expected.keys()].some((name) => !Object.hasOwn(values, name))) throw new Error('Template response fields do not match the admitted tokens')
  const missing: string[] = []
  for (const field of template.fields) {
    const entry = values[field.name]!
    const value = typeof entry === 'string' ? entry : entry.value
    if (field.maxLength !== undefined && value !== null && String(value).length > field.maxLength) throw new Error(`Field ${field.name} exceeds maxLength ${field.maxLength}`)
    const blank = value === null || typeof value === 'string' && !value.trim()
    if (blank) {
      if (field.required) missing.push(field.name)
      continue
    }
    if (field.type === 'plainText' && (typeof value !== 'string' || typeof entry !== 'string' && entry.valueType !== 'string')) throw new Error(`Field ${field.name} requires text`)
    if (field.type === 'number' && (typeof entry === 'string' ? !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value as string) || !Number.isFinite(Number(value)) : entry.valueType !== 'number' || typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Field ${field.name} requires a number`)
    if (field.type === 'date' && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value.slice(0, 10) || typeof entry !== 'string' && entry.valueType !== 'date')) throw new Error(`Field ${field.name} requires an ISO date`)
  }
  if (missing.length) throw new OfficeMaterialFactMissing(missing)
}

/** Edit token spans only. Replacement inherits the starting run, even when split. */
export function replaceTemplateRuns(runs: OfficeRichTextRun[], values: Record<string, string>): OfficeRichTextRun[] {
  const text = runs.map((run) => run.text).join('')
  const matches = [...text.matchAll(/\{\{([A-Z][A-Z0-9_]*)\}\}/g)].filter((match) => Object.hasOwn(values, match[1]!))
  if (!matches.length) return runs
  let offset = 0
  return runs.map((run) => {
    const start = offset
    const end = start + run.text.length
    offset = end
    let cursor = start
    let result = ''
    for (const match of matches) {
      const from = match.index!
      const to = from + match[0].length
      if (to <= start || from >= end) continue
      result += text.slice(cursor, Math.max(cursor, from))
      if (from >= start) result += values[match[1]!]!
      cursor = Math.min(end, to)
    }
    result += text.slice(cursor, end)
    return result === run.text ? run : { ...run, text: result }
  })
}
