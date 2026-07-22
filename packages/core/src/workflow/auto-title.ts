/**
 * Workflow auto-titler.
 *
 * A scheduled job is a `scheduled_jobs` trigger row pointing at a one-step
 * `assistant_call` workflow (mig 159 cutover), so `workflows.name` is the
 * single display title for both surfaces. This helper produces that title
 * from the same Flash-Lite endpoint the chat-session auto-titler uses.
 *
 * Called synchronously from `createScheduledJob` right after
 * `buildOneStepReminderWorkflow` + `jobStore.create` succeed, gated by the
 * `workflows.name_manually_set` column (mig 202). The user-authored
 * `createWorkflow` path treats the model/user-supplied name as manual and
 * does not auto-title.
 *
 * Output rules mirror `packages/api/src/routes/chat.ts::sanitizeTitle`:
 *   - strip markdown, enclosing quotes, trailing punctuation
 *   - first line only (model sometimes emits title + explanation)
 *   - word-boundary trim to <= max chars
 *   - return `null` when the cleaned result is empty, so callers can keep
 *     the placeholder (`Scheduled reminder` / model-given name) intact
 *
 * [COMP:workflow/auto-title]
 */

import type { LLMProvider, TokenUsage } from '../providers/types.js'
import type { StructuredSchedule } from '../scheduling/schedule.js'

const AUTO_TITLE_MODEL = 'gemini-3.1-flash-lite'

/**
 * Clean up a raw LLM-generated workflow title. Identical to the session
 * auto-titler's `sanitizeTitle` — copied rather than imported so the core
 * package doesn't reach across into the api package.
 */
