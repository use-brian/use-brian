/**
 * Shared delivery-target resolution for scheduled deliveries.
 *
 * Extracted from `scheduling/tools.ts` (scheduling-authoring-unification) so
 * the workflow authoring path (`createWorkflow` with an inline schedule
 * trigger) and the deprecated `createScheduledJob` alias resolve a reminder's
 * delivery the SAME way — one implementation, not a fork. Every function is
 * pure (it takes the injected resolver / deliverer as an argument rather than
 * closing over a `deps` object), so both tool sets import the identical logic.
 *
 * See docs/architecture/features/workflow.md §3 and
 * docs/architecture/engine/scheduled-jobs.md → "Channel delivery".
 *
 * [COMP:scheduling/delivery-resolution]
 */

import type { DeliverToChannel } from '../workflow/executor.js'

/**
 * `deliver.channelType` on a workflow `assistant_call` step is typed to these
 * four channels. `coerceDeliverChannel` maps any other context (a `web`,
 * `cron`, or `assistant-call` session) onto `web` — the sentinel that means
 * "no messaging channel". `web` is **not** a real delivery target: a job that
 * resolves to it is either rejected at creation or, when it maintains a doc
 * page, run silently with no channel push.
 */
const DELIVER_CHANNELS = ['web', 'telegram', 'slack', 'whatsapp', 'msteams'] as const
export type DeliverChannel = (typeof DELIVER_CHANNELS)[number]

export function coerceDeliverChannel(channelType: string): DeliverChannel {
  return (DELIVER_CHANNELS as readonly string[]).includes(channelType)
    ? (channelType as DeliverChannel)
    : 'web'
}

/** Channels a confirmation ping can be posted to (web is the UI itself). */
const MESSAGING_CHANNELS = new Set(['telegram', 'slack', 'whatsapp', 'msteams'])

/** Messaging channel types the model may name as a delivery target. */
export type MessagingChannel = 'telegram' | 'slack' | 'whatsapp' | 'msteams'

/**
 * Human-readable resolution of a job's `(channelType, channelId)` delivery
 * target. `label` is what the model surfaces to the user (e.g.
 * `Telegram · group "GM Bro" · topic "Research"`); `topicId` is set for a
 * Telegram forum topic so the model can state the exact thread.
 */
export type DeliveryTargetLabel = {
  label: string
  topicId?: number
}

export type DeliveryTargetResolver = (args: {
  assistantId: string
  channelType: string
  channelId: string
}) => Promise<DeliveryTargetLabel | null>

/**
 * Resolve a doc page id to the workspace it lives in, scoped to what the
 * user can see. `null` = not found / not visible.
 */
export type ViewWorkspaceResolver = (args: {
  userId: string
  viewId: string
}) => Promise<string | null>

/**
 * When the next run is within 24 hours, return a `relativeTime` field
 * (e.g. "in 3 hours 15 minutes") so the model can surface it to the
 * user — making timezone mismatches immediately obvious.
 */
export function formatRelativeTime(nextRunAt: Date): { relativeTime?: string } {
  const diffMs = nextRunAt.getTime() - Date.now()
  if (diffMs < 0 || diffMs > 24 * 60 * 60 * 1000) return {}

  const totalMinutes = Math.round(diffMs / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  const parts: string[] = []
  if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`)
  if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`)

  return { relativeTime: `in ${parts.join(' ') || 'less than a minute'}` }
}

/**
 * Resolve the human-readable delivery descriptor for a job's stored channel.
 * Always returns `deliveryChannel` (the bare type, kept for back-compat);
 * adds `deliveryTarget` (label + topic) when a resolver is wired and
 * succeeds. Never throws — a resolver failure degrades to type-only.
 */
