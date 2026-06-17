#!/usr/bin/env tsx
/**
 * One-shot classifier backfill.
 *
 * Three operations covered, each runnable independently via subcommand:
 *
 *   github-as-project   — reclassify `kind='project'` entities whose
 *                         canonical_id matches a GitHub repo URL pattern
 *                         to `kind='repository'`.
 *
 *   bare-domain-as-project — promote `kind='project'` entities whose
 *                         canonical_id is a bare domain to `kind='company'`
 *                         via promoteEntityToCrm (creates the companies
 *                         specialization row atomically).
 *
 *   cross-kind-collisions — find entities sharing
 *                         (workspace_id, canonical_id) across kinds and
 *                         report them for manual review (auto-merge is
 *                         destructive enough that we don't apply it).
 *
 * Usage:
 *   pnpm tsx packages/core/scripts/classifier-backfill.ts <subcommand> [--workspace <id>] [--apply]
 *
 * Without `--apply` the script does a dry-run: reports what would change
 * without writing.
 *
 * Spec: docs/architecture/brain/classification/entity-kind.md
 *   §Migration / backfill (one-time, on framework rollout)
 */

import { Pool } from 'pg'

import {
  GITHUB_REPO_RE,
} from '../src/classification/rules/entity-kind/shared.js'

type Args = {
  subcommand: 'github-as-project' | 'bare-domain-as-project' | 'cross-kind-collisions'
  workspaceId: string | null
  apply: boolean
}

function parseArgs(argv: string[]): Args {
  const [subcommand, ...rest] = argv
  const args: Args = {
    subcommand: (subcommand ?? '') as Args['subcommand'],
    workspaceId: null,
    apply: false,
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--workspace') {
      args.workspaceId = rest[++i] ?? null
    } else if (a === '--apply') {
      args.apply = true
    }
  }
  if (!['github-as-project', 'bare-domain-as-project', 'cross-kind-collisions'].includes(args.subcommand)) {
    console.error(
      'Usage: pnpm tsx packages/core/scripts/classifier-backfill.ts <subcommand> [--workspace <id>] [--apply]\n' +
        '  subcommands: github-as-project | bare-domain-as-project | cross-kind-collisions',
    )
    process.exit(1)
  }
  return args
}

const BARE_DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  console.log(
    `[classifier-backfill] ${args.subcommand}${args.workspaceId ? ` (workspace=${args.workspaceId})` : ''} ${args.apply ? '[APPLY]' : '[dry-run]'}`,
  )

  try {
    if (args.subcommand === 'github-as-project') {
      await runGithubAsProject(pool, args)
    } else if (args.subcommand === 'bare-domain-as-project') {
      await runBareDomainAsProject(pool, args)
    } else if (args.subcommand === 'cross-kind-collisions') {
      await runCrossKindCollisions(pool, args)
    }
  } finally {
    await pool.end()
  }
}

async function runGithubAsProject(pool: Pool, args: Args): Promise<void> {
  const wsClause = args.workspaceId ? `AND workspace_id = $1` : ''
  const params = args.workspaceId ? [args.workspaceId] : []
  const { rows } = await pool.query<{ id: string; workspace_id: string; canonical_id: string; display_name: string }>(
    `SELECT id, workspace_id, canonical_id, display_name
     FROM entities
     WHERE valid_to IS NULL AND retracted_at IS NULL
       AND kind = 'project'
       AND canonical_id IS NOT NULL
       ${wsClause}`,
    params,
  )
  const matches = rows.filter((r) => GITHUB_REPO_RE.test(r.canonical_id))
  console.log(`[classifier-backfill] github-as-project: ${matches.length} candidates`)
  for (const m of matches) {
    console.log(`  ${m.workspace_id}/${m.id} "${m.display_name}" -> repository`)
    if (args.apply) {
      await pool.query(
        `UPDATE entities SET kind = 'repository', updated_at = now() WHERE id = $1`,
        [m.id],
      )
    }
  }
  console.log(`[classifier-backfill] github-as-project: ${args.apply ? 'applied' : 'dry-run'} ${matches.length} updates`)
}

