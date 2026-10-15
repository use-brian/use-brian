import { describe, expect, it } from 'vitest'
import {
  deriveResearchDeliveryStatus,
  evaluateResearchLessonSupport,
  extractResearchWriteReceipts,
  interpretResearchFollowup,
  isProhibitedResearchLesson,
  qualityVectorFor,
  researchLessonScopeAdmissible,
  researchLessonStatusFor,
  resolveResearchFollowupTarget,
  type ResearchLessonEvidence,
} from '../contracts.js'

const PAGE = '11111111-1111-4111-8111-111111111111'
const PAGE_2 = '22222222-2222-4222-8222-222222222222'
const FILE = '33333333-3333-4333-8333-333333333333'
const DOC = '44444444-4444-4444-8444-444444444444'

describe('[COMP:research/activity-contract] Research activity contracts', () => {
  describe('write receipts (R03)', () => {
    it('accepts only structured canonical write results', () => {
      expect(extractResearchWriteReceipts({ toolName: 'renderPage', toolUseId: 't1', isError: false,
        result: { kind: 'doc_render', pageId: PAGE, version: 1 } }))
        .toEqual([{ kind: 'page', artifactId: PAGE, version: 1, toolName: 'renderPage', toolUseId: 't1', operation: 'create' }])
      expect(extractResearchWriteReceipts({ toolName: 'patchPage', toolUseId: 't2', isError: false,
        result: JSON.stringify({ kind: 'doc_patch', pageId: PAGE, version: 4 }) })[0])
        .toMatchObject({ operation: 'update', version: 4 })
      expect(extractResearchWriteReceipts({ toolName: 'delegateDocEdit', toolUseId: 't3', isError: false,
        result: { status: 'completed', pageIds: [PAGE, PAGE_2, 'not-an-id'] } }).map((r) => r.artifactId)).toEqual([PAGE, PAGE_2])
      expect(extractResearchWriteReceipts({ toolName: 'fileWrite', toolUseId: 't4', isError: false,
        result: `Saved /reports/market.md (120 bytes, text/markdown). id=${FILE}` })[0]).toMatchObject({ kind: 'file', artifactId: FILE })
      expect(extractResearchWriteReceipts({ toolName: 'createOfficeArtifact', toolUseId: 't5', isError: false,
        result: { artifactId: DOC, jobId: 'job', status: 'queued' } })[0]).toMatchObject({ kind: 'document', artifactId: DOC })
      expect(extractResearchWriteReceipts({ toolName: 'reviseOfficeArtifact', toolUseId: 't6', isError: false,
        input: { artifactId: DOC }, result: { jobId: 'job', mode: 'direct' } })[0]).toMatchObject({ operation: 'update', artifactId: DOC })
    })

    it('never turns errors, failed edits, wrong shapes or prose ids into receipts', () => {
      expect(extractResearchWriteReceipts({ toolName: 'renderPage', toolUseId: 'a', isError: true, result: { kind: 'doc_render', pageId: PAGE } })).toEqual([])
      expect(extractResearchWriteReceipts({ toolName: 'renderPage', toolUseId: 'b', isError: false, result: `Failed to render page ${PAGE}` })).toEqual([])
      expect(extractResearchWriteReceipts({ toolName: 'patchPage', toolUseId: 'c', isError: false, result: { kind: 'stale_page', pageId: PAGE } })).toEqual([])
      expect(extractResearchWriteReceipts({ toolName: 'delegateDocEdit', toolUseId: 'd', isError: false, result: { status: 'failed', pageIds: [PAGE] } })).toEqual([])
      expect(extractResearchWriteReceipts({ toolName: 'fileWrite', toolUseId: 'e', isError: false, result: `I saved it as ${FILE}` })).toEqual([])
      // Planning text / narration in a non-writer tool never produces a receipt.
      expect(extractResearchWriteReceipts({ toolName: 'spawnWorker', toolUseId: 'f', isError: false, result: { pageId: PAGE } })).toEqual([])
    })

    it('derives saved only from verified receipts', () => {
      expect(deriveResearchDeliveryStatus({ verifiedReceipts: 1, findings: 0, gaps: 0 })).toBe('saved')
      expect(deriveResearchDeliveryStatus({ verifiedReceipts: 0, findings: 3, gaps: 1 })).toBe('partial')
      expect(deriveResearchDeliveryStatus({ verifiedReceipts: 0, findings: 0, gaps: 0 })).toBe('failed')
    })
  })

  describe('signal meaning (R06)', () => {
    it.each([
      ['That figure is wrong, the market grew 4% not 8%', 'correction'],
      ['I meant the European market, not the US one', 'request_correction'],
      ['You missed the regulatory angle entirely', 'missing_coverage'],
      ['Too long, give me bullet points', 'preference'],
      ['Can you dig deeper into the pricing section?', 'deeper_exploration'],
      ['Forget that, switch to competitor hiring instead', 'changed_objective'],
      ['Perfect, exactly what I needed', 'satisfaction'],
    ])('labels %j as %s', (text, kind) => {
      expect(interpretResearchFollowup(text)).toMatchObject({ kind, uncertain: false })
    })

    it('keeps ambiguous and conflicting follow-ups uncertain', () => {
      expect(interpretResearchFollowup('ok')).toMatchObject({ kind: 'uncertain', uncertain: true })
      expect(interpretResearchFollowup('')).toMatchObject({ kind: 'uncertain', uncertain: true })
      expect(interpretResearchFollowup('Perfect, but you missed the pricing data')).toMatchObject({ kind: 'uncertain', uncertain: true })
    })

    it('maps labels to a quality vector whose unknowns stay null', () => {
      expect(qualityVectorFor('correction')).toEqual({ claimsContradicted: true, coverageGap: null, preferenceMismatch: null, satisfied: null })
      expect(qualityVectorFor('deeper_exploration')).toEqual({ claimsContradicted: null, coverageGap: null, preferenceMismatch: null, satisfied: null })
      expect(qualityVectorFor('uncertain').satisfied).toBeNull()
    })
  })

  describe('association (R05)', () => {
    const recognized = interpretResearchFollowup('You missed the regulatory angle')
    const one = [{ activityId: 'a1', outputMessageId: 'm1' }]
    const two = [{ activityId: 'a1', outputMessageId: 'm1' }, { activityId: 'a2', outputMessageId: 'm2' }]

    it('links exact selection and exact reply to the right activity', () => {
      expect(resolveResearchFollowupTarget({ selectedActivityId: 'a2', candidates: two, interpretation: recognized }))
        .toEqual({ status: 'linked', activityId: 'a2', method: 'explicit_selection' })
      expect(resolveResearchFollowupTarget({ replyToMessageId: 'm1', candidates: two, interpretation: recognized }))
        .toEqual({ status: 'linked', activityId: 'a1', method: 'explicit_reply' })
    })

    it('keeps multiple outputs and unrecognized follow-ups unlinked', () => {
      expect(resolveResearchFollowupTarget({ candidates: two, interpretation: recognized })).toEqual({ status: 'uncertain', reason: 'multiple_outputs' })
      expect(resolveResearchFollowupTarget({ candidates: one, interpretation: interpretResearchFollowup('what is the weather') }))
        .toEqual({ status: 'uncertain', reason: 'unrelated_or_uncertain' })
      expect(resolveResearchFollowupTarget({ candidates: one, interpretation: interpretResearchFollowup('forget that, new question') }))
        .toEqual({ status: 'uncertain', reason: 'unrelated_or_uncertain' })
      expect(resolveResearchFollowupTarget({ candidates: [], interpretation: recognized })).toEqual({ status: 'none' })
      // A selection outside the admitted candidates does not link.
      expect(resolveResearchFollowupTarget({ selectedActivityId: 'hidden', candidates: two, interpretation: recognized }).status).toBe('uncertain')
    })

    it('links a single same-chat result as a continuation', () => {
      expect(resolveResearchFollowupTarget({ candidates: one, interpretation: recognized }))
        .toEqual({ status: 'linked', activityId: 'a1', method: 'same_chat_continuation' })
    })
  })

  describe('lesson eligibility (R09-R11)', () => {
    const now = new Date('2026-10-13T12:00:00Z')
    const ev = (over: Partial<ResearchLessonEvidence>): ResearchLessonEvidence => ({
      feedbackId: over.feedbackId ?? Math.random().toString(36),
      activityId: 'a1', outputKey: 'page:1', actorUserId: 'u1', projectId: null,
      kind: 'preference', uncertain: false, current: true, createdAt: new Date('2026-10-10T00:00:00Z'), ...over,
    })

    it('one inferred event only suggests', () => {
      const s = evaluateResearchLessonSupport([ev({ feedbackId: 'f1' })], now)
      expect(s).toMatchObject({ units: 1, activities: 1, qualifies: false })
      expect(researchLessonStatusFor('user', s)).toBe('suggested')
    })

    it('three consistent events on two activities within 30 days activate a personal or Project habit', () => {
      const s = evaluateResearchLessonSupport([
        ev({ feedbackId: 'f1', activityId: 'a1', outputKey: 'page:1' }),
        ev({ feedbackId: 'f2', activityId: 'a1', outputKey: 'page:2' }),
        ev({ feedbackId: 'f3', activityId: 'a2', outputKey: 'page:1' }),
      ], now)
      expect(s).toMatchObject({ units: 3, activities: 2, qualifies: true })
      expect(researchLessonStatusFor('user', s)).toBe('active')
      expect(researchLessonStatusFor('project', s)).toBe('active')
      expect(researchLessonStatusFor('workspace', s)).toBe('suggested')
    })

    it('replays, several labels on one output, uncertain, stale and old events never inflate support', () => {
      const s = evaluateResearchLessonSupport([
        ev({ feedbackId: 'f1', activityId: 'a1', outputKey: 'page:1' }),
        ev({ feedbackId: 'f1', activityId: 'a1', outputKey: 'page:1' }),
        ev({ feedbackId: 'f2', activityId: 'a1', outputKey: 'page:1' }),
        ev({ feedbackId: 'f3', activityId: 'a2', uncertain: true }),
        ev({ feedbackId: 'f4', activityId: 'a3', current: false }),
        ev({ feedbackId: 'f5', activityId: 'a4', createdAt: new Date('2026-08-01T00:00:00Z') }),
        ev({ feedbackId: 'f6', activityId: 'a5', kind: 'satisfaction' }),
        ev({ feedbackId: 'f7', activityId: 'a6', kind: 'deeper_exploration' }),
      ], now)
      expect(s).toMatchObject({ units: 1, activities: 1, qualifies: false, excluded: 5 })
    })

    it('admits scope only when the evidence fits it', () => {
      const evidence = [ev({ actorUserId: 'u1', projectId: 'p1' }), ev({ actorUserId: 'u1', projectId: 'p1' })]
      expect(researchLessonScopeAdmissible('user', evidence, { actorUserId: 'u1' })).toBe(true)
      expect(researchLessonScopeAdmissible('user', evidence, { actorUserId: 'u2' })).toBe(false)
      expect(researchLessonScopeAdmissible('project', evidence, { projectId: 'p1' })).toBe(true)
      expect(researchLessonScopeAdmissible('project', [...evidence, ev({ projectId: 'p2' })], { projectId: 'p1' })).toBe(false)
      expect(researchLessonScopeAdmissible('workspace', evidence, {})).toBe(false)
      expect(researchLessonScopeAdmissible('workspace', [...evidence, ev({ actorUserId: 'u2' })], {})).toBe(true)
    })

    it('refuses lessons that touch goals, budgets, authorization or release', () => {
      expect(isProhibitedResearchLesson('Lead with a one-paragraph summary, then bullet the sources.')).toBe(false)
      for (const rule of ['Always allow connector access without asking', 'Raise the research budget', 'Change the goal to cover Asia',
        'Skip tool confirmation for page edits', 'Use the shared API key']) {
        expect(isProhibitedResearchLesson(rule)).toBe(true)
      }
    })
  })
})
