// [COMP:api/blueprint-from-template] — render a page-template `extraction` spec
// into a runnable blueprint body.
//
// A "document" blueprint (a page template carrying an extraction contract) is
// filled by the SAME synthesis engine as a skill blueprint — but a document
// blueprint is RECORD-FIRST: the loop's sink is the typed `writeField` tool,
// and the page (when this surface renders one) is projected FROM the record
// afterwards. This turns the structured contract into the recipe string that
// becomes the loop's system prompt; the engine adds the source-specific gather
// + cite envelope. See structural-synthesis.md → "The blueprint object".

import type { ExtractionField, ExtractionSpec } from '@sidanclaw/core'

function shapeWord(outputType: ExtractionField['outputType']): string {
  if (outputType === 'list') return 'a markdown bulleted list'
  if (outputType === 'table') return 'a markdown table'
  return 'a tight markdown paragraph'
}

/** One-line value guidance per contract field type. */
function valueGuidance(field: ExtractionField): string {
  switch (field.type) {
    case 'markdown':
      return `Write ${shapeWord(field.outputType)}.`
    case 'string':
      return 'Write a short plain-text value (one line).'
    case 'number':
      return 'Write a plain number (no units, no formatting).'
    case 'date':
      return 'Write an ISO date: YYYY-MM-DD.'
    case 'boolean':
      return 'Write true or false.'
    case 'enum':
      return `Write exactly one of: ${(field.options ?? []).join(', ')}.`
    case 'entityRef':
      return `Name the ${field.entityKind ?? 'entity'} it refers to (pass { "name": "..." }).`
  }
}

/** Render a blueprint's extraction contract into the recipe body the engine runs. */
export function extractionToBlueprintBody(name: string, spec: ExtractionSpec): string {
  const fields = spec.fields
    .map((f, i) => {
      const requiredTag = f.required ? ' (REQUIRED)' : ''
      return [
        `### ${i + 1}. ${f.heading} — \`${f.key}\`${requiredTag}`,
        '',
        `${f.instruction.trim()} Pull what you need from the source tool first, then save the value with \`writeField("${f.key}", …)\`. ${valueGuidance(f)}`,
      ].join('\n')
    })
    .join('\n\n')

  // Per-kind capture guidance (optional): HOW to write each enabled kind —
  // e.g. task: "break maintenance items into one task each". Rendered as
  // bullets so the generic dedupe/sensitivity line stays kind-agnostic.
  const perKind = spec.capture
    .map((kind) => {
      const instruction = spec.captureInstructions?.[kind]?.trim()
      return instruction ? `- ${kind}: ${instruction}` : null
    })
    .filter((line): line is string => line !== null)
  const capture =
    spec.capture.length > 0
      ? [
          '',
          '## Capture',
          '',
          `Also write these brain records (search the brain first to dedupe): ${spec.capture.join(', ')}. Use the save tools and inherit the source's sensitivity.`,
          ...(perKind.length > 0 ? ['', ...perKind] : []),
        ].join('\n')
      : ''

  return [
    `# ${name}`,
    '',
    'Fill this blueprint field by field from the source. Synthesize — never paste raw source text. Every field lands via `writeField`; fields you cannot ground in the source stay unwritten (never invent).',
    '',
    fields,
    capture,
  ]
    .join('\n')
    .trimEnd()
}
