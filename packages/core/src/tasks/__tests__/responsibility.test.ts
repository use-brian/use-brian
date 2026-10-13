import { describe, expect, it } from 'vitest'
import {
  applyResponsibilityPatch,
  classifyTaskForViewer,
  executorChanged,
  resolveTaskFollowUp,
  taskExecutor,
  TaskResponsibilityError,
  type ClassifiableTask,
  type TaskResponsibility,
} from '../responsibility.js'

const NONE: TaskResponsibility = { assigneeId: null, executorAssistantId: null, followUpMemberId: null, home: null }
const DEPT = { kind: 'department' as const, id: 'dept-1' }
const PROJECT = { kind: 'project' as const, id: 'proj-1' }
const ME = { userId: 'user-me', memberId: 'member-me' }
const NOW = new Date('2026-10-13T12:00:00Z')

function task(over: Partial<ClassifiableTask> = {}): ClassifiableTask {
  return { ...NONE, status: 'todo', due: null, openQuestions: 0, goalBlocked: false, createdByUserId: 'user-author', ...over }
}

describe('[COMP:tasks/responsibility] Task executor, human follow-up and home', () => {
  describe('executor typing', () => {
    it('reads person, assistant and unassigned executors from a row', () => {
      expect(taskExecutor(NONE)).toEqual({ kind: 'unassigned' })
      expect(taskExecutor({ assigneeId: 'm1', executorAssistantId: null })).toEqual({ kind: 'person', memberId: 'm1' })
      expect(taskExecutor({ assigneeId: null, executorAssistantId: 'a1' })).toEqual({ kind: 'assistant', assistantId: 'a1' })
    })

    it('refuses a row or a patch that names a person AND an assistant as executor', () => {
      expect(() => taskExecutor({ assigneeId: 'm1', executorAssistantId: 'a1' })).toThrow(TaskResponsibilityError)
      try {
        applyResponsibilityPatch(NONE, { assigneeId: 'm1', executorAssistantId: 'a1' })
        expect.unreachable()
      } catch (error) {
        expect((error as TaskResponsibilityError).code).toBe('task_executor_conflict')
        expect((error as TaskResponsibilityError).status).toBe(400)
      }
    })

    it('treats the executor as one slot: a person replaces an assistant and the reverse', () => {
      const assistant = applyResponsibilityPatch(NONE, { executorAssistantId: 'a1' })
      expect(taskExecutor(assistant)).toEqual({ kind: 'assistant', assistantId: 'a1' })
      const person = applyResponsibilityPatch(assistant, { assigneeId: 'm1' })
      expect(person).toMatchObject({ assigneeId: 'm1', executorAssistantId: null })
      expect(executorChanged(assistant, person)).toBe(true)
      const back = applyResponsibilityPatch(person, { executorAssistantId: 'a2' })
      expect(back).toMatchObject({ assigneeId: null, executorAssistantId: 'a2' })
    })

    it('rejects a malformed home', () => {
      expect(() => applyResponsibilityPatch(NONE, { home: { kind: 'team' as never, id: 'x' } })).toThrow(/task_home_invalid/)
      expect(() => applyResponsibilityPatch(NONE, { home: { kind: 'department', id: '' } })).toThrow(/task_home_invalid/)
    })
  })

  describe('contact independence', () => {
    it('selecting a human follow-up never makes them the executor or stops the assistant', () => {
      const assistant = applyResponsibilityPatch(NONE, { executorAssistantId: 'a1' })
      const withContact = applyResponsibilityPatch(assistant, { followUpMemberId: 'm-contact' })
      expect(taskExecutor(withContact)).toEqual({ kind: 'assistant', assistantId: 'a1' })
      expect(executorChanged(assistant, withContact)).toBe(false)
      expect(withContact.assigneeId).toBeNull()
    })

    it('clearing the contact leaves the executor alone, and changing the executor leaves the contact alone', () => {
      const base = { ...NONE, executorAssistantId: 'a1', followUpMemberId: 'm-contact' }
      expect(applyResponsibilityPatch(base, { followUpMemberId: null })).toMatchObject({ executorAssistantId: 'a1', followUpMemberId: null })
      expect(applyResponsibilityPatch(base, { assigneeId: 'm1' })).toMatchObject({ assigneeId: 'm1', followUpMemberId: 'm-contact' })
    })
  })

  describe('follow-up resolution', () => {
    it('prefers the explicit contact, then the person executing', () => {
      expect(resolveTaskFollowUp({ ...NONE, executorAssistantId: 'a1', followUpMemberId: 'm2' }, ['owner'])).toEqual({ source: 'explicit', memberId: 'm2' })
      expect(resolveTaskFollowUp({ ...NONE, assigneeId: 'm1' }, ['owner'])).toEqual({ source: 'executor', memberId: 'm1' })
    })

    it('routes assistant-only Department work to the current Department owners', () => {
      expect(resolveTaskFollowUp({ ...NONE, executorAssistantId: 'a1', home: DEPT }, ['o1', 'o2']))
        .toEqual({ source: 'home_owners', home: DEPT, ownerUserIds: ['o1', 'o2'] })
    })

    it('routes assistant-only independent Project work to the current Project owners', () => {
      expect(resolveTaskFollowUp({ ...NONE, executorAssistantId: 'a1', home: PROJECT }, ['p-owner']))
        .toEqual({ source: 'home_owners', home: PROJECT, ownerUserIds: ['p-owner'] })
    })

    it('re-resolves on an owner change instead of keeping the original owner', () => {
      const r = { ...NONE, executorAssistantId: 'a1', home: DEPT }
      expect(resolveTaskFollowUp(r, ['old-owner'])).toMatchObject({ ownerUserIds: ['old-owner'] })
      expect(resolveTaskFollowUp(r, ['new-owner'])).toMatchObject({ ownerUserIds: ['new-owner'] })
    })

    it('discloses missing routing rather than guessing a human or an assistant', () => {
      expect(resolveTaskFollowUp({ ...NONE, executorAssistantId: 'a1' }, null)).toEqual({ source: 'missing_routing', reason: 'no_home' })
      expect(resolveTaskFollowUp({ ...NONE, executorAssistantId: 'a1', home: DEPT }, [])).toEqual({ source: 'missing_routing', reason: 'no_eligible_owner' })
      expect(resolveTaskFollowUp({ ...NONE, executorAssistantId: 'a1', home: DEPT }, null)).toEqual({ source: 'missing_routing', reason: 'no_eligible_owner' })
    })

    it('puts unassigned Department work in its owners queue and invents nobody for other unassigned work', () => {
      expect(resolveTaskFollowUp({ ...NONE, home: DEPT }, ['o1'])).toEqual({ source: 'owner_queue', home: DEPT, ownerUserIds: ['o1'] })
      expect(resolveTaskFollowUp({ ...NONE, home: PROJECT }, ['p-owner'])).toEqual({ source: 'none' })
      expect(resolveTaskFollowUp(NONE, null)).toEqual({ source: 'none' })
    })
  })

  describe('viewer classification', () => {
    it('shows unassigned Department work only to its eligible owners, with an assignment action', () => {
      const t = task({ home: DEPT })
      expect(classifyTaskForViewer(t, ME, ['user-me'], NOW)).toEqual({ section: 'needs_assignment', reasons: ['unassigned'], nextAction: 'assign' })
      // An ordinary member who can see the task does not receive the owner nudge.
      expect(classifyTaskForViewer(t, ME, ['someone-else'], NOW)).toBeNull()
    })

    it('lists a person their own task in My work', () => {
      expect(classifyTaskForViewer(task({ assigneeId: 'member-me' }), ME, null, NOW))
        .toEqual({ section: 'my_work', reasons: ['assigned_to_you'], nextAction: 'open' })
    })

    it('gives an explicit human the assistant task question while the assistant stays executor', () => {
      const t = task({ executorAssistantId: 'a1', followUpMemberId: 'member-me', status: 'in_progress', openQuestions: 1 })
      expect(classifyTaskForViewer(t, ME, null, NOW)).toEqual({ section: 'needs_you', reasons: ['question', 'follow_up'], nextAction: 'answer' })
      expect(taskExecutor(t)).toEqual({ kind: 'assistant', assistantId: 'a1' })
    })

    it('shows a running assistant task in My work without inventing an attention issue', () => {
      const t = task({ executorAssistantId: 'a1', home: DEPT, status: 'in_progress' })
      expect(classifyTaskForViewer(t, ME, ['user-me'], NOW)).toEqual({ section: 'my_work', reasons: ['follow_up'], nextAction: 'open' })
    })

    it('raises a blocked hosted Goal on running assistant work as an actionable blocker', () => {
      const t = task({ executorAssistantId: 'a1', followUpMemberId: 'member-me', status: 'in_progress', goalBlocked: true })
      expect(classifyTaskForViewer(t, ME, null, NOW)).toEqual({ section: 'needs_you', reasons: ['blocked', 'follow_up'], nextAction: 'unblock' })
    })

    it('raises blocked, in-review and overdue work into Needs you', () => {
      expect(classifyTaskForViewer(task({ assigneeId: 'member-me', status: 'blocked' }), ME, null, NOW)?.nextAction).toBe('unblock')
      expect(classifyTaskForViewer(task({ assigneeId: 'member-me', status: 'in_review' }), ME, null, NOW)?.nextAction).toBe('review')
      expect(classifyTaskForViewer(task({ assigneeId: 'member-me', due: new Date('2026-10-01T00:00:00Z') }), ME, null, NOW))
        .toEqual({ section: 'needs_you', reasons: ['overdue', 'assigned_to_you'], nextAction: 'open' })
    })

    it('offers the author an explicit routing choice for unroutable assistant work, and nobody else', () => {
      const t = task({ executorAssistantId: 'a1', createdByUserId: 'user-me' })
      expect(classifyTaskForViewer(t, ME, null, NOW)).toEqual({ section: 'needs_you', reasons: ['missing_routing'], nextAction: 'select_follow_up' })
      expect(classifyTaskForViewer({ ...t, createdByUserId: 'other' }, ME, null, NOW)).toBeNull()
    })

    it('never surfaces closed work', () => {
      expect(classifyTaskForViewer(task({ assigneeId: 'member-me', status: 'done' }), ME, null, NOW)).toBeNull()
      expect(classifyTaskForViewer(task({ home: DEPT, status: 'archived' }), ME, ['user-me'], NOW)).toBeNull()
    })
  })
})
