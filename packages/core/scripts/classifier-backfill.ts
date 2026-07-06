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
 *   bare-domain-as-project — OBSOLETE post CRM→entity unification. Once
 *                         promoted `kind='project'` entities with a bare-
 *                         domain canonical_id to `kind='company'` by
 *                         inserting a `companies` specialization row. That
 *                         table is gone (companies folded into `entities`,
 *                         domain in `attributes`), so this subcommand is
 *                         now a no-op; retained only so the CLI still
 *                         accepts the argument.
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

async function runBareDomainAsProject(_pool: Pool, _args: Args): Promise<void> {
  // Obsolete post CRM→entity unification. This subcommand promoted
  // bare-domain `project` entities to `company` by inserting a row into
  // the `companies` specialization table. That table no longer exists —
  // companies are folded into `entities` (kind='company', domain in
  // `attributes`). Reclassification is now handled by the entity-kind
  // classifier and the dedupe/merge tooling, so this path is a no-op.
  console.log(
    '[classifier-backfill] bare-domain-as-project: obsolete post CRM→entity unification (companies folded into entities); no rows written.',
  )
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
