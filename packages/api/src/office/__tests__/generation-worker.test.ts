import { describe, expect, it, vi } from 'vitest'
import { exportOfficePresentation, type Message } from '@use-brian/core'
import type { DocumentSnapshot, PresentationSnapshot } from '@use-brian/office-model'
import { createOfficeGenerationWorker } from '../generation-worker.js'
import { createOfficeImportWorker } from '../import-worker.js'
import { createOfficeService } from '../service.js'
import { createOfficeTemplateCompileWorker } from '../template-compile-worker.js'
import { generateDocumentFromTemplate, reviseDocumentTargets } from '../document-generation.js'
import { generatePresentationFromTemplate, materializeOfficeTemplateBundleForGeneration, revisePresentationTargets } from '../presentation-generation.js'
import type { OfficeGenerationJobRow } from '../../db/office-generation.js'

describe('[COMP:api/office-generation] Office generation worker', () => {
  it('constructs a letter by replacing template fields while preserving the canonical shell', async () => {
    const uid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
    const paragraph = (n: number, text: string) => ({ id: uid(n), kind: 'paragraph' as const, runs: [{ id: uid(n + 100), text, style }], styleName: 'Body', alignment: 'start' as const })
    const snapshot = {
      schemaVersion: 1 as const, capabilityVersion: 1 as const, artifactId: uid(1), workspaceId: uid(2), family: 'document' as const,
      locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, rootId: uid(3), title: 'Letterhead', resources: [], accessibility: { title: 'Letterhead' },
      sections: [{ id: uid(4), page: { widthPt: 595.3, heightPt: 841.9, marginTopPt: 72, marginRightPt: 62, marginBottomPt: 68, marginLeftPt: 62, orientation: 'portrait' as const }, header: [{ id: uid(5), text: 'Use Brian', style }], footer: [{ id: uid(6), text: 'USEBRIAN.AI', style }], showPageNumber: false, nodes: [paragraph(10, '{{LETTER_DATE}}'), paragraph(11, '{{RECIPIENT_NAME}}'), paragraph(12, '{{SUBJECT}}'), paragraph(13, '{{SALUTATION}}'), paragraph(14, '{{LETTER_BODY}}'), paragraph(15, '{{CLOSING}}'), paragraph(16, '{{SIGNATORY_NAME}}')] }],
    }
    const payload = JSON.stringify({ title: 'Salary adjustment', letterDate: '6 August 2026', recipientName: 'Alex Morgan', recipientTitle: '', recipientOrganisation: 'Example Labs', recipientAddress: ['1 Example Road'], subject: 'Salary adjustment', salutation: 'Dear Alex,', bodyParagraphs: ['Your annual salary will change to HKD 720,000.', 'All other terms remain unchanged.'], closing: 'Sincerely,', signatoryName: 'Jordan Lee', signatoryTitle: 'People Lead' })
    const provider = { async *stream() { yield { type: 'message_start' as const, model: 'test' }; yield { type: 'text_delta' as const, text: payload }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } } } }
    const generated = await generateDocumentFromTemplate({ provider: provider as never, model: 'test', artifactId: uid(20), workspaceId: uid(2), templateVersionId: uid(21), outcome: 'Adjust Alex salary', audience: 'Alex', template: { id: uid(21), workspaceId: uid(2), family: 'document', version: 1, status: 'admitted', name: 'Letterhead', description: 'Company letters', tags: ['company'], locales: ['en-US'], whenToUse: ['letters'], whenNotToUse: ['slides'], exampleRequests: ['Write a letter'], fields: [], slideRecipes: [], snapshot, resources: [], lockedObjectIds: [], allowedRepeatTargetIds: [], requiredEvidence: [], sensitivity: 'internal', visibilityUserIds: [], capabilityVersion: 1, sourceHash: 'a'.repeat(64) } })
    expect(generated.artifactId).toBe(uid(20))
    expect(generated.sections[0].header.map((run) => run.text).join('')).toBe('Use Brian')
    expect(generated.sections[0].nodes.map((node) => 'runs' in node ? node.runs.map((run) => run.text).join('') : '')).toContain('Your annual salary will change to HKD 720,000.')
    expect(JSON.stringify(generated)).not.toContain('{{')
  })

  it('fills the admitted placeholder vocabulary of a non-letter document template', async () => {
    const uid = (n: number) => `35000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
    const cell = (n: number, text: string) => ({ id: uid(n), runs: [{ id: uid(n + 100), text, style }], rowSpan: 1, colSpan: 1 })
    const snapshot: DocumentSnapshot = {
      schemaVersion: 1, capabilityVersion: 1, artifactId: uid(1), workspaceId: uid(2), family: 'document', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, rootId: uid(3), title: 'Invoice template', resources: [], accessibility: { title: 'Invoice template' },
      sections: [{
        id: uid(4), page: { widthPt: 595.3, heightPt: 841.9, marginTopPt: 72, marginRightPt: 62, marginBottomPt: 68, marginLeftPt: 62, orientation: 'portrait' },
        header: [{ id: uid(5), text: 'Invoice {{INVOICE_NUMBER}}', style }],
        footer: [{ id: uid(6), text: '{{OPTIONAL_NOTE}}', style }], showPageNumber: false,
        nodes: [{ id: uid(10), kind: 'table', headerRows: 1, rows: [
          { id: uid(11), cells: [cell(12, 'Customer'), cell(13, '{{CUSTOMER_NAME}}')] },
          { id: uid(14), cells: [cell(15, 'Total'), cell(16, '{{TOTAL}}')] },
        ] }],
      }],
    }
    const template = { id: uid(21), workspaceId: uid(2), family: 'document' as const, version: 1, status: 'admitted' as const, name: 'Invoice', description: 'Use for customer invoices', tags: ['invoice'], locales: ['en-US'], whenToUse: ['invoices'], whenNotToUse: ['letters'], exampleRequests: ['Create an invoice'], fields: [], slideRecipes: [], snapshot, resources: [], lockedObjectIds: [], allowedRepeatTargetIds: [], requiredEvidence: [], sensitivity: 'internal' as const, visibilityUserIds: [], capabilityVersion: 1, sourceHash: 'e'.repeat(64) }
    const payload = JSON.stringify({ title: 'Invoice INV-2026-001', values: { CUSTOMER_NAME: 'Northstar Studio Ltd.', INVOICE_NUMBER: 'INV-2026-001', OPTIONAL_NOTE: '', TOTAL: 'USD 11,000.00' } })
    const requests: Array<{ systemPrompt?: string; messages?: Message[] }> = []
    const provider = { async *stream(request: { systemPrompt?: string; messages?: Message[] }) { requests.push(request); yield { type: 'message_start' as const, model: 'test' }; yield { type: 'text_delta' as const, text: payload }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } } } }

    const generated = await generateDocumentFromTemplate({ provider: provider as never, model: 'test', artifactId: uid(20), workspaceId: uid(2), templateVersionId: uid(21), outcome: 'Create the supplied invoice', audience: 'Accounts payable', template })

    expect(generated.title).toBe('Invoice INV-2026-001')
    expect(generated.sections[0]?.header.map((run) => run.text).join('')).toBe('Invoice INV-2026-001')
    expect(JSON.stringify(generated)).toContain('Northstar Studio Ltd.')
    expect(JSON.stringify(generated)).toContain('USD 11,000.00')
    expect(JSON.stringify(generated)).not.toContain('{{')
    expect(requests[0]?.systemPrompt).toContain('every supplied placeholder key exactly once')
    expect(JSON.stringify(requests[0]?.messages)).toContain('CUSTOMER_NAME')
  })

  it('fails generic document generation when the model omits an admitted placeholder', async () => {
    const uid = (n: number) => `36000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
    const snapshot: DocumentSnapshot = {
      schemaVersion: 1, capabilityVersion: 1, artifactId: uid(1), workspaceId: uid(2), family: 'document', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, rootId: uid(3), title: 'Invoice template', resources: [], accessibility: { title: 'Invoice template' },
      sections: [{ id: uid(4), page: { widthPt: 595.3, heightPt: 841.9, marginTopPt: 72, marginRightPt: 62, marginBottomPt: 68, marginLeftPt: 62, orientation: 'portrait' }, header: [], footer: [], showPageNumber: false, nodes: [{ id: uid(5), kind: 'paragraph', runs: [{ id: uid(6), text: '{{INVOICE_NUMBER}} {{TOTAL}}', style }], styleName: 'Body', alignment: 'start' }] }],
    }
    const template = { id: uid(21), workspaceId: uid(2), family: 'document' as const, version: 1, status: 'admitted' as const, name: 'Invoice', description: 'Use for customer invoices', tags: ['invoice'], locales: ['en-US'], whenToUse: ['invoices'], whenNotToUse: ['letters'], exampleRequests: ['Create an invoice'], fields: [], slideRecipes: [], snapshot, resources: [], lockedObjectIds: [], allowedRepeatTargetIds: [], requiredEvidence: [], sensitivity: 'internal' as const, visibilityUserIds: [], capabilityVersion: 1, sourceHash: 'f'.repeat(64) }
    const payload = JSON.stringify({ title: 'Invoice INV-2026-001', values: { INVOICE_NUMBER: 'INV-2026-001' } })
    const provider = { async *stream() { yield { type: 'message_start' as const, model: 'test' }; yield { type: 'text_delta' as const, text: payload }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } } } }

    await expect(generateDocumentFromTemplate({ provider: provider as never, model: 'test', artifactId: uid(20), workspaceId: uid(2), templateVersionId: uid(21), outcome: 'Create the supplied invoice', audience: 'Accounts payable', template })).rejects.toThrow('missing: TOTAL')
  })

  it('gives targeted document revisions read-only surrounding context without mutating it', async () => {
    const uid = (n: number) => `33000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }
    const paragraph = (n: number, text: string) => ({ id: uid(n), kind: 'paragraph' as const, runs: [{ id: uid(n + 100), text, style }], styleName: 'Body', alignment: 'start' as const })
    const targetId = uid(11)
    const snapshot = {
      schemaVersion: 1 as const, capabilityVersion: 1 as const, artifactId: uid(1), workspaceId: uid(2), family: 'document' as const,
      locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: uid(4), rootId: uid(3), title: 'Salary adjustment', resources: [], accessibility: { title: 'Salary adjustment' },
      sections: [{ id: uid(5), page: { widthPt: 595.3, heightPt: 841.9, marginTopPt: 72, marginRightPt: 62, marginBottomPt: 68, marginLeftPt: 62, orientation: 'portrait' as const }, header: [], footer: [], showPageNumber: false, nodes: [
        paragraph(10, 'Your annual salary will be adjusted to HKD 780,000, effective 1 September 2026.'),
        paragraph(11, 'This adjustment reflects our appreciation for your work.'),
        paragraph(12, 'All other terms and conditions remain unchanged.'),
      ] }],
    }
    let modelRequest: { systemPrompt?: string; messages?: Message[] } | undefined
    const payload = JSON.stringify({ replacements: [{ targetId, text: 'We deeply appreciate your work.' }] })
    const provider = { async *stream(request: { systemPrompt?: string; messages?: Message[] }) { modelRequest = request; yield { type: 'message_start' as const, model: 'test' }; yield { type: 'text_delta' as const, text: payload }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } } } }

    const revised = await reviseDocumentTargets({ provider: provider as never, model: 'test', snapshot, targetIds: [targetId], instruction: '@Brian make this warmer and preserve the amount, date, and other terms' })

    expect(modelRequest?.systemPrompt).toContain('complete document context is read-only')
    expect(modelRequest?.messages?.[0]?.content).toContain('HKD 780,000')
    expect(modelRequest?.messages?.[0]?.content).toContain('1 September 2026')
    expect(modelRequest?.messages?.[0]?.content).toContain('All other terms and conditions remain unchanged.')
    expect(modelRequest?.messages?.[0]?.content).not.toContain('@Brian')
    expect(revised.sections[0].nodes.map((node) => 'runs' in node ? node.runs.map((run) => run.text).join('') : '')).toEqual([
      'Your annual salary will be adjusted to HKD 780,000, effective 1 September 2026.',
      'We deeply appreciate your work.',
      'All other terms and conditions remain unchanged.',
    ])
  })

  it('constructs and revises a presentation through admitted recipes without changing its visual system', async () => {
    const uid = (n: number) => `31000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const style = { fontFamily: 'Arial', fontSizePt: 32, bold: true, italic: false, underline: false, strike: false, color: '#111111' }
    const geometry = { xPt: 72, yPt: 72, widthPt: 600, heightPt: 72, rotationDeg: 0 }
    const masterId = uid(4)
    const layoutId = uid(5)
    const coverTitleId = uid(20)
    const closingTitleId = uid(30)
    const brandShapeId = uid(21)
    const snapshot: PresentationSnapshot = {
      schemaVersion: 1, capabilityVersion: 1, artifactId: uid(1), workspaceId: uid(2), family: 'presentation', locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, rootId: uid(3), title: 'Brand deck', resources: [], accessibility: { title: 'Brand deck' }, slideSize: { widthPt: 960, heightPt: 540 }, themeId: uid(6),
      masters: [{ id: masterId, name: 'Brand master', lockedObjectIds: [] }],
      layouts: [{ id: layoutId, masterId, name: 'Brand layout', placeholderIds: [] }],
      slides: [
        { id: uid(10), title: 'Cover', masterId, layoutId, objects: [
          { id: coverTitleId, kind: 'text', geometry, locked: false, runs: [{ id: uid(120), text: 'Template title', style }], alignment: 'start', verticalAlignment: 'top' },
          { id: brandShapeId, kind: 'shape', geometry: { ...geometry, yPt: 450, heightPt: 20 }, locked: true, shape: 'rectangle', fill: '#0066FF', strokeWidthPt: 0, text: [], altText: 'Brand bar' },
        ], readingOrder: [coverTitleId, brandShapeId], notes: [] },
        { id: uid(11), title: 'Closing', masterId, layoutId, objects: [
          { id: closingTitleId, kind: 'text', geometry, locked: false, runs: [{ id: uid(130), text: 'Template close', style }], alignment: 'start', verticalAlignment: 'top' },
        ], readingOrder: [closingTitleId], notes: [] },
      ],
    }
    const coverFieldId = uid(40)
    const closingFieldId = uid(41)
    const coverRecipeId = uid(50)
    const closingRecipeId = uid(51)
    const template = {
      id: uid(60), workspaceId: uid(2), family: 'presentation' as const, version: 1, status: 'admitted' as const, name: 'Brand deck', description: 'Use the brand presentation system', tags: ['company'], locales: ['en-US'], whenToUse: ['company introductions'], whenNotToUse: ['letters'], exampleRequests: ['Introduce the company'],
      fields: [
        { id: coverFieldId, name: 'cover.title', label: 'Cover title', type: 'plainText' as const, required: true, repeating: false, minItems: 0, maxItems: 1, maxLength: 100, targetIds: [coverTitleId], aiInstruction: 'State the presentation promise', locked: false },
        { id: closingFieldId, name: 'closing.title', label: 'Closing title', type: 'plainText' as const, required: true, repeating: false, minItems: 0, maxItems: 1, maxLength: 100, targetIds: [closingTitleId], aiInstruction: 'Close with one action', locked: false },
      ],
      slideRecipes: [
        { id: coverRecipeId, slideId: uid(10), name: 'Cover', role: 'cover' as const, whenToUse: 'Open the deck', whenNotToUse: '', enabled: true, repeatable: false, minUses: 1, maxUses: 1, fieldIds: [coverFieldId], confidence: 1, inference: 'fixture', reviewed: true },
        { id: closingRecipeId, slideId: uid(11), name: 'Closing', role: 'closing' as const, whenToUse: 'Close the deck', whenNotToUse: '', enabled: true, repeatable: false, minUses: 1, maxUses: 1, fieldIds: [closingFieldId], confidence: 1, inference: 'fixture', reviewed: true },
      ],
      snapshot, resources: [], lockedObjectIds: [brandShapeId], allowedRepeatTargetIds: [], requiredEvidence: [], sensitivity: 'internal' as const, visibilityUserIds: [], capabilityVersion: 1, sourceHash: 'b'.repeat(64),
    }
    const legacy = materializeOfficeTemplateBundleForGeneration({ ...template, fields: [], slideRecipes: undefined }, { id: uid(60), version: 1, status: 'admitted' })
    expect(legacy.slideRecipes).toHaveLength(snapshot.slides.length)
    expect(legacy.fields).toHaveLength(2)
    const generationPayload = JSON.stringify({ title: 'Use Brian introduction', slides: [
      { recipeId: coverRecipeId, title: 'Meet Use Brian', fields: [{ fieldId: coverFieldId, text: 'A company brain for your team' }] },
      { recipeId: closingRecipeId, title: 'Start with your knowledge', fields: [{ fieldId: closingFieldId, text: 'Give your team one place to ask and act' }] },
    ] })
    const generationProvider = { async *stream() { yield { type: 'message_start' as const, model: 'test' }; yield { type: 'text_delta' as const, text: generationPayload }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } } } }
    const generated = await generatePresentationFromTemplate({ provider: generationProvider as never, model: 'test', artifactId: uid(70), workspaceId: uid(2), templateVersionId: uid(60), outcome: 'Create a two-slide introduction', audience: 'Public', evidence: { brain: [], website: [], conflicts: [] }, claims: [], template })

    expect(generated.slides).toHaveLength(2)
    expect(generated.slides[0]?.id).not.toBe(snapshot.slides[0]?.id)
    expect(generated.slides[0]?.masterId).toBe(masterId)
    expect(generated.slides[0]?.layoutId).toBe(layoutId)
    expect(generated.slides[0]?.objects.find((object) => object.kind === 'text' && object.runs.some((run) => run.text.includes('company brain')))).toBeTruthy()
    expect(generated.slides[0]?.objects.find((object) => object.kind === 'shape')).toMatchObject({ fill: '#0066FF', locked: true })
    expect(new Set(generated.slides.flatMap((slide) => [slide.id, ...slide.objects.map((object) => object.id)])).size).toBe(5)

    const revisedTarget = generated.slides[0]!.objects.find((object) => object.kind === 'text')!
    const untouchedBrand = structuredClone(generated.slides[0]!.objects.find((object) => object.kind === 'shape'))
    const revisionPayload = JSON.stringify({ replacements: [{ targetId: revisedTarget.id, text: 'Your company knowledge, ready to act' }] })
    let revisionRequest: { systemPrompt?: string; messages?: Message[] } | undefined
    const revisionProvider = { async *stream(request: { systemPrompt?: string; messages?: Message[] }) { revisionRequest = request; yield { type: 'message_start' as const, model: 'test' }; yield { type: 'text_delta' as const, text: revisionPayload }; yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } } } }
    const revised = await revisePresentationTargets({ provider: revisionProvider as never, model: 'test', snapshot: generated, targetIds: [revisedTarget.id], instruction: '@Brian make this direct' })
    expect(revisionRequest?.systemPrompt).toContain('complete presentation context is read-only')
    expect(revisionRequest?.messages?.[0]?.content).toContain('Give your team one place to ask and act')
    expect(revisionRequest?.messages?.[0]?.content).not.toContain('@Brian')
    const revisedText = revised.slides[0]?.objects.find((object) => object.id === revisedTarget.id)
    expect(revisedText?.kind === 'text' ? revisedText.runs.map((run) => run.text).join('') : null).toBe('Your company knowledge, ready to act')
    expect(revised.slides[0]?.objects.find((object) => object.kind === 'shape')).toEqual(untouchedBrand)
    expect(revised.slides[0]?.objects.find((object) => object.id === revisedTarget.id)?.geometry).toEqual(revisedTarget.geometry)
  })

  it('removes an empty artifact shell when durable job admission fails', async () => {
    const failure = new Error('job insert failed')
    const deps = {
      generationAvailable: vi.fn(() => true),
      createShell: vi.fn(async () => ({ id: 'artifact-1' } as never)),
      deleteEmptyShell: vi.fn(async () => true),
      createJob: vi.fn(async () => { throw failure }),
      getArtifact: vi.fn(), resolveAccess: vi.fn(), latestJob: vi.fn(),
    }
    const service = createOfficeService(deps)
    await expect(service.create({
      userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
      family: 'presentation', outcome: 'Company introduction', audience: 'Public',
      sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false,
      idempotencyKey: 'request-12345678',
    })).rejects.toBe(failure)
    expect(deps.deleteEmptyShell).toHaveBeenCalledWith('user-1', 'artifact-1')
  })

  it('rejects creation before writing a shell when no runner is configured', async () => {
    const deps = {
      generationAvailable: vi.fn(() => false),
      createShell: vi.fn(), deleteEmptyShell: vi.fn(), createJob: vi.fn(),
      getArtifact: vi.fn(), resolveAccess: vi.fn(), latestJob: vi.fn(),
    }
    const service = createOfficeService(deps as never)
    await expect(service.create({
      userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
      family: 'presentation', outcome: 'Company introduction', audience: 'Public',
      sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false,
      idempotencyKey: 'request-12345678',
    })).rejects.toMatchObject({ code: 'office_generation_unavailable' })
    expect(deps.createShell).not.toHaveBeenCalled()
  })

  it('removes the speculative shell when an idempotent retry returns the original job', async () => {
    const deps = {
      generationAvailable: vi.fn(() => true),
      createShell: vi.fn(async () => ({ id: 'new-shell' } as never)),
      deleteEmptyShell: vi.fn(async () => true),
      createJob: vi.fn(async () => ({ id: 'original-job', artifactId: 'original-artifact' } as never)),
      getArtifact: vi.fn(), resolveAccess: vi.fn(), latestJob: vi.fn(),
    }
    const service = createOfficeService(deps)
    await expect(service.create({
      userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
      family: 'document', outcome: 'Board memo', audience: 'Board', sourceHandles: [],
      canonicalWebsite: 'https://example.com', companyHasNoWebsite: false,
      idempotencyKey: 'request-12345678',
    })).resolves.toEqual({ artifactId: 'original-artifact', jobId: 'original-job' })
    expect(deps.deleteEmptyShell).toHaveBeenCalledWith('user-1', 'new-shell')
  })

  it('wakes the durable worker after an explicit @Brian revision is admitted', async () => {
    const wakeGeneration = vi.fn()
    const deps = {
      generationAvailable: vi.fn(() => true), createShell: vi.fn(), deleteEmptyShell: vi.fn(),
      getArtifact: vi.fn(async () => ({ id: 'artifact-1', workspaceId: 'workspace-1', headVersion: 2 } as never)),
      resolveAccess: vi.fn(async () => ({ canComment: true, canEdit: true } as never)),
      createJob: vi.fn(async () => ({ id: 'revision-job' } as never)), latestJob: vi.fn(), wakeGeneration,
    }
    const service = createOfficeService(deps)
    await expect(service.revise({ userId: 'user-1', assistantId: 'assistant-1', artifactId: 'artifact-1', instruction: '@Brian shorten this', targetIds: ['target-1'], expectedVersion: 2, idempotencyKey: 'revision-12345678' })).resolves.toEqual({ jobId: 'revision-job', mode: 'direct' })
    expect(wakeGeneration).toHaveBeenCalledWith('user-1')
  })

  it('claims work, persists localized events, and records a terminal failure', async () => {
    const job = { id: '30000000-0000-4000-8000-000000000001', workspaceId: '30000000-0000-4000-8000-000000000002', artifactId: '30000000-0000-4000-8000-000000000003', initiatedByUserId: '30000000-0000-4000-8000-000000000004', assistantId: '30000000-0000-4000-8000-000000000005', jobKind: 'create', status: 'queued', stage: 'queued', brief: {}, authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 0, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() } as OfficeGenerationJobRow
    const store = { claim: vi.fn(async () => job), checkpoint: vi.fn(async () => true), appendEvent: vi.fn(async () => ({})), drainSteering: vi.fn(async () => []), finish: vi.fn(async () => true) }
    const worker = createOfficeGenerationWorker({ store, workerUserId: job.initiatedByUserId, buildPipelineDeps: () => ({
      resolveAuthority: vi.fn(async () => null), selectTemplate: vi.fn(), retrieveBrain: vi.fn(), inspectWebsite: vi.fn(), planClaims: vi.fn(), construct: vi.fn(), processMedia: vi.fn(), resolveResource: async () => null, cancelled: vi.fn(async () => false), commit: vi.fn(),
    }) })
    const status = await worker.runOnce()
    expect(status).toBe('failed')
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ code: 'office.job.failed', safeNarration: 'Generation failed' }))
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'brief_invalid' }))
  })

  it('consumes import and template-admission jobs through bounded workers', async () => {
    const base = { id: '30000000-0000-4000-8000-000000000011', workspaceId: '30000000-0000-4000-8000-000000000002', artifactId: '30000000-0000-4000-8000-000000000003', initiatedByUserId: '30000000-0000-4000-8000-000000000004', assistantId: null, status: 'queued', stage: 'queued', brief: {}, authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 0, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }
    const importStore = { claim: vi.fn(async () => ({ ...base, jobKind: 'import' as const } as OfficeGenerationJobRow)), appendEvent: vi.fn(async () => ({})), finish: vi.fn(async () => true) }
    const importWorker = createOfficeImportWorker({ store: importStore as never, readSource: vi.fn(), initialize: vi.fn(), context: vi.fn() })
    await expect(importWorker(base.initiatedByUserId)).resolves.toBe(true)
    expect(importStore.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'import_failed' }))

    const templateJob = { ...base, id: '30000000-0000-4000-8000-000000000012', jobKind: 'template_compile' as const } as OfficeGenerationJobRow
    const templateDeps = { claim: vi.fn(async () => templateJob), getSnapshot: vi.fn(), getTemplate: vi.fn(), readSource: vi.fn(), initialize: vi.fn(), saveImportedResource: vi.fn(), saveBundle: vi.fn(), addVersion: vi.fn(), appendEvent: vi.fn(async () => ({})), finish: vi.fn(async () => true) }
    const templateWorker = createOfficeTemplateCompileWorker(templateDeps)
    await expect(templateWorker(base.initiatedByUserId)).resolves.toBe(true)
    expect(templateDeps.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'template_compile_failed' }))
  })

  it('imports an uploaded PPTX into the linked template draft before admission', async () => {
    const workspaceId = '30000000-0000-4000-8000-000000000102'
    const artifactId = '30000000-0000-4000-8000-000000000103'
    const userId = '30000000-0000-4000-8000-000000000104'
    const templateId = '30000000-0000-4000-8000-000000000105'
    const source: PresentationSnapshot = {
      schemaVersion: 1,
      capabilityVersion: 1,
      artifactId: '30000000-0000-4000-8000-000000000106',
      workspaceId,
      family: 'presentation',
      locale: 'en-US',
      defaultLanguage: 'en-US',
      templateVersionId: null,
      rootId: '30000000-0000-4000-8000-000000000107',
      title: 'Uploaded deck',
      resources: [],
      accessibility: { title: 'Uploaded deck' },
      slideSize: { widthPt: 960, heightPt: 540 },
      themeId: '30000000-0000-4000-8000-000000000108',
      masters: [{ id: '30000000-0000-4000-8000-000000000109', name: 'Master', lockedObjectIds: [] }],
      layouts: [{ id: '30000000-0000-4000-8000-000000000110', masterId: '30000000-0000-4000-8000-000000000109', name: 'Blank', placeholderIds: [] }],
      slides: [{ id: '30000000-0000-4000-8000-000000000111', title: 'Imported slide', masterId: '30000000-0000-4000-8000-000000000109', layoutId: '30000000-0000-4000-8000-000000000110', objects: [], readingOrder: [], notes: [] }],
    }
    const uploaded = await exportOfficePresentation(source)
    const job = {
      id: '30000000-0000-4000-8000-000000000101', workspaceId, artifactId, initiatedByUserId: userId,
      assistantId: null, jobKind: 'template_compile', status: 'queued', stage: 'queued',
      brief: { templateId, source: { kind: 'upload', fileId: '30000000-0000-4000-8000-000000000112' } },
      authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 0,
      leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date(),
    } as OfficeGenerationJobRow
    const deps = {
      claim: vi.fn(async () => job),
      getSnapshot: vi.fn(),
      getTemplate: vi.fn(async () => ({ id: templateId, workspaceId, family: 'presentation' as const, name: 'Company deck', description: 'Use for company introductions', sensitivity: 'internal' as const, draftArtifactId: artifactId })),
      readSource: vi.fn(async () => uploaded.bytes),
      initialize: vi.fn(async () => undefined),
      saveImportedResource: vi.fn(),
      saveBundle: vi.fn(async () => '30000000-0000-4000-8000-000000000113'),
      addVersion: vi.fn(async () => ({ id: '30000000-0000-4000-8000-000000000114', version: 1 })),
      appendEvent: vi.fn(async () => ({})),
      finish: vi.fn(async () => true),
    }

    await expect(createOfficeTemplateCompileWorker(deps)(userId)).resolves.toBe(true)

    expect(deps.readSource).toHaveBeenCalledWith(expect.objectContaining({ fileId: '30000000-0000-4000-8000-000000000112' }))
    expect(deps.initialize).toHaveBeenCalledWith(expect.objectContaining({ artifactId, snapshot: expect.objectContaining({ artifactId, workspaceId, title: 'Company deck', family: 'presentation' }) }))
    const initialized = (deps.initialize.mock.calls as unknown as Array<[{ snapshot: PresentationSnapshot }]>)[0]?.[0].snapshot
    expect(initialized?.family === 'presentation' ? initialized.slides[0]?.title : null).toBe('Imported slide')
    expect(deps.getSnapshot).not.toHaveBeenCalled()
    expect(deps.addVersion).toHaveBeenCalledWith(expect.objectContaining({ status: 'admitted' }))
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })
})
