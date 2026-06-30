// [COMP:api/blueprint-from-template] — render a page-template `extraction` spec
// into a runnable blueprint body.
//
// A "document" blueprint (a page template carrying an extraction spec) is filled
// by the SAME synthesis engine as a skill blueprint — the engine only ever
// consumes `body` + `title`. This turns the structured spec (sections + capture)
// into the recipe string that becomes the loop's system prompt, so v2 is a
// resolver swap, not a new engine. See structural-synthesis.md → "The blueprint object".

import type { ExtractionSpec } from '@sidanclaw/core'

function shapeWord(outputType: ExtractionSpec['sections'][number]['outputType']): string {
  if (outputType === 'list') return 'a bulleted list'
  if (outputType === 'table') return 'a table'
  return 'a tight paragraph'
}

/** Render a blueprint's extraction spec into the recipe body the engine runs. */
export function extractionToBlueprintBody(name: string, spec: ExtractionSpec): string {
  const sections = spec.sections
    .map((s, i) => {
      return [
        `### ${i + 1}. ${s.heading}`,
        '',
        `Query \`searchRecording\` for this, then \`patchPage\` ${shapeWord(s.outputType)} onto the page. ${s.instruction.trim()} Cite the \`start_ms\` for every claim.`,
      ].join('\n')
    })
    .join('\n\n')

  const capture =
    spec.capture.length > 0
      ? [
          '',
          '## Capture',
          '',
          `Also write these brain records (search the brain first to dedupe): ${spec.capture.join(', ')}. Use the save tools and inherit the recording's sensitivity.`,
        ].join('\n')
      : ''

  return [
    `# ${name}`,
    '',
    'Fill this brief page section by section from the source. Synthesize — never paste raw transcript.',
    '',
    sections,
    capture,
  ]
    .join('\n')
    .trimEnd()
}