export async function describeDelivery(
  resolver: DeliveryTargetResolver | undefined,
  args: { assistantId: string; channelType: string; channelId: string },
): Promise<{
  deliveryChannel: string
  deliveryTarget?: DeliveryTargetLabel & { channelType: string }
}> {
  if (!resolver) return { deliveryChannel: args.channelType }
  try {
    const resolved = await resolver(args)
    if (resolved) {
      return {
        deliveryChannel: args.channelType,
        deliveryTarget: { channelType: args.channelType, ...resolved },
      }
    }
  } catch (err) {
    console.warn('[scheduling/describeDelivery] failed:', err)
  }
  return { deliveryChannel: args.channelType }
}

/**
 * Resolve the delivery channel TYPE + concrete channel id for a new schedule.
 *
 * No explicit channel → deliver to the preferred (else current) messaging
 * channel; the id captures the topic-encoded chat id of the session the
 * request came from, so per-group / per-topic cron delivery is pinned
 * automatically.
 *
 * An explicit channel TYPE was requested → the returned id must actually
 * belong to that type. A `channelId` is used only when the requested type
 * matches the preferred channel OR the current session; otherwise the id is
 * **empty** (unresolved). Pairing the requested type with a *different*
 * channel's id is the `channel_not_found` cross-wiring bug — authoring
 * "deliver to Slack" from a web/Telegram session stamped the session's
 * Telegram chat id (`880211324`) as the Slack channel, which fails on every
 * fire. On an empty id the caller guides the model (e.g. `listSlackChannels`,
 * or set the step's `deliver.channelId`) instead of persisting a bad target.
 */
export function resolveDeliveryChannel(
  context: {
    preferredChannel?: { channelType: string; channelId: string } | null
    channelType: string
    channelId: string
  },
  explicitChannel?: MessagingChannel,
): { channelType: string; channelId: string } {
  const preferred = context.preferredChannel
  if (!explicitChannel) {
    return {
      channelType: preferred?.channelType ?? context.channelType,
      channelId: preferred?.channelId ?? context.channelId,
    }
  }
  const channelId =
    explicitChannel === preferred?.channelType
      ? preferred.channelId
      : explicitChannel === context.channelType
        ? context.channelId
        : ''
  return { channelType: explicitChannel, channelId }
}

/**
 * Result of resolving a job's doc-page link. `viewId` is the link that was
 * actually stored (`null` = unlinked); `warning` is present ONLY when a
 * candidate id was supplied and then DROPPED.
 *
 * The drop is the point. Linking is deliberately non-fatal — a bad page id
 * must never fail an otherwise-valid schedule — but silently discarding an id
 * the model explicitly asked for turns a partial success into an invisible
 * one: the tool answers `{ ok: true, targetViewId: null }`, the model tells
 * the user "scheduled, and it will update your page", and nothing ever
 * touches that page. Worse, when the delivery channel resolves to `web` the
 * dropped link is what makes the job unschedulable at all, and the caller
 * then reports the *channel* as the problem ("connect a messaging channel"),
 * naming a cause that has nothing to do with the actual failure.
 *
 * `warning` carries the standard failure shape (what was dropped, why, the
 * next step, whether the same id can ever work) so the caller can surface it
 * on the SUCCESS payload. See docs/architecture/engine/tool-executor.md →
 * "Failure copy".
 */
export type TargetViewResolution = {
  viewId: string | null
  warning?: string
}

/**
 * Resolve the doc page a job should be linked to (migration 229). When a
 * `resolveViewWorkspace` validator is wired, the candidate is kept only if it
 * resolves to a page in the *same* workspace as the scheduling context —
 * otherwise it's dropped to `null` (never fail the job over a bad page id).
 * Without a validator the candidate is trusted (the FK still protects
 * integrity).
 *
 * Returns the drop REASON alongside the id — see `TargetViewResolution`.
 * `resolveTargetView` is the id-only wrapper kept for call sites that have
 * nowhere to surface a warning.
 */
