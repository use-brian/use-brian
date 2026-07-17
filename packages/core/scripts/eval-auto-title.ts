/**
 * Eval harness for the workflow auto-titler.
 *
 * Runs `generateWorkflowTitle` against a fixed corpus of representative
 * scheduled-job + workflow inputs using the real Flash-Lite endpoint, prints
 * each (input, title) pair so a human can eyeball whether the output is
 * actually interpretable.
 *
 * Why this exists: unit tests with mocked stream chunks only verify
 * sanitization and the streaming wire-up; they say nothing about whether the
 * prompt actually produces good titles. We hit a real model here and inspect
 * the output by hand.
 *
 * Run: GEMINI_API_KEY=... pnpm --filter @use-brian/core tsx scripts/eval-auto-title.ts
 */

import { createGeminiProvider } from '../src/providers/gemini.js'
import { generateWorkflowTitle } from '../src/workflow/auto-title.js'
import type { StructuredSchedule } from '../src/scheduling/schedule.js'

type Case = {
  label: string
  instructions: string
  schedule?: StructuredSchedule
  timezone?: string
}

// Sampled from the real `scheduled_jobs` table + edge cases the auto-titler
// has to survive. Every case below is an input the user might actually create.
const CASES: Case[] = [
  // Real production samples (anonymised) — short imperatives.
  { label: 'imperative-short',     instructions: 'Buy lunch downstairs.', schedule: { type: 'once', datetime: '2026-05-29T12:30:00' }, timezone: 'Asia/Hong_Kong' },
  { label: 'cjk-callout',          instructions: 'Call yyy (大隻佬)', schedule: { type: 'once', datetime: '2026-05-29T18:00:00' }, timezone: 'Asia/Hong_Kong' },
  { label: 'cjk-only',             instructions: '每天晚上8点提醒我喝水', schedule: { type: 'daily', time: '20:00' }, timezone: 'Asia/Hong_Kong' },

  // Anti-pattern guards — "Remind the user to ..." prefix the model fires reflexively.
  { label: 'remind-prefix',        instructions: 'Remind the user to take their pill every morning at 8.', schedule: { type: 'daily', time: '08:00' }, timezone: 'Asia/Hong_Kong' },
  { label: 'remind-prefix-call',   instructions: 'Remind the user to call yyy (大隻佬).', schedule: { type: 'once', datetime: '2026-05-29T15:00:00' }, timezone: 'Asia/Hong_Kong' },
  { label: 'remind-meeting',       instructions: 'Remind the user: "You have the meeting at Wilson CPA to sign the report in one hour (at 10:00 AM)."', schedule: { type: 'once', datetime: '2026-05-30T09:00:00' }, timezone: 'Asia/Hong_Kong' },

  // Long instructions with embedded structured data — has to compress.
  { label: 'long-flight-options',  instructions: 'HKG to NRT flight options (Early: UO622 01:15, CX524 01:20, HX606 02:00. Day: CX, JL, NH from 09:00). Prices from ~HKD 900. User wants to fly Friday.', schedule: { type: 'once', datetime: '2026-06-01T18:00:00' }, timezone: 'Asia/Hong_Kong' },
  { label: 'multi-line-dump',      instructions: 'Remind the user about HKG to NRT flight options:\n- Early: UO622 01:15, CX524 01:20, HX606 02:00\n- Day: CX, JL, NH from 09:00 onwards\n- Prices from ~HKD 900', schedule: { type: 'daily', time: '09:00' } },

  // Domain-specific recurring digest.
  { label: 'oil-price-check',      instructions: 'Remind the user to check oil prices again. Last prices: WTI ~$97.21, Brent ~$97.39.', schedule: { type: 'daily', time: '09:00' }, timezone: 'Asia/Hong_Kong' },
  { label: 'investor-newsletter',  instructions: 'Every Monday, scan investor newsletters and email me a brief covering AI startups and macro headlines.', schedule: { type: 'weekly', days: ['monday'], time: '08:00' }, timezone: 'America/New_York' },
  { label: 'gas-digest',           instructions: 'Send a daily 9am market summary covering oil and gas to Slack #morning-brief. Use Bloomberg + Reuters as primary sources.', schedule: { type: 'daily', time: '09:00' } },

  // Tool-shaped instructions (a workflow step is doing the action).
  { label: 'github-pr-summary',    instructions: 'Check GitHub for new PRs across all repos and post a one-line summary of each to #eng-status.', schedule: { type: 'daily', time: '09:30' } },
  { label: 'invoices-due',         instructions: 'Send invoices to clients with payments due this week.', schedule: { type: 'weekly', days: ['monday'], time: '10:00' } },

  // Edge cases — terse / vague / nonsense.
  { label: 'cryptic',              instructions: 'ping me', schedule: { type: 'once', datetime: '2026-05-29T15:00:00' } },
  { label: 'vague',                instructions: 'do the thing', schedule: { type: 'once', datetime: '2026-05-29T16:00:00' } },
  { label: 'single-word',          instructions: 'hi gmgm', schedule: { type: 'once', datetime: '2026-05-29T17:00:00' } },

  // Free-text workflow (no schedule context).
  { label: 'no-schedule-workflow', instructions: 'When a new GitHub issue is filed against the backend repo, summarise it and post to Slack #triage.' },
]

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('GEMINI_API_KEY env var is required.')
    process.exit(1)
  }
  const provider = createGeminiProvider(apiKey)

  console.log('Eval harness — workflow auto-titler. Real Flash-Lite endpoint.\n')
  console.log('label'.padEnd(28) + 'title')
  console.log('-'.repeat(28) + '-'.repeat(60))

  const summary: { label: string; instructions: string; title: string | null; wordCount: number }[] = []

  for (const c of CASES) {
    const t0 = Date.now()
    const result = await generateWorkflowTitle(provider, {
      instructions: c.instructions,
      schedule: c.schedule,
      timezone: c.timezone,
    })
    const ms = Date.now() - t0
    const title = result.title ?? '(null — placeholder kept)'
    const words = result.title ? result.title.split(/\s+/).filter((w) => w.length > 0).length : 0
    console.log(`${c.label.padEnd(28)}${title}   ${ms}ms${words ? `, ${words} words` : ''}`)
    summary.push({ label: c.label, instructions: c.instructions, title: result.title, wordCount: words })
  }

  console.log('\nDetail:')
  for (const s of summary) {
    console.log(`\n  [${s.label}]`)
    console.log(`    instructions: ${s.instructions.replace(/\n/g, '\\n').slice(0, 100)}${s.instructions.length > 100 ? '…' : ''}`)
    console.log(`    title:        ${s.title ?? '(null)'}`)
  }
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exit(1)
})
