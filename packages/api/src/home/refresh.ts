/**
 * Home refresh — run the workspace primary assistant for one focused turn to
 * curate the "Suggested for you" dock. The ONLY tool injected is `setHomeDock`
 * (so the curation tool never leaks into normal chat — see the plan §6); the
 * signals snapshot is handed to the model as the user message, and the tool's
 * side effect persists the artifact.
 *
 * Best-effort by contract: the caller (the POST /api/home-dock/refresh route)
 * wraps this in try/catch and re-resolves the dock afterward, so a failed or
 * empty curation turn just leaves the deterministic fallback in place.
 *
 * See docs/architecture/features/home-dock.md → "Refresh".
 *
 * [COMP:api/home-refresh]
 */

import { randomUUID } from 'node:crypto'
import { createHomeTools, queryLoop, type HomeDockStore, type HomeSignals } from '@sidanclaw/core'

type Provider = Parameters<typeof queryLoop>[0]['provider']

const REFRESH_TIMEOUT_MS = 45_000

const SYSTEM_PROMPT = `You curate the "Suggested for you" home dock for a workspace's user.

You are given today's live signals. Call setHomeDock EXACTLY ONCE, then stop.

- note: one short, warm, specific sentence (≤280 chars) that helps the user know what to do next, grounded in the signals (e.g. an upcoming workflow, a draft worth finishing, a fast-growing brain). Omit (null) if nothing is worth saying — do not invent news, and never write a bare greeting.
- needsYou: order the action cards ('brain_review', 'approvals', 'autopilot', 'connector_attention', 'workflow_attention') by what matters most right now. A broken connector or failed workflow runs usually belong first — they silently block everything downstream. Omit a kind whose count is already 0. The two attention kinds surface automatically while live even if you omit them; list one only to reposition or caption it. Counts are filled in live, so never state a number yourself.

Be terse. Do not narrate. Do not call any other tool.`

function buildUserMessage(signals: HomeSignals): string {
  const lines = [
    'Live signals for this workspace:',
    `- brain entries awaiting review: ${signals.brainReviewCount}`,
    `- approvals waiting: ${signals.approvalsCount}`,
    `- autopilot goals waiting on a confirm or unblock: ${signals.autopilotCount}`,
    `- connectors whose credentials stopped working (ingestion paused until reconnect): ${signals.connectorAttentionCount}`,
    `- workflow runs failed in the last 48 hours: ${signals.workflowAttentionCount}`,
    `- brain size: ${signals.brainEntryCount} entries (+${signals.brainGrowth7d} in the last 7 days)`,
    `- connector connected: ${signals.onboarding.hasConnector ? 'yes' : 'no'}`,
    `- upcoming workflows: ${
      signals.upcomingWorkflows.length
        ? signals.upcomingWorkflows.map((w) => `${w.name} @ ${w.nextRunAt}`).join('; ')
        : 'none'
    }`,
    `- drafts to resume: ${
      signals.recentDrafts.length
        ? signals.recentDrafts.map((d) => d.name).join('; ')
        : 'none'
    }`,
    '',
    'Curate the dock now with setHomeDock.',
  ]
  return lines.join('\n')
}

export async function runHomeRefresh(params: {
  userId: string
  workspaceId: string
  /** The workspace primary assistant id (attribution), or null. */
  assistantId: string | null
  provider: Provider
  homeDockStore: HomeDockStore
  signals: HomeSignals
}): Promise<void> {
  const { setHomeDock } = createHomeTools({ store: params.homeDockStore })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
  try {
    for await (const _event of queryLoop({
      provider: params.provider,
      model: 'gemini-flash',
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(params.signals) }],
      tools: new Map([['setHomeDock', setHomeDock]]),
      context: {
        userId: params.userId,
        assistantId: params.assistantId ?? 'home-refresh',
        sessionId: randomUUID(),
        appId: 'home-refresh',
        channelType: 'home-refresh',
        channelId: params.workspaceId,
        workspaceId: params.workspaceId,
        abortSignal: controller.signal,
      },
      maxTurns: 3,
    })) {
      // Drain the stream; `setHomeDock` persists the artifact as a side effect.
    }
  } finally {
    clearTimeout(timer)
  }
}