async function runBareDomainAsProject(pool: Pool, args: Args): Promise<void> {
  const wsClause = args.workspaceId ? `AND e.workspace_id = $1` : ''
  const params = args.workspaceId ? [args.workspaceId] : []
  // Join workspaces to get owner_user_id — promoteEntityToCrm runs under
  // queryWithRLS and needs an actor.
  const { rows } = await pool.query<{
    id: string
    workspace_id: string
    canonical_id: string
    display_name: string
    owner_user_id: string
  }>(
    `SELECT e.id, e.workspace_id, e.canonical_id, e.display_name, w.owner_user_id
     FROM entities e
     JOIN workspaces w ON w.id = e.workspace_id
     WHERE e.valid_to IS NULL AND e.retracted_at IS NULL
       AND e.kind = 'project'
       AND e.canonical_id IS NOT NULL
       AND e.canonical_id !~ '^https?://'
       AND e.canonical_id !~ '@'
       ${wsClause}`,
    params,
  )
  const matches = rows.filter((r) => BARE_DOMAIN_RE.test(r.canonical_id))
  console.log(`[classifier-backfill] bare-domain-as-project: ${matches.length} candidates`)
  for (const m of matches) {
    console.log(`  ${m.workspace_id}/${m.id} "${m.display_name}" (${m.canonical_id}) -> promote to company`)
  }
  if (!args.apply) {
    console.log(`[classifier-backfill] bare-domain-as-project: dry-run; pass --apply to promote`)
    return
  }

  // Apply path — uses the same atomic specialization-row-creation
  // pattern as `promoteEntityToCrm` (entities-store.ts:1564) directly
  // in SQL so the script stays self-contained.
  let promoted = 0
  let failed = 0
  for (const m of matches) {
    const client = await pool.connect()
    try {
      // Connects as the owner (DATABASE_URL), which bypasses RLS — no GUC needed.
      await client.query('BEGIN')
      // Idempotency: skip if there's already a companies row.
      const existing = await client.query(
        `SELECT id FROM companies WHERE entity_id = $1 LIMIT 1`,
        [m.id],
      )
      if (existing.rows.length > 0) {
        await client.query('COMMIT')
        console.log(`  -- ${m.id}: already has companies row (id=${existing.rows[0].id}), kind flip only`)
        await client.query(
          `UPDATE entities SET kind = 'company', updated_at = now() WHERE id = $1 AND valid_to IS NULL`,
          [m.id],
        )
        promoted++
        continue
      }
      await client.query(
        `UPDATE entities SET kind = 'company', updated_at = now() WHERE id = $1 AND valid_to IS NULL`,
        [m.id],
      )
      await client.query(
        `INSERT INTO companies (entity_id, workspace_id, name, domain, tags, created_by_user_id)
         VALUES ($1, $2, $3, $4, '{}'::text[], $5)`,
        [m.id, m.workspace_id, m.display_name, m.canonical_id, m.owner_user_id],
      )
      await client.query('COMMIT')
      promoted++
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      console.warn(`  ! ${m.id}: ${err instanceof Error ? err.message : String(err)}`)
      failed++
    } finally {
      client.release()
    }
  }
  console.log(`[classifier-backfill] bare-domain-as-project: promoted=${promoted} failed=${failed}`)
}

async function runCrossKindCollisions(pool: Pool, args: Args): Promise<void> {
  const wsClause = args.workspaceId ? `WHERE workspace_id = $1` : ''
  const params = args.workspaceId ? [args.workspaceId] : []
  const { rows } = await pool.query<{
    workspace_id: string
    canonical_id: string
    kinds: string[]
    count: string
  }>(
    `SELECT workspace_id, canonical_id, array_agg(DISTINCT kind) AS kinds, count(*) AS count
     FROM entities
     ${wsClause}
     ${wsClause ? 'AND' : 'WHERE'} valid_to IS NULL AND retracted_at IS NULL AND canonical_id IS NOT NULL
     GROUP BY workspace_id, canonical_id
     HAVING count(DISTINCT kind) > 1
     ORDER BY count(*) DESC
     LIMIT 200`,
    params,
  )
  console.log(`[classifier-backfill] cross-kind-collisions: ${rows.length} collision groups`)
  for (const r of rows) {
    console.log(`  ${r.workspace_id} "${r.canonical_id}" kinds=[${r.kinds.join(',')}] count=${r.count}`)
  }
  console.log(
    `[classifier-backfill] cross-kind-collisions: read-only report. ` +
      `Resolve manually via mergeEntities or the pending-classifications inbox.`,
  )
}

main().catch((err) => {
  console.error('[classifier-backfill] failed:', err)
  process.exit(1)
})
