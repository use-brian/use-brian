/** Shared source normalization for playbook and ordinary-memory evidence. */
export function countDecisionEvidence(rows: readonly {
  eventKey: string; sourceKey: string; aliases?: readonly string[]; eventIsSource?: boolean
}[]): { eventCount: number; distinctSources: number } {
  const parent = new Map<string,string>()
  const find = (key: string): string => {
    const next = parent.get(key)
    if (!next || next === key) return key
    const root = find(next); parent.set(key,root); return root
  }
  for (const row of rows) for (const alias of row.aliases ?? []) {
    const left = find(row.sourceKey), right = find(alias)
    if (left !== right) parent.set(left < right ? right : left,left < right ? left : right)
  }
  return { eventCount: new Set(rows.map(row=>row.eventIsSource ? find(row.sourceKey) : row.eventKey)).size,
    distinctSources: new Set(rows.map(row=>find(row.sourceKey))).size }
}
