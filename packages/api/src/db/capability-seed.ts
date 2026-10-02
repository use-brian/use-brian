import { BUILTIN_PRIMITIVE_CONNECTOR_IDS, DEFAULT_HOME_APP_TOOL_CAPABILITIES } from '@use-brian/shared'

/**
 * Seed the default-on built-in primitives and Home app tool sets at assistant
 * creation. Page, Feed, and the declared sets preserve prior availability.
 * Existing Tasks/CRM grants remain kind-specific; Files is seeded separately
 * for primary and standard assistants. App specialists do not receive Files.
 * See docs/architecture/features/builtin-primitives.md.
 */
export const DEFAULT_ON_BUILTIN_CAPABILITIES: readonly string[] = [
  ...BUILTIN_PRIMITIVE_CONNECTOR_IDS,
  ...DEFAULT_HOME_APP_TOOL_CAPABILITIES,
// Native desktop access is explicit opt-in, never a default built-in grant.
].filter((id) => id !== 'files' && id !== 'native_computer').sort()

type QueryFn = (sql: string, params: unknown[]) => Promise<unknown>

/**
 * Insert the default-on built-in primitive grants for `assistantId`.
 *
 * Pass the transaction client's `query` when the caller is inside one, so the
 * grants roll back with the assistant rather than outliving a failed create.
 * Idempotent against the `uniq_active_capability` partial index.
 */
export async function seedBuiltinPrimitiveCapabilities(
  runQuery: QueryFn,
  assistantId: string,
  grantedByUserId: string,
  reason = 'built-in primitive — default-on at assistant creation',
): Promise<void> {
  if (DEFAULT_ON_BUILTIN_CAPABILITIES.length === 0) return
  const values = DEFAULT_ON_BUILTIN_CAPABILITIES.map(
    (_cap, i) => `($1, $${i + 3}, $2, ${'$' + (DEFAULT_ON_BUILTIN_CAPABILITIES.length + 3)})`,
  ).join(', ')
  await runQuery(
    `INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
     VALUES ${values}
     ON CONFLICT (assistant_id, capability) WHERE revoked_at IS NULL DO NOTHING`,
    [assistantId, grantedByUserId, ...DEFAULT_ON_BUILTIN_CAPABILITIES, reason],
  )
}
