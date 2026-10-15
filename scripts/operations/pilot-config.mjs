import { CASE_IDS, DEPENDENCY_IDS } from './readiness-contract.mjs'

export const LANES = ['research', 'administration', 'meeting-preparation', 'cos-email']
const fields = ['installation', 'workspaceId', 'memberId', 'assistantId', 'projectId', 'sourceScope', 'mailboxAccount',
  'calendarAccount', 'schedule', 'timezone', 'meetingLeadMinutes', 'taskAllowance', 'workspaceAllowance', 'approvalSettings', 'alertSettings', 'chatId']
const tools = {
  research: ['webSearch', 'urlReader'], administration: ['getTask'],
  'meeting-preparation': ['getTask', 'readPage', 'gcalListEvents'], 'cos-email': ['imapListMessages', 'imapReadMessage'],
}
const prompts = {
  research: 'Research the admitted question. Save source-backed findings through the native research artifact path. Disclose insufficient or contradictory evidence.',
  administration: 'Inspect the assigned task and actual configured account. Use the native approval path for each consequential effect. Preserve uncertain effects and WIP before recovery.',
  'meeting-preparation': 'Prepare for the admitted meeting using current Project Brief and task sources. Save or return grounded preparation. Withhold private sources and mark unavailable context unknown.',
  'cos-email': 'Review only the configured mailbox and bounded source checkpoint. Return source-backed suggestions in the configured Chat. Do not reply to email, contact anyone or create independent work. Unchanged input must produce no duplicate delivery. Unknown offline work stays unknown.',
}

export function preparePilotConfig() {
  return { schema: 'operations-inactive-pilot-v1', readyToActivate: false, liveValidated: false,
    caseIds: [...CASE_IDS], dependencyIds: [...DEPENDENCY_IDS], monthlyUsdReference: 1000, hardStopUsd: null,
    planes: [{ id: 'company', targetClass: 'platform', bindings: Object.fromEntries(fields.map(f => [f, null])) },
      { id: 'personal', targetClass: 'home-linux', bindings: Object.fromEntries(fields.map(f => [f, null])) }],
    recipes: LANES.map(lane => ({ lane, planeBinding: null, enabled: false,
      interface: 'native workflow authoring/proposal; review definition and current dependency preflight before human apply',
      // Native shape with unresolved values is deliberately not a postable active definition.
      nativeDraft: { name: `Operations pilot: ${lane}`, definition: { startStepId: 'review',
        defaultExecutor: { kind: 'assistant', assistantId: null },
        steps: [{ id: 'review', type: 'assistant_call', target: { assistantId: null }, prompt: prompts[lane], tools: tools[lane],
          deliver: { channelType: 'web', channelId: null } }] },
        trigger: lane === 'research' || lane === 'administration' ? { kind: 'manual' }
          : { kind: 'schedule', schedule: null, timezone: null }, contextProjectId: null },
      unresolvedBindings: [...fields, 'planeBinding'],
      blockers: lane === 'cos-email' ? ['native scheduled email checkpoint/deduplication and routine admission must be demonstrated (F07)']
        : lane === 'meeting-preparation' ? ['native calendar admission and meeting-specific scheduling must be demonstrated (F07)']
          : ['current actor, account/tool authority, sources and allowance require owner binding'],
      controls: {
        start: 'Human configures and reviews the exact native workflow/proposal after all blockers close; explicit human activation only.',
        pause: 'Disable future workflow triggers; use native Task execution Pause for already admitted work.',
        recover: 'Inspect retained Task WIP/effect receipt and missing input. Reconcile uncertain effects before any retry. Use guarded Continue or attributable human steering.',
        disable: 'Disable native workflow intake/schedule. Existing Tasks keep their own mandate and allowance.',
        revoke: 'Revoke the native connector/assistant/source grant or reviewer assignment with current human controls; revalidate all existing work.',
      },
    })) }
}

/** Fictional bindings only; this returns data, never posts or enables anything. */
export function materializeFixture(recipe, binding) {
  if (!['company', 'personal'].includes(binding.plane) || binding.targetClass !== (binding.plane === 'company' ? 'platform' : 'home-linux')) throw new Error('plane_mismatch')
  for (const f of ['assistantId', 'projectId', 'chatId', 'timezone']) if (!binding[f]) throw new Error(`binding_missing:${f}`)
  const draft = structuredClone(recipe.nativeDraft)
  draft.definition.defaultExecutor.assistantId = binding.assistantId
  draft.definition.steps[0].target.assistantId = binding.assistantId
  draft.definition.steps[0].deliver.channelId = binding.chatId
  if (draft.trigger.kind === 'schedule') { draft.trigger.schedule = { type: 'daily', time: '09:00' }; draft.trigger.timezone = binding.timezone }
  draft.contextProjectId = binding.projectId
  return { ...draft, enabled: false }
}

export function validateInactiveConfig(config) {
  const expected = preparePilotConfig()
  if (JSON.stringify(config) !== JSON.stringify(expected)) throw new Error('inactive_config_changed: unresolved owner slots and disabled native drafts must remain explicit')
  return { status: 'passed', readyToActivate: false, writes: 0, liveValidated: false }
}