export async function resolveTargetViewDetailed(
  resolver: ViewWorkspaceResolver | undefined,
  candidate: string | null | undefined,
  ctx: { userId: string; workspaceId?: string | null },
): Promise<TargetViewResolution> {
  if (!candidate) return { viewId: null }
  if (!resolver) return { viewId: candidate }
  let viewWorkspace: string | null
  try {
    viewWorkspace = await resolver({ userId: ctx.userId, viewId: candidate })
  } catch (err) {
    // The lookup itself broke — distinct from "no such page". Degrading both
    // to the same silent null is what makes an infrastructure failure read as
    // a bad id (and vice versa), so say which one happened.
    console.warn('[scheduling/resolveTargetView] failed:', err)
    return {
      viewId: null,
      warning: `Could not verify the doc page \`${candidate}\` (the page lookup itself failed), so this schedule was saved WITHOUT a page link and will not update that page. The schedule itself is live. This is transient: retry the page link once with the same id; if it fails again, tell the user the page could not be linked.`,
    }
  }
  if (viewWorkspace && viewWorkspace === ctx.workspaceId) return { viewId: candidate }
  if (!ctx.workspaceId) {
    return {
      viewId: null,
      warning: `The doc page \`${candidate}\` was NOT linked to this schedule: this session has no workspace context, so a page link cannot be verified or stored. The schedule itself is live but will not update that page. Schedule from inside the workspace that owns the page; re-sending this same id from here will drop it again.`,
    }
  }
  return {
    viewId: null,
    warning: viewWorkspace
      ? `The doc page \`${candidate}\` was NOT linked to this schedule: it lives in a different workspace than the one this schedule was created in, and a job can only maintain a page in its own workspace. The schedule itself is live but will not update that page. Pick a page in this workspace (\`findPage\` with the title, or \`listPages\`) and set targetViewId to that id; re-sending this same id will drop it again.`
      : `The doc page \`${candidate}\` was NOT linked to this schedule: no page with that id is visible here — it may have been deleted, superseded (every page edit can mint a new id), or be above this assistant's clearance. The schedule itself is live but will not update that page. Get a current page id from \`findPage\` (by title) or \`listPages\` and set targetViewId to that; re-sending this same id will drop it again.`,
  }
}

/** Id-only form of {@link resolveTargetViewDetailed}. */
export async function resolveTargetView(
  resolver: ViewWorkspaceResolver | undefined,
  candidate: string | null | undefined,
  ctx: { userId: string; workspaceId?: string | null },
): Promise<string | null> {
  return (await resolveTargetViewDetailed(resolver, candidate, ctx)).viewId
}

/**
 * Post a one-line confirmation ping into a freshly-configured messaging
 * channel so the user *sees* a scheduled update land in the correct chat /
 * forum topic now, rather than waiting for the next fire. Best-effort —
 * returns whether a ping was actually sent. No-op for web (the UI is the
 * channel), when no `deliverToChannel` / workspace is available, or on send
 * failure.
 */
export async function sendDeliveryConfirmation(
  deliverToChannel: DeliverToChannel | undefined,
  args: {
    workspaceId: string | null | undefined
    assistantId: string
    userId: string
    channelType: string
    channelId: string
    nextRunAt: Date
    label?: string
  },
): Promise<boolean> {
  if (!deliverToChannel || !args.workspaceId) return false
  if (!MESSAGING_CHANNELS.has(args.channelType)) return false
  const { relativeTime } = formatRelativeTime(args.nextRunAt)
  const where = args.label ? ` (${args.label})` : ''
  const when = relativeTime ? ` Next run ${relativeTime}.` : ''
  const text = `📍 Delivery target confirmed${where}. Your scheduled update will post in this exact channel.${when}`
  try {
    const outcome = await deliverToChannel({
      workspaceId: args.workspaceId,
      assistantId: args.assistantId,
      userId: args.userId,
      channelType: args.channelType as MessagingChannel,
      channelId: args.channelId,
      text,
    })
    // Only report a ping as sent when it actually reached the channel — a
    // `skipped` (e.g. no connected integration) must not claim success.
    return outcome.status === 'delivered'
  } catch (err) {
    console.warn('[scheduling/sendDeliveryConfirmation] failed:', err)
    return false
  }
}
