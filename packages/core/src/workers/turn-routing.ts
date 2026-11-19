/**
 * Turn routing decision core. One typed decision for the per-turn research,
 * topic and split questions that web chat and messaging channels currently
 * orchestrate inline.
 *
 * Framework-neutral and free of I/O of its own: every model call goes through
 * a host-supplied classifier port, every authority proof through a host
 * lane check, and every usage record through a host recorder. Deterministic
 * shortcuts decide first and make no model call. The default strategy runs
 * the existing research, topic and split classifiers concurrently over one
 * captured input; a single combined decision call is opt-in and refuses to
 * run without an evaluation receipt.
 *
 * Spec: docs/architecture/features/research.md → "Turn routing".
 * [COMP:core/turn-routing]
 */

import { isTrivialChatMessage } from '../classification/trivial-chat.js'
import type { ClassifierRecentTurn, TopicAnchor, TopicClassification } from '../memory/topic-classifier.js'
import type { TokenUsage } from '@use-brian/agent-runtime/providers/types.js'
import { detectOperateSiteIntent, type ResearchClassifyResult } from './research-classifier.js'
import type { ResearchEffort } from './research-effort.js'
import type { SplitResult } from './splitter.js'

export type TurnRoutingProfile = 'web' | 'channel'
export type TurnRoutingLane = 'research' | 'topic' | 'split'

/** Names and descriptions only. A descriptor is never an execution grant. */
export type CapabilityDescriptorRef = Readonly<{ name: string; description: string }>

/** One captured, admitted input shared byte-for-byte by every classifier lane. */
export type TurnRoutingCapture = {
  /** Exact authored text of the current user row. */
  message: string
  /** Up to six earlier visible user/assistant text turns, oldest first. */
  recentConversation: Array<{ role: 'user' | 'assistant'; text: string }>
  topic: {
    recentUserTurns: ClassifierRecentTurn[]
    knownTopicsThisSession: string[]
    topicAnchors?: TopicAnchor[]
    /** Resolved reply target text; a reply always reaches the topic classifier. */
    replyToText: string | null
    /** False for attachments, non-text blocks, an explicit reply or a client snippet. */
    allowTrivialShortcut: boolean
  }
}

/** Facts the web route already resolves before routing (`chat.ts`). */
export type WebRoutingFacts = {
  profile: 'web'
  /** Explicit API mode; `undefined` is adaptive. */
  requestedMode?: 'default' | 'research'
  workspaceId: string | null
  assistantKind: string
  /** False only for an exhausted free allowance under the research plan gate. */
  researchQuotaAvailable: boolean
  /** Workspace read rule anchored to a document page. */
  pageBound: boolean
  docSurface: boolean
  /** Tier of the ordinary (non-research) main model after budget resolution. */
  tier: 'standard' | 'pro_max'
  /** Inputs of the invariant Standard splitter route (`canPrepareStandardSplit`). */
  model: {
    custom: boolean
    explicitMetered: boolean
    standardWhenOk: boolean
    standardWhenDowngraded: boolean
  }
}

/** Facts the channel pipeline already resolves before routing. */
export type ChannelRoutingFacts = {
  profile: 'channel'
  adaptiveResearchEnabled: boolean
  workspaceId: string | null
  plan: string
  budgetStatus: string
  isolatedAudience: boolean
}

export type TurnRoutingFacts = WebRoutingFacts | ChannelRoutingFacts

export type TurnRoutingPortRequest = Readonly<{
  profile: TurnRoutingProfile
  input: Readonly<TurnRoutingCapture>
  signal: AbortSignal
  /** This lane's own input-authority check; never shared with a sibling lane. */
  assertInputAuthority: () => Promise<void>
}>

export type CombinedTurnDecision = {
  research?: ResearchClassifyResult
  topic?: TopicClassification
  split?: SplitResult
  usage: TokenUsage | null
  model: string | null
}

