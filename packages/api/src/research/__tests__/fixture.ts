/**
 * Shared seeding for the research DB suites. Builds on the Brief fixture (an
 * isolated workspace with a shared Project, a Department, fictional people
 * and two assistants). Fictional identities only; runs only through
 * scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../../db/client.js'
import type { BriefFixture } from '../../briefs/__tests__/fixture.js'
import { createResearchTurnObserver, recordResearchDelivery } from '../delivery.js'
import { beginResearchActivity, captureResearchFollowupForMessage, createResearchDeliveryDeps } from '../runtime.js'

export { briefFixture, type BriefFixture } from '../../briefs/__tests__/fixture.js'

let seq = 0

export async function researchSession(f: BriefFixture, userId: string, projectId: string | null = null, assistantId = f.assistants.brian) {
  const id = randomUUID()
  await getPool().query(`INSERT INTO sessions(id,assistant_id,user_id,channel_type,channel_id,workspace_id,effective_clearance,context_project_id)
    VALUES($1,$2,$3,'web',$6,$4,'internal',$5)`, [id, assistantId, userId, f.workspaceId, projectId, id])
  return id
}

export async function researchMessage(f: BriefFixture, sessionId: string, role: 'user' | 'assistant', text: string, owner: string) {
  seq += 1
  return (await getPool().query<{ id: string }>(`INSERT INTO session_messages(session_id,role,content,sequence_num,workspace_id,user_id,assistant_id,
      sensitivity,compartments,project_ids,scope_version,scope_held)
    VALUES($1,$2,$3::jsonb,$4,$5,$6,$7,'internal','{}','{}',1,false) RETURNING id`,
  [sessionId, role, JSON.stringify([{ type: 'text', text }]), seq, f.workspaceId, owner, f.assistants.brian])).rows[0]!.id
}

/** A real research turn for `actor`: activity, default Page, inspected link. */
export async function savedResearch(f: BriefFixture, actor: string, projectId: string | null, assistantId = f.assistants.brian) {
  const sessionId = await researchSession(f, actor, projectId, assistantId)
  const request = await researchMessage(f, sessionId, 'user', 'Research fictional widget vendors', actor)
  const activity = await beginResearchActivity({
    workspaceId: f.workspaceId, sessionId, requestMessageId: request, actorUserId: actor, assistantId,
    projectId, entry: 'explicit', runtime: { surface: 'test' },
  })
  const output = await researchMessage(f, sessionId, 'assistant', 'Vendor A leads on price.', actor)
  const observer = createResearchTurnObserver()
  observer.observeWorker({ type: 'tool_input', id: 'w1', name: 'urlReader', input: { url: 'https://example.com/vendors' } })
  observer.observeWorker({ type: 'tool_result', id: 'w1', results: [{ type: 'tool_result', toolUseId: 'w1', name: 'urlReader', content: 'text' }] })
  const settled = await recordResearchDelivery(createResearchDeliveryDeps(), {
    activity, observation: observer.snapshot(), finalText: '## Vendors\nVendor A leads on price.', outputMessageId: output, requestText: 'Research fictional widget vendors',
  })
  return { sessionId, request, output, activity: settled }
}

/** One member follow-up on a saved research result, captured the production way. */
export async function followUp(f: BriefFixture, research: { sessionId: string }, actor: string, text: string) {
  const messageId = await researchMessage(f, research.sessionId, 'user', text, actor)
  const captured = await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId: research.sessionId,
    assistantId: f.assistants.brian, messageId, actorUserId: actor, externalPrincipal: false })
  if (!captured || (captured.outcome !== 'recorded' && captured.outcome !== 'replayed')) throw new Error(`follow-up not linked: ${JSON.stringify(captured)}`)
  return { messageId, feedback: captured.feedback }
}
