import type { NativeModelReadinessOptions } from './boot-runtime.js'
import type { NativeAccountingCapability } from './accounting.js'
import { z } from 'zod'
import type { NativeScope, NativeComputerService } from './service.js'

export const ReadinessContextSchema = z.object({
  workspaceId: z.string().uuid(), assistantId: z.string().uuid(),
  conversationId: z.string().uuid(), taskId: z.string().uuid(),
  deviceId: z.string().min(1).max(256),
}).strict()
export const ReadinessCodeSchema = z.enum([
  'native_disabled', 'configuration_invalid', 'schema_unavailable', 'auth_session_denied',
  'scope_denied', 'policy_denied', 'device_busy', 'relay_unavailable', 'relay_disabled',
  'accounting_unavailable', 'runtime_not_checked', 'model_unavailable', 'credits_blocked',
  'budget_invalid', 'provider_unsupported', 'check_failed',
])
export type ReadinessCode = z.infer<typeof ReadinessCodeSchema>
export const ReadinessWarningSchema = z.enum(['jwt_compatibility_unverified', 'live_model_unverified',
  'mac_verification_pending', 'vision_not_checked', 'vision_image_unsupported',
  'vision_approval_unaccepted', 'vision_approval_mismatch', 'vision_budget_insufficient', 'native_strict_adapter_unverified'])
export const ReadinessModelReportSchema = z.object({
  blockers: z.array(ReadinessCodeSchema).max(20), warnings: z.array(ReadinessWarningSchema).max(8),
}).strict()
export const ReadinessReportSchema = z.object({
  protocol: z.literal('native-computer-v1'), ready: z.boolean(), blockers: z.array(ReadinessCodeSchema).max(20),
  warnings: z.array(ReadinessWarningSchema).max(8),
}).strict()
export type ReadinessOptions = {
  /** Trusted boot composition, never request fields. No admission or reservation. */
  accountingAvailable: boolean
  /** Configuration/policy reads only; no runtime factory, grant, inference or accounting writes. */
  checkModel?: (scope: NativeScope) => Promise<z.infer<typeof ReadinessModelReportSchema>>
}
/** Production boot uses the identical options object used for its native runtime.
 * An opaque host runtime override cannot inherit claims about the default route. */
export function createNativeComputerReadinessOptions(accounting: NativeAccountingCapability | undefined,
  options: NativeModelReadinessOptions, runtimeOverridden = false): ReadinessOptions {
  return { accountingAvailable: !!accounting, ...(!runtimeOverridden ? {
    checkModel: async (scope: NativeScope) => {
      // Service imports the bounded schema/URL helpers from this module. Load
      // runtime inspection only after module initialization and scope admission.
      const { inspectNativeComputerModelReadiness } = await import('./boot-runtime.js')
      const { blockers, warnings } = await inspectNativeComputerModelReadiness(options, scope.workspaceId)
      return { blockers, warnings }
    },
  } : {}) }
}
export function safeReadinessUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Invalid endpoint')
  return url
}
export async function nativeReadiness(service: NativeComputerService | null,
  scope: NativeScope, authSessionId: string, deviceId: string, options?: ReadinessOptions) {
  const blockers: ReadinessCode[] = service ? [...await service.readiness(scope, authSessionId, deviceId)] : ['native_disabled']
  let modelWarnings: z.infer<typeof ReadinessWarningSchema>[] = ['vision_not_checked']
  if (!options?.accountingAvailable) blockers.push('accounting_unavailable')
  if (!options?.checkModel) blockers.push('runtime_not_checked')
  else if (!blockers.length) {
    try {
      const result = ReadinessModelReportSchema.parse(await options.checkModel(scope))
      blockers.push(...result.blockers); modelWarnings = result.warnings
    }
    catch { blockers.push('check_failed') }
  }
  return ReadinessReportSchema.parse({ protocol: 'native-computer-v1', ready: blockers.length === 0,
    blockers: [...new Set(blockers)], warnings: [...new Set(['jwt_compatibility_unverified', 'live_model_unverified',
      'mac_verification_pending', ...modelWarnings])] })
}
