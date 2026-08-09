import { describe, expect, it } from 'vitest'
import { fitOfficeArtifact, type Message } from '@use-brian/core'
import type { OfficeTemplateBundle, PresentationSnapshot } from '@use-brian/office-model'
import { generatePresentationFromTemplate, revisePresentationTargets } from '../presentation-generation.js'

describe('[COMP:api/office-generation] presentation fit repair', () => {
  const uid = (n: number) => `38000000-0000-4000-8000-${String(n).padStart(12, '0')}`
  const targetId = uid(20)
  const fieldId = uid(30)
  const recipeId = uid(40)
  const style = { fontFamily: 'Arial', fontSizePt: 24, bold: true, italic: false, underline: false, strike: false, color: '#111111' }
  const secondaryStyle = { ...style, bold: false, color: '#333333' }
  const snapshot: PresentationSnapshot = {
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: uid(1),
    workspaceId: uid(2),
    family: 'presentation',
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: null,
    rootId: uid(3),
    title: 'Compact title template',
    resources: [],
    accessibility: { title: 'Compact title template' },
    slideSize: { widthPt: 960, heightPt: 540 },
    themeId: uid(4),
    masters: [{ id: uid(5), name: 'Master', lockedObjectIds: [] }],
    layouts: [{ id: uid(6), masterId: uid(5), name: 'Title', placeholderIds: [] }],
    slides: [{
      id: uid(10),
      title: 'Title',
      masterId: uid(5),
      layoutId: uid(6),
      objects: [{
        id: targetId,
        kind: 'text',
        geometry: { xPt: 72, yPt: 72, widthPt: 120, heightPt: 60, rotationDeg: 0 },
        locked: false,
        runs: [{ id: uid(21), text: 'Ti', style }, { id: uid(22), text: 'tle', style: secondaryStyle }],
        alignment: 'start',
        verticalAlignment: 'top',
      }],
      readingOrder: [targetId],
      notes: [],
    }],
  }
  const template: OfficeTemplateBundle = {
    id: uid(50),
    workspaceId: uid(2),
    family: 'presentation',
    version: 1,
    status: 'admitted',
    name: 'Compact title',
    description: 'Use one concise title.',
    tags: ['title'],
    locales: ['en-US'],
    whenToUse: ['Short presentations'],
    whenNotToUse: ['Long-form content'],
    exampleRequests: ['Create a short title slide'],
    fields: [{
      id: fieldId,
      name: 'cover.title',
      label: 'Cover title',
      type: 'plainText',
      required: true,
      repeating: false,
      minItems: 0,
      maxItems: 1,
      maxLength: 200,
      targetIds: [targetId],
      aiInstruction: 'Keep the title concise.',
      locked: false,
    }],
    slideRecipes: [{
      id: recipeId,
      slideId: uid(10),
      name: 'Cover',
      role: 'cover',
      whenToUse: 'Open the deck.',
      whenNotToUse: 'Do not repeat.',
      enabled: true,
      repeatable: false,
      minUses: 1,
      maxUses: 1,
      fieldIds: [fieldId],
      confidence: 1,
      inference: 'Test fixture',
      reviewed: true,
    }],
    snapshot,
    resources: [],
    lockedObjectIds: [],
    allowedRepeatTargetIds: [],
    requiredEvidence: [],
    sensitivity: 'internal',
    visibilityUserIds: [],
    capabilityVersion: 1,
    sourceHash: 'e'.repeat(64),
  }

  it('replans generated copy after deterministic overflow diagnostics', async () => {
    const payloads = [
      { title: 'Introduction', slides: [{ recipeId, title: 'Introduction', fields: [{ fieldId, text: 'This title is much too long for the admitted compact title region' }] }] },
      { title: 'Introduction', slides: [{ recipeId, title: 'Introduction', fields: [{ fieldId, text: 'Meet\nBrian' }] }] },
    ]
    const requests: Array<{ messages?: Message[] }> = []
    const provider = {
      async *stream(request: { messages?: Message[] }) {
        requests.push(request)
        yield { type: 'message_start' as const, model: 'test' }
        yield { type: 'text_delta' as const, text: JSON.stringify(payloads[requests.length - 1]) }
        yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    const generated = await generatePresentationFromTemplate({
      provider: provider as never,
      model: 'test',
      artifactId: uid(60),
      workspaceId: uid(2),
      templateVersionId: uid(50),
      outcome: 'Introduce Brian',
      audience: 'Public',
      evidence: { brain: [], website: [], conflicts: [] },
      claims: [],
      template,
    })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages?.[0]?.content).toContain('deterministic layout validation')
    expect(requests[1]?.messages?.[0]?.content).toContain('Cover title')
    expect(fitOfficeArtifact(generated).issues).toEqual([])
    expect(generated.slides[0]?.objects[0]?.kind === 'text' ? generated.slides[0].objects[0].runs.map((run) => run.text).join('') : null).toBe('Meet\nBrian')
    const generatedRuns = generated.slides[0]?.objects[0]?.kind === 'text' ? generated.slides[0].objects[0].runs : []
    expect(generatedRuns.slice(0, -1).every((run, index) => !run.text || !generatedRuns[index + 1]?.text || /\s$/.test(run.text) || /^\s/.test(generatedRuns[index + 1]!.text))).toBe(true)
  })

  it('repairs a plan that copies catalogue label metadata into a field', async () => {
    const payloads = [
      { title: 'Introduction', slides: [{ recipeId, title: 'Introduction', fields: [{ fieldId, label: 'Cover title', text: 'Meet Brian' }] }] },
      { title: 'Introduction', slides: [{ recipeId, title: 'Introduction', fields: [{ fieldId, text: 'Meet Brian' }] }] },
    ]
    const requests: Array<{ messages?: Message[] }> = []
    const provider = {
      async *stream(request: { messages?: Message[] }) {
        requests.push(request)
        yield { type: 'message_start' as const, model: 'test' }
        yield { type: 'text_delta' as const, text: JSON.stringify(payloads[requests.length - 1]) }
        yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    const generated = await generatePresentationFromTemplate({
      provider: provider as never,
      model: 'test',
      artifactId: uid(61),
      workspaceId: uid(2),
      templateVersionId: uid(50),
      outcome: 'Introduce Brian',
      audience: 'Public',
      evidence: { brain: [], website: [], conflicts: [] },
      claims: [],
      template,
    })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages?.[0]?.content).toContain('strict presentation-plan validation')
    expect(requests[1]?.messages?.[0]?.content).toContain('slides.0.fields.0')
    expect(requests[1]?.messages?.[0]?.content).toContain('label')
    expect(generated.slides[0]?.objects[0]?.kind === 'text' ? generated.slides[0].objects[0].runs.map((run) => run.text).join('') : null).toBe('Meet Brian')
  })

  it('bounds invalid plan repair with a typed terminal failure', async () => {
    let attempts = 0
    const provider = {
      async *stream() {
        attempts += 1
        yield { type: 'message_start' as const, model: 'test' }
        yield { type: 'text_delta' as const, text: JSON.stringify({ title: 'Introduction', slides: [{ recipeId, title: 'Introduction', fields: [{ fieldId, label: 'Cover title', text: 'Meet Brian' }] }] }) }
        yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    await expect(generatePresentationFromTemplate({
      provider: provider as never,
      model: 'test',
      artifactId: uid(62),
      workspaceId: uid(2),
      templateVersionId: uid(50),
      outcome: 'Introduce Brian',
      audience: 'Public',
      evidence: { brain: [], website: [], conflicts: [] },
      claims: [],
      template,
    })).rejects.toMatchObject({ code: 'presentation_plan_failed' })
    expect(attempts).toBe(3)
  })

  it('retries a targeted revision without changing its selection boundary', async () => {
    const payloads = [
      { replacements: [{ targetId, text: 'This replacement is much too long for the compact selected title region' }] },
      { replacements: [{ targetId, text: 'Act\nnow' }] },
    ]
    const requests: Array<{ messages?: Message[] }> = []
    const provider = {
      async *stream(request: { messages?: Message[] }) {
        requests.push(request)
        yield { type: 'message_start' as const, model: 'test' }
        yield { type: 'text_delta' as const, text: JSON.stringify(payloads[requests.length - 1]) }
        yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    const revised = await revisePresentationTargets({
      provider: provider as never,
      model: 'test',
      snapshot,
      targetIds: [targetId],
      instruction: '@Brian make this direct',
    })

    expect(requests).toHaveLength(2)
    expect(requests[1]?.messages?.[0]?.content).toContain('Rewrite only the selected text')
    expect(requests[1]?.messages?.[0]?.content).not.toContain('@Brian')
    expect(fitOfficeArtifact(revised).issues).toEqual([])
    expect(revised.slides[0]?.objects[0]?.kind === 'text' ? revised.slides[0].objects[0].runs.map((run) => run.text).join('') : null).toBe('Act\nnow')
  })

  it('treats a selected slide as a bounded scope over its unlocked text objects', async () => {
    const scoped = structuredClone(snapshot)
    const secondaryTargetId = uid(23)
    const lockedTargetId = uid(25)
    scoped.slides[0]!.objects.push({
      id: secondaryTargetId,
      kind: 'text',
      geometry: { xPt: 300, yPt: 72, widthPt: 300, heightPt: 60, rotationDeg: 0 },
      locked: false,
      runs: [{ id: uid(24), text: 'Supporting copy', style: secondaryStyle }],
      alignment: 'start',
      verticalAlignment: 'top',
    }, {
      id: lockedTargetId,
      kind: 'text',
      geometry: { xPt: 300, yPt: 300, widthPt: 300, heightPt: 60, rotationDeg: 0 },
      locked: true,
      runs: [{ id: uid(26), text: 'Locked brand copy', style: secondaryStyle }],
      alignment: 'start',
      verticalAlignment: 'top',
    })
    scoped.slides[0]!.readingOrder.push(secondaryTargetId, lockedTargetId)
    const requests: Array<{ messages?: Message[] }> = []
    const provider = {
      async *stream(request: { messages?: Message[] }) {
        requests.push(request)
        yield { type: 'message_start' as const, model: 'test' }
        yield { type: 'text_delta' as const, text: JSON.stringify({ replacements: [{ targetId, text: 'Go' }] }) }
        yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
      },
    }

    const revised = await revisePresentationTargets({
      provider: provider as never,
      model: 'test',
      snapshot: scoped,
      targetIds: [scoped.slides[0]!.id],
      instruction: '@Brian change only the headline',
    })

    const requestContent = requests[0]?.messages?.[0]?.content
    const request = typeof requestContent === 'string' ? requestContent : JSON.stringify(requestContent ?? '')
    const selectedText = request.split('\n\nComplete presentation context')[0] ?? ''
    expect(selectedText).toContain(targetId)
    expect(selectedText).toContain(secondaryTargetId)
    expect(selectedText).not.toContain(lockedTargetId)
    expect(selectedText).toContain('"required":false')
    expect(revised.slides[0]?.objects[0]?.kind === 'text' ? revised.slides[0].objects[0].runs.map((run) => run.text).join('') : null).toBe('Go')
    expect(revised.slides[0]?.objects[1]?.kind === 'text' ? revised.slides[0].objects[1].runs.map((run) => run.text).join('') : null).toBe('Supporting copy')
    expect(revised.slides[0]?.objects[2]?.kind === 'text' ? revised.slides[0].objects[2].runs.map((run) => run.text).join('') : null).toBe('Locked brand copy')
  })
})
