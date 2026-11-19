/**
 * [COMP:api/turn-kernel] Turn routing over the prepared roster (M3 WP5):
 * `routePreparedTurn` decides research, topic and split once per turn with
 * research tool selection drawn from the prepared capabilities, and the
 * foreground classifier budget per fixed turn. `before` is the classifier
 * call count of the inline route orchestration it replaces (web
 * `routes/chat.ts` assessment block, Pro/Max `classifySplit`, Standard and
 * channel `runPreflight` splitter), counted from those code paths; `after` is
 * the route's `modelCalls`, asserted against the ports actually invoked.
 * Classifier ports are fakes; nothing else is.
 */
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { TopicClassification } from '@use-brian/core/memory/topic-classifier.js'
import type { ResearchClassifyResult } from '@use-brian/core/workers/research-classifier.js'
import type { SplitResult } from '@use-brian/core/workers/splitter.js'
import type {
  ChannelRoutingFacts,
  TurnRoutingCapture,
  TurnRoutingUsageRecord,
  WebRoutingFacts,
} from '@use-brian/core/workers/turn-routing.js'
import { buildTool, type Tool } from '@use-brian/agent-runtime/tools/types.js'
import { routePreparedTurn, routingCapabilities } from '../capabilities.js'

const USAGE = { inputTokens: 10, outputTokens: 2 }
const LONG = 'Compare pricing of three project tools for a ten person team in detail'
const SHORT = 'what is the latest policy rate?'
const OPERATE = 'browse lu.ma for me and list the events happening this weekend'

const web = (over: Partial<WebRoutingFacts> = {}): WebRoutingFacts => ({
  profile: 'web', workspaceId: 'workspace-example', assistantKind: 'primary', researchQuotaAvailable: true, pageBound: false, docSurface: false,
  tier: 'standard', model: { custom: false, explicitMetered: false, standardWhenOk: true, standardWhenDowngraded: true }, ...over,
})
const proMax = { tier: 'pro_max' as const, model: { custom: false, explicitMetered: false, standardWhenOk: false, standardWhenDowngraded: false } }
const channel = (over: Partial<ChannelRoutingFacts> = {}): ChannelRoutingFacts => ({
  profile: 'channel', adaptiveResearchEnabled: true, workspaceId: 'workspace-example', plan: 'pro', budgetStatus: 'ok', isolatedAudience: false, ...over,
})
const capture = (message: string): TurnRoutingCapture => ({
  message, recentConversation: [{ role: 'user', text: 'earlier question' }, { role: 'assistant', text: 'earlier answer' }],
  topic: { recentUserTurns: [{ text: 'earlier question', topicLabel: 'tools' }], knownTopicsThisSession: ['tools'], replyToText: null, allowTrivialShortcut: true },
})

function readTool(name: string, hidden = false): Tool {
  return buildTool({ name, description: `Fictional ${name}`, inputSchema: z.object({}), isReadOnly: true, ...(hidden ? { hiddenFromModel: true } : {}),
    async execute() { return { data: name } } })
}
/** A prepared web roster: boot tools, the search pair and a guarded Calendar read adapter. */
const roster = new Map(['firstPartyRead', 'mcp_search', 'mcp_call', 'googleCalendarListEvents'].map((name) => [name, readTool(name)]))
roster.set('internalOnly', readTool('internalOnly', true))

async function route(facts: WebRoutingFacts | ChannelRoutingFacts, message: string, verdict: 'ordinary' | 'research' = 'ordinary', toolNames?: string[]) {
  const research = vi.fn(async (_request: { toolCandidates?: readonly { name: string }[] }): Promise<ResearchClassifyResult> => verdict === 'research'
    ? { research: true, effort: 'focused', operateSite: false, reason: 'multi-source', usage: USAGE, model: 'background', ...(toolNames ? { toolNames } : {}) }
    : { research: false, operateSite: false, reason: null, usage: USAGE, model: 'background', ...(toolNames ? { toolNames } : {}) })
  const topic = vi.fn(async (): Promise<TopicClassification> => ({ topic_label: 'tools', state: 'continue', confidence: 0.9, usage: USAGE, model: 'background' }))
  const split = vi.fn(async (): Promise<SplitResult> => ({ tasks: ['angle one', 'angle two'], usage: USAGE, model: 'background' }))
  const records: TurnRoutingUsageRecord[] = []
  const result = await routePreparedTurn({
    facts, capture: capture(message), roster, ports: { research, topic, split },
    authority: { research: async () => {}, topic: async () => {}, split: async () => {} },
    recordUsage: async (record) => { records.push(record) }, attribution: { modelTier: 'standard' },
  })
  return { result, invoked: research.mock.calls.length + topic.mock.calls.length + split.mock.calls.length, research, records }
}

/** Fixed turns: classifier calls before (inline orchestration) and after (one route). */
const FIXED: Array<{ turn: string; facts: WebRoutingFacts | ChannelRoutingFacts; message: string; verdict?: 'research'; before: number; after: number; split: 'preflight' | 'coordinator' | null }> = [
  { turn: 'web Standard trivial', facts: web(), message: 'thanks', before: 0, after: 0, split: null },
  { turn: 'web Standard short question', facts: web(), message: SHORT, before: 2, after: 2, split: null },
  { turn: 'web Standard long ordinary', facts: web(), message: LONG, before: 3, after: 3, split: 'preflight' },
  { turn: 'web Standard long research verdict', facts: web(), message: LONG, verdict: 'research', before: 3, after: 3, split: null },
  { turn: 'web Standard operate-site', facts: web(), message: OPERATE, before: 1, after: 1, split: null },
  { turn: 'web explicit research', facts: web({ requestedMode: 'research' }), message: LONG, before: 1, after: 1, split: null },
  { turn: 'web Pro/Max long ordinary', facts: web(proMax), message: LONG, before: 3, after: 3, split: 'coordinator' },
  { turn: 'web Pro/Max long research verdict', facts: web(proMax), message: LONG, verdict: 'research', before: 2, after: 2, split: null },
  { turn: 'channel paid long ordinary', facts: channel(), message: LONG, before: 3, after: 3, split: 'preflight' },
  { turn: 'channel trivial', facts: channel(), message: 'thanks', before: 0, after: 0, split: null },
]

describe('[COMP:api/turn-kernel] turn routing over the prepared roster', () => {
  it.each(FIXED)('$turn: $before classifier call(s) before, $after after', async ({ facts, message, verdict, before, after, split }) => {
    const { result, invoked, records } = await route(facts, message, verdict)
    expect(result.modelCalls).toBe(after)
    expect(invoked).toBe(after)
    expect(records).toHaveLength(after)
    // The budget never grows: one route owns the decisions the route blocks made separately.
    expect(after).toBeLessThanOrEqual(before)
    expect(result.split?.delegation ?? null).toBe(split)
  })

  it('selects research tools from the prepared roster as the model sees it', async () => {
    expect(routingCapabilities(roster).map((ref) => ref.name)).toEqual(['firstPartyRead', 'mcp_search', 'mcp_call', 'googleCalendarListEvents'])
    const chosen = await route(web(), LONG, 'ordinary', ['googleCalendarListEvents'])
    expect(chosen.research.mock.calls[0]![0].toolCandidates?.map((ref: { name: string }) => ref.name)).toContain('googleCalendarListEvents')
    expect(chosen.result.research.toolNames).toEqual(['googleCalendarListEvents'])
    // A hidden or folded name is not in the roster: the whole selection is refused.
    const refused = await route(web(), LONG, 'ordinary', ['internalOnly'])
    expect(refused.result.research.toolNames).toEqual([])
  })
})
