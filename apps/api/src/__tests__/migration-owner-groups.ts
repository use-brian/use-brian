/** [COMP:ci/execution-topology] Partition by executed scenario, not whole file. */
import { it, type TestFn } from 'node:test'

export const MIGRATION_OWNER_GROUPS = ['legacy', 'fresh', 'cutover', 'successor', 'prerequisites'] as const
export const MIGRATION_OWNER_SCENARIOS: Readonly<Record<string, typeof MIGRATION_OWNER_GROUPS[number]>> = {
  'repairs historical function defaults atomically and replays the complete upgrade': 'legacy',
  'replays the whole chain from empty without a superuser': 'fresh',
  'relabels free-form compartments on upgrade, bypassing triggers and restoring them': 'cutover',
  'preserves a current clone and repairs only the exact known old body with unchanged OID/properties/private ACL': 'successor',
}

function migrationOwnerGroup(name: string): typeof MIGRATION_OWNER_GROUPS[number] {
  return MIGRATION_OWNER_SCENARIOS[name] ?? 'prerequisites'
}

export function migrationOwnerTest(name: string, fn: TestFn): void {
  const selected = process.env.BRIAN_TEST_MIGRATION_OWNER_GROUP
  if (selected && !MIGRATION_OWNER_GROUPS.some(group => group === selected)) throw new Error('Unknown migration owner group')
  if (!selected || migrationOwnerGroup(name) === selected) it(name, fn)
}