export type TurnRoutingPorts = {
  research: (request: TurnRoutingPortRequest & { toolCandidates?: readonly CapabilityDescriptorRef[] }) => Promise<ResearchClassifyResult>
  topic: (request: TurnRoutingPortRequest) => Promise<TopicClassification>
  split: (request: TurnRoutingPortRequest & { phase: 'concurrent' | 'late' }) => Promise<SplitResult>
  /** Optional single decision call. Used only by the `combined` strategy. */
  combined?: (request: TurnRoutingPortRequest & {
    lanes: readonly TurnRoutingLane[]
    toolCandidates?: readonly CapabilityDescriptorRef[]
  }) => Promise<CombinedTurnDecision>
}

/**
 * `concurrent` is the default and the only evaluated strategy. `combined`
 * must name the evaluation receipt that proved it against the concurrent
 * classifiers; routing refuses it otherwise.
 */
export type TurnRoutingStrategy = { kind: 'concurrent' } | { kind: 'combined'; evaluationReceipt: string }

/** Background billing attribution, passed verbatim onto every usage record. */
export type TurnRoutingAttribution = Readonly<Record<string, string | number | boolean | null>>

export type TurnRoutingUsageRecord = Readonly<{
  lane: TurnRoutingLane | 'combined'
  model: string | null
  usage: TokenUsage | null
  source: 'overhead:classifier' | 'overhead:splitter'
  triggerKey?: string
  /** The call happened but its decision was not adopted. Its usage still counts. */
  discarded: boolean
  attribution: TurnRoutingAttribution
}>

export type TurnRoutingInput = {
  facts: TurnRoutingFacts
  capture: TurnRoutingCapture
  /** Scoped capability catalog. Absent → research does not own tool selection. */
  capabilities?: readonly CapabilityDescriptorRef[]
  ports: TurnRoutingPorts
  authority: Readonly<Record<TurnRoutingLane, () => Promise<void>>>
  /** Awaited exactly once per completed model call, on success, refusal and Stop. */
  recordUsage: (record: TurnRoutingUsageRecord) => Promise<void>
  attribution: TurnRoutingAttribution
  /** Stop/abort for the whole routing phase. */
  signal?: AbortSignal
  strategy?: TurnRoutingStrategy
}

export type TurnRouteResearch = {
  active: boolean
  entry: 'explicit' | 'adaptive' | null
  effort: ResearchEffort | null
  reason: string | null
  operateSite: boolean
  /** Present when a catalog was supplied and preparation owns selection (may be empty). */
  toolNames?: string[]
}

export type TurnRoute = {
  profile: TurnRoutingProfile
  research: TurnRouteResearch
  topic: { classification: TopicClassification | null; ephemeral: boolean }
  /** Routed worker tasks and their consumer, or null when no split is warranted. */
  split: { tasks: string[]; delegation: 'preflight' | 'coordinator' } | null
  usage: TurnRoutingUsageRecord[]
  /** Classifier invocations made by this route (deterministic decisions are free). */
  modelCalls: number
  /** Why each lane decided as it did: `model`, `shortcut:*`, `skip:*`, `explicit`. */
  trace: Record<TurnRoutingLane, string>
}

type ResearchPlan =
  | { kind: 'explicit' }
  | { kind: 'skip'; reason: string }
  | { kind: 'shortcut'; reason: 'operate_site' | 'trivial' }
  | { kind: 'model' }
type TopicPlan = { kind: 'skip'; reason: string } | { kind: 'shortcut'; reason: 'trivial' } | { kind: 'model' }
type SplitDelegation = { delegation: 'preflight' | 'coordinator' } | { none: string }

export type TurnRoutePlan = {
  research: ResearchPlan
  topic: TopicPlan
  /** Deterministic site-operation signal computed for every turn (web only). */
  operateSite: boolean
  split: {
    /** Start with the sibling classifiers over the same captured input. */
    concurrent: boolean
    /** A research or site verdict cancels (or discards) the concurrent split. */
    discardOnVerdict: boolean
    resolve: (research: boolean, operateSite: boolean) => SplitDelegation
  }
}

