import { BUILTIN_PRIMITIVE_CONNECTOR_IDS } from '@use-brian/shared'

/**
 * Seed the built-in workspace primitives (`files` / `office` / `computer`) for
 * a newly created assistant.
 *
 * These are the `auth_type: 'none'` connectors, whose tools carry
 * `requiresCapability: '<connector id>'`. The grant is their ON state, so an
 * assistant created without one starts with that primitive switched OFF.
 *
 * `files` is NOT seeded here: it is a primary-only default (an app specialist
 * having no file tools is deliberate — see files.md → "Tools (8,
 * capability-gated)"), and the primary creation paths seed it explicitly
 * alongside the §17 primitives. `office` and `computer` were injected
 * unconditionally before the off switch existed, so every creation path must
 * seed them or a new assistant would silently lose capability its predecessors
 * had. Migration 412 is the same statement for assistants that already exist.
 *
 * Derived from the registry, so a 4th `auth_type: 'none'` connector is seeded
 * without editing this list — subtract, never enumerate.
 *
 * See docs/architecture/features/builtin-primitives.md.
 */
export const DEFAULT_ON_BUILTIN_CAPABILITIES: readonly string[] = [
  ...BUILTIN_PRIMITIVE_CONNECTOR_IDS,
].filter((id) => id !== 'files').sort()

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