export function sanitizeWorkflowTitle(raw: string, max = 60): string {
  let t = raw.split(/\r?\n/)[0] ?? ''
  t = t
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/^["'"']+|["'"']+$/g, '')
    .replace(/[.?!,;:]+$/, '')
    .trim()
  if (t.length <= max) return t
  const slice = t.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  return (lastSpace > max / 2 ? slice.slice(0, lastSpace) : slice).trim()
}

/** Human-readable summary of a `StructuredSchedule` for the title prompt. */
function describeSchedule(schedule: StructuredSchedule, timezone?: string): string {
  const tz = timezone ? ` (${timezone})` : ''
  switch (schedule.type) {
    case 'once':
      return `Runs once at ${schedule.datetime}${tz}`
    case 'daily':
      return `Runs daily at ${schedule.time}${tz}`
    case 'weekly':
      return `Runs weekly on ${schedule.days.join(', ')} at ${schedule.time}${tz}`
    case 'monthly':
      return `Runs monthly on day ${schedule.dayOfMonth} at ${schedule.time}${tz}`
    case 'cron':
      return `Cron: ${schedule.expression}${tz}`
  }
}

export type GenerateWorkflowTitleParams = {
  /** Raw user instructions for a scheduled-job-shaped workflow. */
  instructions?: string
  /** Schedule context. Surfaced to the model so the title can reflect cadence. */
  schedule?: StructuredSchedule
  timezone?: string
  /** Optional descriptive seed for non-scheduled workflows. */
  description?: string
  /** Caller-supplied fallback (e.g. the placeholder "Scheduled reminder"). */
  fallbackName?: string
}

export type GenerateWorkflowTitleResult = {
  title: string | null
  usage: TokenUsage | null
  model: string | null
}

const SYSTEM_PROMPT =
  `You write a short label (2-6 words) for a saved scheduled task or workflow. The label appears in lists next to the user's other items, so it has to read like a human wrote it — close to how the user themselves would name the item.

Output ONLY the label text. No markdown, no quotes, no trailing punctuation.

Hard rules — violating any of these produces a bad label:
- Stay close to the user's own words. If they wrote "buy lunch downstairs", the label is "Buy Lunch Downstairs", not "Downstairs Lunch Purchase Order".
- Preserve proper nouns, names, places, and product names exactly as written, including non-Latin characters. NEVER translate or romanise (do not turn "大隻佬" into "Big Guy" or "Da Zhi Lao"; keep it as "大隻佬").
- If the instructions are in a non-English language, write the label in the SAME language. A Chinese reminder gets a Chinese label.
- Never invent context the user didn't provide. Do not add "Scheduled", "Automation", "Task", "System", "Daily" (unless the user explicitly named a cadence), or any word that wasn't implied by the instructions.
- Drop instructional prefixes like "Remind the user to", "Remind me to", "Please", "Make sure to" — those are scaffolding, not subject.
- Cadence words ("Daily", "Weekly", "Morning") are allowed ONLY when they meaningfully narrow the subject (e.g. "Daily Oil Price Brief"). Don't tack them on for flavour.
- If the instructions are too vague to name (under 4 words AND no clear subject), output the cleaned instructions verbatim with proper capitalisation rather than inventing a title. "ping me" → "Ping Me". "do the thing" → "Do The Thing".

Examples (instruction → label):
- "Buy lunch downstairs." → Buy Lunch Downstairs
- "Call yyy (大隻佬)" → Call yyy (大隻佬)
- "Remind the user to take their pill every morning at 8." → Morning Pill Reminder
- "Every Monday, scan investor newsletters and email me a brief." → Weekly Investor Newsletter Brief
- "Send a daily 9am market summary covering oil and gas to Slack." → Daily Oil & Gas Brief
- "每天晚上8点提醒我喝水" → 晚上喝水提醒
- "ping me" → Ping Me
- "do the thing" → Do The Thing
- "When a new GitHub issue is filed against backend, summarise to Slack." → Backend Issue Triage`

/**
 * Stream a short auto-title for a workflow. Returns `null` when the model
 * produces nothing usable so callers can keep their existing placeholder.
 *
 * @param provider — LLMProvider; the caller passes the same primary provider
 *   already wired into `apps/api/src/index.ts`. The fallback wrapper applies
 *   here too: if Flash-Lite 5xxs / 429s and ANTHROPIC fallback is enabled,
 *   the wrapper transparently downshifts.
 * @param signal — Optional abort signal. Caller-supplied timeout closes the
 *   stream when the title takes too long (the scheduling tool caps at 5s).
 */
export async function generateWorkflowTitle(
  provider: LLMProvider,
  params: GenerateWorkflowTitleParams,
  signal?: AbortSignal,
  /** Servable background-lane model; defaults to the historical literal. */
  modelOverride?: string,
): Promise<GenerateWorkflowTitleResult> {
  const model = modelOverride ?? AUTO_TITLE_MODEL
  const parts: string[] = []
  if (params.instructions && params.instructions.trim().length > 0) {
    parts.push(`Instructions: ${params.instructions.trim()}`)
  }
  if (params.schedule) {
    parts.push(describeSchedule(params.schedule, params.timezone))
  }
  if (params.description && params.description.trim().length > 0) {
    parts.push(`Description: ${params.description.trim()}`)
  }
  const excerpt = parts.join('\n').slice(0, 1200)
  if (!excerpt) return { title: null, usage: null, model: null }

  let raw = ''
  let usage: TokenUsage | null = null
  try {
    for await (const chunk of provider.stream({
      model: model,
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: excerpt }],
      maxTokens: 32,
      // Low but non-zero — deterministic enough to make the label stable across
      // re-runs of the same instructions, but not so low that the model
      // collapses onto a single rigid template across unrelated inputs.
      temperature: 0.1,
      signal,
    })) {
      if (chunk.type === 'text_delta') raw += chunk.text
      if (chunk.type === 'message_end') usage = chunk.usage
    }
  } catch (err) {
    // Network error / abort / model failure — let the caller keep its
    // placeholder. The job/workflow record is already persisted; missing
    // a title is purely cosmetic.
    console.warn('[workflow/auto-title] generation failed:', err)
    return { title: null, usage: null, model: model }
  }

  const cleaned = sanitizeWorkflowTitle(raw)
  if (cleaned.length === 0) {
    // Model produced nothing usable — let the caller keep its placeholder.
    return { title: null, usage, model: model }
  }
  return { title: cleaned, usage, model: model }
}