const SPLIT_MIN_LENGTH = 40
const FALLBACK_TOPIC = '(uncategorized)'
const DISCARDED = Symbol('turn-routing.split-discarded')

const USAGE_KEYS: Record<TurnRoutingProfile, Record<TurnRoutingLane, { source: TurnRoutingUsageRecord['source']; triggerKey?: string }>> = {
  web: {
    research: { source: 'overhead:classifier', triggerKey: 'adaptive_research_classifier' },
    topic: { source: 'overhead:classifier' },
    split: { source: 'overhead:splitter', triggerKey: 'parallel_split_classifier' },
  },
  channel: {
    research: { source: 'overhead:classifier', triggerKey: 'adaptive_research' },
    topic: { source: 'overhead:classifier' },
    split: { source: 'overhead:splitter', triggerKey: 'parallel_split_classifier' },
  },
}

/** Clear greetings/acknowledgments only; short substantive asks still reach assessment. */
function researchTrivial(message: string): boolean {
  return !message.trim() || (message.length <= SPLIT_MIN_LENGTH && isTrivialChatMessage(message))
}

function topicTrivial(capture: TurnRoutingCapture): boolean {
  return capture.topic.allowTrivialShortcut && !capture.topic.replyToText && isTrivialChatMessage(capture.message)
}

function planWeb(facts: WebRoutingFacts, capture: TurnRoutingCapture): TurnRoutePlan {
  const message = capture.message
  // App assistants never take the explicit toggle (`appAssistantForbidsResearch`).
  const explicit = facts.requestedMode === 'research' && facts.assistantKind !== 'app'
  // `isAdaptiveResearchEligible`.
  const adaptiveEligible = !explicit && !!message && facts.requestedMode === undefined &&
    !!facts.workspaceId && facts.researchQuotaAvailable && facts.assistantKind !== 'app'
  const operateSite = !explicit && !!message && detectOperateSiteIntent(message)
  const research: ResearchPlan = explicit ? { kind: 'explicit' }
    : facts.pageBound ? { kind: 'skip', reason: 'page_bound' }
    : !adaptiveEligible ? { kind: 'skip', reason: 'ineligible' }
    : operateSite ? { kind: 'shortcut', reason: 'operate_site' }
    : researchTrivial(message) ? { kind: 'shortcut', reason: 'trivial' }
    : { kind: 'model' }
  const topic: TopicPlan = facts.pageBound ? { kind: 'skip', reason: 'page_bound' }
    : topicTrivial(capture) ? { kind: 'shortcut', reason: 'trivial' }
    : { kind: 'model' }
  const long = !!message && message.length > SPLIT_MIN_LENGTH
  // `canPrepareStandardSplit`, plus its capture precondition (adaptive-eligible, not page-bound).
  const concurrent = adaptiveEligible && !facts.pageBound && long && !operateSite &&
    facts.assistantKind === 'primary' && !facts.docSurface && !facts.model.custom && !facts.model.explicitMetered &&
    facts.model.standardWhenOk && facts.model.standardWhenDowngraded
  const coordinatorEligible = facts.assistantKind !== 'app' && !facts.docSurface
  return {
    research, topic, operateSite,
    split: {
      concurrent,
      discardOnVerdict: true,
      resolve(active, site) {
        if (!long) return { none: 'short' }
        if (coordinatorEligible && (active || facts.tier === 'pro_max')) {
          if (active) return { none: 'research' }
          if (site) return { none: 'operate_site' }
          return { delegation: 'coordinator' }
        }
        if (active && facts.docSurface) return { none: 'doc_research' }
        if (site) return { none: 'operate_site' }
        return { delegation: 'preflight' }
      },
    },
  }
}

