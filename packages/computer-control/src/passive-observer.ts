import { z } from 'zod'

export const PassiveObserverReasonSchema = z.enum(['detached', 'expired', 'capacity', 'invalid_metadata', 'factory_failed', 'callback_failed', 'timeout', 'source_loss'])
export type PassiveObserverReason = z.infer<typeof PassiveObserverReasonSchema>

/** Trusted synchronous metadata only. Descriptor inspection avoids getters, not
 * hostile Proxy traps or blocking JS; this is not a sandbox or a drain probe. */
export const PassiveObserverHealthSchema = z.preprocess(input => {
  try {
    if (!input || typeof input !== 'object') return undefined
    const prototype = Object.getPrototypeOf(input)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    const keys = Reflect.ownKeys(input)
    if (keys.length !== 3 || keys.some(k => k !== 'state' && k !== 'reason' && k !== 'drain')) return undefined
    const copy = Object.create(null)
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(input, key)
      if (!d || !('value' in d) || !d.enumerable) return undefined
      copy[key] = d.value
    }
    return copy
  } catch { return undefined }
}, z.object({ state: z.literal('incomplete'), reason: PassiveObserverReasonSchema.nullable(), drain: z.literal('not_observed') }).strict()).transform(value => Object.freeze(value))
export type PassiveObserverHealth = z.infer<typeof PassiveObserverHealthSchema>
export function passiveObserverHealth(reason: PassiveObserverReason | null): PassiveObserverHealth {
  return PassiveObserverHealthSchema.parse({ state: 'incomplete', reason, drain: 'not_observed' })
}
