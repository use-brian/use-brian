/**
 * Local-first, cross-instance fan-out for live goal execution activity.
 *
 * Goal ticks and their SSE viewers can land on different API instances. The
 * process-wide PostgreSQL notification listener bridges them, while local
 * subscribers receive frames immediately. Activity is best-effort and never
 * participates in the goal driver's control flow.
 *
 * [COMP:goals/live-activity]
 */
import { randomUUID } from 'node:crypto'
import { query } from '../db/client.js'
import {
  registerNotifyChannel,
  startNotifyListener,
  unregisterNotifyChannel,
} from '../db/notify-listener.js'
import {
  compactGoalActivityEnvelope,
  isGoalActivityEnvelope,
  type GoalActivityEnvelope,
  type GoalActivityFrame,
} from './activity.js'

const CHANNEL = 'goal_activity'
const SINGLE_PROCESS = process.env.USEBRIAN_SINGLE_PROCESS === '1'
const PROCESS_INSTANCE_ID = randomUUID()

type Subscriber = {
  goalId: string
  callback: (frame: GoalActivityFrame) => void
}

const subscribers = new Set<Subscriber>()
let started = false
const pendingRemoteReasoning = new Map<string, { text: string; timer: NodeJS.Timeout }>()
let remotePublishQueue: Promise<void> = Promise.resolve()

function dispatchLocal(envelope: GoalActivityEnvelope): void {
  for (const subscriber of subscribers) {
    if (subscriber.goalId !== envelope.goalId) continue
    try {
      subscriber.callback({ event: envelope.event, data: envelope.data })
    } catch (error) {
      console.warn('[goal-activity] subscriber callback threw:', error)
    }
  }
}

function handleNotification(payload: string): void {
  try {
    const envelope: unknown = JSON.parse(payload)
    if (isGoalActivityEnvelope(envelope) && envelope.origin !== PROCESS_INSTANCE_ID) {
      dispatchLocal(envelope)
    }
  } catch {
    // A malformed observability frame is dropped; it cannot affect execution.
  }
}

function start(): void {
  if (started) return
  started = true
  if (SINGLE_PROCESS) return
  registerNotifyChannel(CHANNEL, handleNotification)
  startNotifyListener()
}

export function subscribeGoalActivity(params: {
  goalId: string
  callback: (frame: GoalActivityFrame) => void
}): () => void {
  const subscriber: Subscriber = params
  subscribers.add(subscriber)
  start()
  return () => subscribers.delete(subscriber)
}

export function publishGoalActivity(
  goalId: string,
  frame: GoalActivityFrame,
): void {
  const envelope = compactGoalActivityEnvelope({ goalId, ...frame, origin: PROCESS_INSTANCE_ID })
  dispatchLocal(envelope)
  if (SINGLE_PROCESS) return

  // Reasoning arrives token-by-token. Local viewers keep true delta latency;
  // remote instances receive a 150ms coalesced delta so one long thought does
  // not turn PostgreSQL NOTIFY into a token transport.
  if (envelope.event === 'reasoning' && typeof envelope.data.text === 'string') {
    const pending = pendingRemoteReasoning.get(goalId)
    if (pending) {
      pending.text += envelope.data.text
      return
    }
    const timer = setTimeout(() => {
      const ready = pendingRemoteReasoning.get(goalId)
      pendingRemoteReasoning.delete(goalId)
      if (!ready) return
      publishRemote(compactGoalActivityEnvelope({
        goalId,
        event: 'reasoning',
        data: { text: ready.text },
      }))
    }, 150)
    timer.unref?.()
    pendingRemoteReasoning.set(goalId, { text: envelope.data.text, timer })
    return
  }
  const pending = pendingRemoteReasoning.get(goalId)
  if (pending) {
    clearTimeout(pending.timer)
    pendingRemoteReasoning.delete(goalId)
    publishRemote(compactGoalActivityEnvelope({
      goalId,
      event: 'reasoning',
      data: { text: pending.text },
    }))
  }
  publishRemote(envelope)
}

function publishRemote(envelope: GoalActivityEnvelope): void {
  remotePublishQueue = remotePublishQueue
    .then(async () => {
      await query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(envelope)])
    })
    .catch((error) => {
      console.warn('[goal-activity] notify failed (non-fatal):', error)
    })
}

/** Test cleanup for modules that subscribe directly. */
export async function _shutdownGoalActivityBus(): Promise<void> {
  subscribers.clear()
  for (const pending of pendingRemoteReasoning.values()) clearTimeout(pending.timer)
  pendingRemoteReasoning.clear()
  if (started && !SINGLE_PROCESS) await unregisterNotifyChannel(CHANNEL)
  await remotePublishQueue
  remotePublishQueue = Promise.resolve()
  started = false
}