function planChannel(facts: ChannelRoutingFacts, capture: TurnRoutingCapture): TurnRoutePlan {
  const message = capture.message
  const skip = facts.isolatedAudience ? 'isolated_audience'
    : !facts.adaptiveResearchEnabled ? 'not_enabled'
    : !message ? 'no_message'
    : !facts.workspaceId ? 'no_workspace'
    : facts.plan === 'free' ? 'unpaid'
    : facts.budgetStatus === 'downgraded' ? 'budget_downgraded'
    : null
  const research: ResearchPlan = skip ? { kind: 'skip', reason: skip }
    : detectOperateSiteIntent(message) ? { kind: 'shortcut', reason: 'operate_site' }
    : researchTrivial(message) ? { kind: 'shortcut', reason: 'trivial' }
    : { kind: 'model' }
  const topic: TopicPlan = topicTrivial(capture) ? { kind: 'shortcut', reason: 'trivial' } : { kind: 'model' }
  // Channel preflight has no Standard gating: any non-isolated message over 40 characters.
  const split = facts.isolatedAudience ? 'isolated_audience' : message.length > SPLIT_MIN_LENGTH ? null : 'short'
  return {
    research, topic, operateSite: false,
    split: {
      concurrent: split === null,
      discardOnVerdict: false,
      resolve: () => split === null ? { delegation: 'preflight' } : { none: split },
    },
  }
}

