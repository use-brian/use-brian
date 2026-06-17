/**
 * Phase D — cancel every active promo-granted Stripe subscription.
 *
 * Sequence:
 *   1. SELECT stripe_subscription_id FROM promo_code_redemptions (the
 *      authoritative list — we don't trust Stripe metadata for discovery).
 *   2. For each: retrieve from Stripe. If already in a terminal status,
 *      skip. Otherwise cancel.
 *   3. Each cancellation triggers `customer.subscription.deleted` →
 *      `routes/stripe-webhook.ts` downgrades the workspace to `free` and
 *      nulls `workspaces.stripe_subscription_id`. We rely on that — this
 *      script does NOT write to either table.
 *
 * Run against production via Cloud SQL Proxy + GCP Stripe secret. See
 * the runbook in `docs/plans/workspace-billing-migration.md`.
 *
 * Usage (default is dry-run):
 *   tsx scripts/cancel-promo-subscriptions.ts             # list what would be cancelled
 *   tsx scripts/cancel-promo-subscriptions.ts --execute   # actually cancel
 */

import { getStripe } from '../src/billing/stripe-client.js'
import { query } from '../src/db/client.js'

// Stripe subscription statuses that mean "no further billing happens"
// and the sub is effectively dead — re-cancelling is a no-op.
const TERMINAL = new Set(['canceled', 'incomplete_expired'])

async function main(): Promise<void> {
  const execute = process.argv.includes('--execute')
  const mode = execute ? 'EXECUTE' : 'DRY-RUN'
  console.log(`Promo cancellation — ${mode}\n`)

  const { rows } = await query<{
    id: string; userId: string; codeId: string; subId: string
  }>(
    `SELECT id, user_id as "userId", promo_code_id as "codeId",
            stripe_subscription_id as "subId"
     FROM promo_code_redemptions
     WHERE stripe_subscription_id IS NOT NULL
     ORDER BY redeemed_at`,
  )

  console.log(`Found ${rows.length} promo redemption(s) with a Stripe subscription`)
  if (rows.length === 0) return

  const stripe = getStripe()
  let cancelled = 0
  let skipped = 0
  let missing = 0
  let planned = 0

  for (const r of rows) {
    try {
      const sub = await stripe.subscriptions.retrieve(r.subId)
      if (TERMINAL.has(sub.status)) {
        console.log(`  [skip]   sub=${r.subId} status=${sub.status}`)
        skipped++
        continue
      }
      console.log(
        `  [cancel] sub=${r.subId} status=${sub.status} user=${r.userId} promo=${r.codeId}`,
      )
      if (execute) {
        await stripe.subscriptions.cancel(r.subId)
        cancelled++
      } else {
        planned++
      }
    } catch (err) {
      console.log(
        `  [miss]   sub=${r.subId} — ${(err as Error).message}`,
      )
      missing++
    }
  }

  console.log(`\nSummary (${mode}):`)
  if (execute) {
    console.log(`  Cancelled:                   ${cancelled}`)
  } else {
    console.log(`  Would cancel:                ${planned}`)
  }
  console.log(`  Skipped (already terminated): ${skipped}`)
  console.log(`  Missing in Stripe:            ${missing}`)
  if (!execute) console.log(`\nRe-run with --execute to actually cancel.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
