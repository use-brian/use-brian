import type { SessionOptions, ToolDefinition, ToolSchemaRegistrationMode } from './types.js'

/** Opt-in presentation plan. Legacy drivers always retain their complete eager list. */
export function registeredToolDefinitions(
  options: Pick<SessionOptions, 'tools' | 'toolRegistration'>,
  mode: ToolSchemaRegistrationMode,
): readonly ToolDefinition[] {
  const plan = options.toolRegistration
  if (plan?.mode === 'deferred') {
    if (mode === 'dynamic') return plan.active
    if (mode === 'native-deferred') return plan.catalog
  }
  return options.tools ?? []
}