/** The deterministic half of routing: which lanes need a model call. No I/O. */
export function planTurnRoute(facts: TurnRoutingFacts, capture: TurnRoutingCapture): TurnRoutePlan {
  return facts.profile === 'web' ? planWeb(facts, capture) : planChannel(facts, capture)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function catalogNames(capabilities: readonly CapabilityDescriptorRef[] | undefined): Set<string> | undefined {
  if (capabilities === undefined) return undefined
  const names = new Set<string>()
  for (const descriptor of capabilities) {
    if (typeof descriptor?.name !== 'string' || !descriptor.name.trim() || names.has(descriptor.name)) {
      throw new TypeError('Turn routing capability catalog requires unique non-empty names')
    }
    names.add(descriptor.name)
  }
  return names
}

/** Every routed tool name must be in the supplied catalog, or the whole selection is refused. */
function routedToolNames(
  names: Set<string> | undefined, plan: ResearchPlan, result: ResearchClassifyResult | undefined,
): { toolNames?: string[]; rejected: boolean } {
  if (!names || plan.kind === 'explicit' || plan.kind === 'skip') return { rejected: false }
  if (plan.kind === 'shortcut' && plan.reason === 'operate_site') return { rejected: false }
  const selected = result?.toolNames
  if (selected === undefined) return { toolNames: [], rejected: false }
  if (!Array.isArray(selected) || selected.some(name => typeof name !== 'string' || !names.has(name))) {
    return { toolNames: [], rejected: true }
  }
  return { toolNames: [...new Set(selected)], rejected: false }
}

function shortcutResearch(reason: 'operate_site' | 'trivial'): ResearchClassifyResult {
  return reason === 'operate_site'
    ? { research: false, operateSite: true, reason: 'operate_site_fast_path', usage: null, model: null }
    : { research: false, operateSite: false, reason: null, usage: null, model: null }
}

function shortcutTopic(capture: TurnRoutingCapture): TopicClassification {
  const prior = [...capture.topic.recentUserTurns].reverse().find(turn => turn.topicLabel)?.topicLabel
  return { topic_label: prior ?? FALLBACK_TOPIC, state: 'continue', confidence: 0, usage: null }
}

type Completed = { lane: TurnRoutingLane | 'combined'; model: string | null; usage: TokenUsage | null }

/**
 * Route one turn. Rejects with the lane refusal or Stop reason after every
 * started lane has settled and every completed call's usage has been recorded.
 */
export async function routeTurn(input: TurnRoutingInput): Promise<TurnRoute> {
  const strategy = input.strategy ?? { kind: 'concurrent' }
  if (strategy.kind === 'combined' && (!strategy.evaluationReceipt?.trim() || !input.ports.combined)) {
    throw new Error('Combined turn routing requires an evaluation receipt and a combined decision port')
  }
  const profile = input.facts.profile
  const external = input.signal
  external?.throwIfAborted()
  const names = catalogNames(input.capabilities)
  const toolCandidates = input.capabilities ? deepFreeze(structuredClone([...input.capabilities])) : undefined
  // One capture, pinned before any await; every lane reads these exact bytes.
  const capture = deepFreeze(structuredClone(input.capture))
  const plan = planTurnRoute(input.facts, capture)
  const attribution = Object.freeze({ ...input.attribution })
  const { authority, ports } = input
  const signal = external ?? new AbortController().signal

  const completed: Completed[] = []
  let modelCalls = 0
  let splitStarted = false
  let adoptedSplit = false
  let routed = false
  const trace: Record<TurnRoutingLane, string> = { research: '', topic: '', split: '' }
  const request = (lane: TurnRoutingLane, laneSignal = signal) =>
    ({ profile, input: capture, signal: laneSignal, assertInputAuthority: authority[lane] })
  const finish = async () => {
    const records = completed.map((call): TurnRoutingUsageRecord => {
      const keys = call.lane === 'combined' ? { source: 'overhead:classifier' as const, triggerKey: 'turn_routing_combined' } : USAGE_KEYS[profile][call.lane]
      const discarded = !routed || (call.lane === 'split' && !adoptedSplit)
      return Object.freeze({ lane: call.lane, model: call.model, usage: call.usage, ...keys, discarded, attribution })
    })
    completed.length = 0
    for (const record of records) await input.recordUsage(record)
    return records
  }

  let failure: { error: unknown } | undefined
  let research: ResearchClassifyResult | undefined
  let topic: TopicClassification | undefined
  let concurrentSplit: SplitResult | undefined
  try {
    const researchNeedsModel = plan.research.kind === 'model'
    const topicNeedsModel = plan.topic.kind === 'model'
    const splitPossible = plan.split.concurrent || 'delegation' in plan.split.resolve(false, plan.operateSite)
    const combinedLanes: TurnRoutingLane[] = [
      ...(researchNeedsModel ? ['research' as const] : []),
      ...(topicNeedsModel ? ['topic' as const] : []),
      ...(splitPossible ? ['split' as const] : []),
    ]
    const useCombined = strategy.kind === 'combined' && combinedLanes.length >= 2

    // Deterministic shortcuts still prove the lane's input authority: their
    // output (for example a prior topic label) derives from the captured input.
    const decideResearch = async (): Promise<ResearchClassifyResult | undefined> => {
      if (plan.research.kind === 'shortcut') { await authority.research(); return shortcutResearch(plan.research.reason) }
      if (plan.research.kind !== 'model' || useCombined) return undefined
      modelCalls++
      const result = await ports.research({ ...request('research'), ...(toolCandidates ? { toolCandidates } : {}) })
      completed.push({ lane: 'research', model: result.model, usage: result.usage })
      await authority.research()
      return result
    }
    const decideTopic = async (): Promise<TopicClassification | undefined> => {
      if (plan.topic.kind === 'shortcut') { await authority.topic(); return shortcutTopic(capture) }
      if (plan.topic.kind !== 'model' || useCombined) return undefined
      modelCalls++
      const result = await ports.topic(request('topic'))
      completed.push({ lane: 'topic', model: result.model ?? null, usage: result.usage ?? null })
      await authority.topic()
      return result
    }
    const splitAbort = new AbortController()
    const decideSplit = async (): Promise<SplitResult | undefined> => {
      if (!plan.split.concurrent || useCombined) return undefined
      modelCalls++
      splitStarted = true
      try {
        const result = await ports.split({ ...request('split', AbortSignal.any([signal, splitAbort.signal])), phase: 'concurrent' })
        completed.push({ lane: 'split', model: result.model, usage: result.usage })
        return result
      } catch (error) {
        // A verdict-cancelled speculative split is not a failure and has no usage.
        if (splitAbort.signal.aborted && error === DISCARDED && !signal.aborted) return undefined
        throw error
      }
    }

    if (useCombined) {
      modelCalls++
      const decision = await ports.combined!({
        profile, input: capture, signal, lanes: Object.freeze([...combinedLanes]),
        ...(toolCandidates ? { toolCandidates } : {}),
        assertInputAuthority: async () => { for (const lane of combinedLanes) await authority[lane]() },
      })
      completed.push({ lane: 'combined', model: decision.model, usage: decision.usage })
      splitStarted = splitPossible
      for (const lane of combinedLanes) await authority[lane]()
      // A lane the combined answer omits takes that classifier's safe default.
      if (researchNeedsModel) research = decision.research ?? shortcutResearch('trivial')
      if (topicNeedsModel) topic = decision.topic ?? { topic_label: FALLBACK_TOPIC, state: 'continue', confidence: 0, usage: null }
      if (splitPossible) concurrentSplit = decision.split ?? { tasks: null, usage: null, model: null }
    }
    const settled = await Promise.allSettled([
      decideResearch().then(result => {
        if (result && plan.split.discardOnVerdict && (result.research || result.operateSite)) splitAbort.abort(DISCARDED)
        return result
      }),
      decideTopic(),
      decideSplit(),
    ])
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason
    research = research ?? (settled[0] as PromiseFulfilledResult<ResearchClassifyResult | undefined>).value
    topic = topic ?? (settled[1] as PromiseFulfilledResult<TopicClassification | undefined>).value
    concurrentSplit = concurrentSplit ?? (settled[2] as PromiseFulfilledResult<SplitResult | undefined>).value
    signal.throwIfAborted()

    const explicit = plan.research.kind === 'explicit'
    const active = explicit || !!research?.research
    const operateSite = !explicit && (plan.operateSite || !!research?.operateSite)
    if (research?.research && research.operateSite) throw new Error('research and operateSite are mutually exclusive')
    const delegation = plan.split.resolve(active, operateSite)
    let split: TurnRoute['split'] = null
    if ('delegation' in delegation) {
      let result = concurrentSplit
      if (result) trace.split = useCombined ? 'model:combined' : 'model:concurrent'
      else {
        modelCalls++
        result = await ports.split({ ...request('split'), phase: 'late' })
        completed.push({ lane: 'split', model: result.model, usage: result.usage })
        trace.split = 'model:late'
      }
      await authority.split()
      signal.throwIfAborted()
      adoptedSplit = true
      split = result.tasks ? { tasks: [...result.tasks], delegation: delegation.delegation } : null
    } else {
      trace.split = `${splitStarted ? 'discarded' : 'skip'}:${delegation.none}`
    }

    const tools = routedToolNames(names, plan.research, research)
    trace.research = plan.research.kind === 'explicit' ? 'explicit'
      : plan.research.kind === 'skip' ? `skip:${plan.research.reason}`
      : plan.research.kind === 'shortcut' ? `shortcut:${plan.research.reason}`
      : useCombined ? 'model:combined' : 'model'
    if (tools.rejected) trace.research += ':tool_selection_rejected'
    trace.topic = plan.topic.kind === 'skip' ? `skip:${plan.topic.reason}`
      : plan.topic.kind === 'shortcut' ? `shortcut:${plan.topic.reason}`
      : useCombined ? 'model:combined' : 'model'
    const researchRoute: TurnRouteResearch = explicit
      ? { active: true, entry: 'explicit', effort: 'deep', reason: 'explicit', operateSite: false }
      : {
        active,
        entry: active ? 'adaptive' : null,
        effort: active ? research?.effort ?? 'standard' : null,
        reason: research?.reason ?? null,
        operateSite,
        ...(tools.toolNames ? { toolNames: tools.toolNames } : {}),
      }
    routed = true
    const usage = await finish()
    signal.throwIfAborted()
    return {
      profile,
      research: researchRoute,
      topic: { classification: topic ?? null, ephemeral: plan.topic.kind === 'shortcut' },
      split,
      usage,
      modelCalls,
      trace,
    }
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    // Usage is data, not permission: completed calls are recorded once even
    // when a sibling refuses, the route is abandoned, or the user stops.
    if (failure && completed.length) {
      routed = false
      try { await finish() } catch (recordError) { console.error('[turn-routing] usage recording failed:', recordError) }
    }
  }
}
