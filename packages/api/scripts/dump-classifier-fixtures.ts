/**
 * One-shot script: dumps recent Episodes from a workspace into the
 * classifier-golden-set fixture skeleton for hand-labelling.
 *
 * Usage:
 *   pnpm --filter @use-brian/api exec tsx scripts/dump-classifier-fixtures.ts \
 *     --workspace=<workspace-id> --limit=20
 *
 * Output is written to stdout — paste into
 * `packages/core/src/ingest/__tests__/fixtures/classifier-golden-set.json`
 * and fill in the `expected` block for each entry. Once the file is
 * populated, the golden-set Vitest suite runs against a real Gemini
 * provider (requires GEMINI_API_KEY) and asserts precision/recall on
 * each fixture.
 *
 * The dump pulls Episode `content_ref.text` when present (chat-side
 * paths) and falls back to the Episode title or summary for adapters
 * whose contentRef points at an external resource.
 */

import { query } from '../src/db/client.ts'

type EpisodeDump = {
  id: string
  sourceKind: string
  occurredAt: Date
  summaryText: string | null
  contentRef: unknown
}

function parseArgs(argv: string[]): { workspace: string; limit: number } {
  let workspace = ''
  let limit = 20
  for (const arg of argv) {
    if (arg.startsWith('--workspace=')) workspace = arg.slice('--workspace='.length)
    else if (arg.startsWith('--limit=')) limit = Math.max(1, Math.min(100, Number(arg.slice('--limit='.length)) || 20))
  }
  if (!workspace) {
    console.error('Usage: tsx scripts/dump-classifier-fixtures.ts --workspace=<id> [--limit=20]')
    process.exit(1)
  }
  return { workspace, limit }
}

async function main() {
  const { workspace, limit } = parseArgs(process.argv.slice(2))

  // System-bypass read — fixture dumps are operator-side dev tooling,
  // not subject to the per-user RLS predicate.
  const result = await query<EpisodeDump>(
    `SELECT id, source_kind AS "sourceKind", occurred_at AS "occurredAt",
            summary_text AS "summaryText", content_ref AS "contentRef"
       FROM episodes
      WHERE workspace_id = $1
      ORDER BY occurred_at DESC
      LIMIT $2`,
    [workspace, limit],
  )

  const fixtures = result.rows.map((row, i) => {
    const content = extractContent(row)
    return {
      name: `${row.sourceKind} #${i + 1} — ${row.occurredAt.toISOString().slice(0, 10)}`,
      content,
      expected: {
        entity_kinds: [] as string[],
        entity_names_substr: [] as string[],
        task_text_substr: [] as string[],
        memory_count_max: 0,
        ephemeral_count_min: 0,
      },
    }
  })

  console.log(JSON.stringify(fixtures, null, 2))
  process.exit(0)
}

function extractContent(row: EpisodeDump): string {
  // contentRef shape varies by source. Prefer inline text where present;
  // fall back to summary_text.
  const ref = row.contentRef as Record<string, unknown> | null
  if (ref && typeof ref === 'object') {
    const candidates = ['text', 'body', 'content', 'transcript']
    for (const key of candidates) {
      const v = ref[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return row.summaryText ?? ''
}

main().catch((err) => {
  console.error('dump-classifier-fixtures failed:', err)
  process.exit(1)
})
