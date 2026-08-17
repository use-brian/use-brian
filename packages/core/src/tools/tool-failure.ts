/**
 * First-party failure copy — the shared frame every non-connector tool
 * returns from a `catch`, and the one "not found" shape every id-miss copies.
 *
 * Five raw wrappers used to sit over the brain primitives (`Healing tool
 * error: ${err.message}`, `Retrieval error: …`, `Correction error: …`,
 * `Doc tool error: …`, `Chat archive error: …`) and every miss said `X not
 * found` and nothing else. The standard
 * (docs/architecture/engine/tool-executor.md → "Failure copy") is that a
 * failure names WHAT ran on WHICH target, WHY it failed, the NEXT STEP, and a
 * RETRY VERDICT — and that a miss ships the discovery pointer
 * (`taskNotFoundMessage` / `crmNotFound` / `pageNotFound` are the reference
 * shape; `notFoundFailure` below is the same shape parameterised).
 *
 * Component tag: [COMP:tools/tool-failure].
 */

import { formatToolError } from '../engine/tool-executor.js'

export type ToolFailureContext = {
  /** The tool that was running. */
  tool: string
  /** The id / path / query the call was about, e.g. `entity \`e1\``, `query "acme"`. */
  target?: string
  /**
   * What the tool was doing, for the "what" clause when `target` alone reads
   * oddly (`link entities`, `save the correction`). Defaults to the tool name.
   */
  action?: string
  /**
   * The tool writes: on a non-transient failure the copy says outright that
   * nothing was saved / changed, so the model never reports a write that did
   * not happen. On a transient one it says the write may have applied.
   */
  mutating?: boolean
  /** Extra next-step sentence appended before the verdict (a discovery tool, "ask the user"). */
  next?: string
}

/** Database / infrastructure blips a retry can plausibly clear. */
const TRANSIENT = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|timed out|Connection terminated|connection (was )?closed|too many clients|remaining connection slots|deadlock detected|could not serialize|serialization failure|statement timeout|canceling statement|pool is draining|Client has encountered a connection error|fetch failed|socket hang up/i

/** Non-transient rejections the caller's own arguments caused. */
const INPUT_SHAPED = /invalid input syntax|violates (not-null|check|foreign key|unique) constraint|duplicate key|value too long|out of range|malformed|invalid uuid|is not a valid|must be|required|cannot be empty|not allowed|forbidden|denied|clearance|permission/i

export function isTransientToolError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string' && /^(ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|57014|40P01|40001|53300|08\d{3})/.test(code)) return true
  return TRANSIENT.test(message)
}

function hasZodIssues(err: unknown): boolean {
  return !!err && typeof err === 'object' && Array.isArray((err as { issues?: unknown }).issues)
}

/**
 * Render a caught error as failure copy. Zod issues become the executor's
 * compact `path: message` lines + "fix the named field"; a transient
 * infrastructure blip says so and allows one retry; anything else is framed
 * with the tool + target and a no-retry-unchanged verdict.
 */
export function describeToolFailure(err: unknown, ctx: ToolFailureContext): string {
  const what = ctx.action ?? `\`${ctx.tool}\``
  const doing = ctx.target ? `${what} on ${ctx.target}` : what
  const next = ctx.next ? ` ${ctx.next}` : ''

  if (hasZodIssues(err)) {
    return `${doing} did not run: the input failed validation. ${formatToolError(err)}${ctx.mutating ? ' Nothing was saved.' : ''}${next} Fix the named field(s) and retry — the same input will fail the same way.`
  }
  const message = err instanceof Error ? err.message : String(err)
  const flat = message.replace(/\s+/g, ' ').trim()
  const said = flat ? `: ${flat.length > 400 ? `${flat.slice(0, 399)}…` : flat}` : ''
  if (isTransientToolError(err)) {
    return `${doing} failed with a transient infrastructure error${said}. Nothing about the arguments is wrong.${ctx.mutating ? ' The write may or may not have been applied — read it back before repeating it.' : ''}${next} Retry once after a short wait; if it persists, tell the user rather than looping.`
  }
  const inputShaped = INPUT_SHAPED.test(flat)
  return `${doing} failed${said}.${ctx.mutating ? ' Nothing was saved or changed.' : ''}${next} ${inputShaped ? 'Fix what that message names' : 'Retrying the same arguments will not help — fix what the message names'}, or ask the user; do not retry unchanged.`
}

/** `{ data, isError: true }` frame around `describeToolFailure` — what a first-party tool's `catch` returns. */
export function toolFailure(err: unknown, ctx: ToolFailureContext): { data: string; isError: true } {
  return { data: describeToolFailure(err, ctx), isError: true }
}

export type NotFoundContext = {
  /** What kind of thing: `Entity`, `Memory`, `Goal`, `Worker`, `Scheduled job`, `Comment`, `File`. */
  kind: string
  /** The id (or name) that missed. */
  id: string
  /** The tool(s) that discover a valid id — `listGoals`, `searchBrain / getEntity`. */
  discoveryTool?: string
  /**
   * Every update mints a new id (tasks / CRM rows / brain entries): say so, so
   * the model reuses the id from its last write result instead of the stale one.
   */
  supersession?: boolean
  /** Extra clause between the diagnosis and the verdict (why else it can miss). */
  extra?: string
  /** Where the id must come from when it cannot be a name (`a listGoals result, never a title`). */
  idSource?: string
}

/**
 * The reference "not found" shape (`taskNotFoundMessage` /
 * `crmNotFound` / `pageNotFound`), parameterised: name the id, explain
 * supersession where it applies, name the discovery tool, forbid the blind
 * retry.
 */
export function notFoundMessage(ctx: NotFoundContext): string {
  const supersession = ctx.supersession
    ? ` If you edited this ${ctx.kind.toLowerCase()} earlier, that edit returned a NEW id (every update supersedes the row) — reuse the id from that result.`
    : ''
  const extra = ctx.extra ? ` ${ctx.extra}` : ''
  const source = ctx.idSource ? ` Ids come from ${ctx.idSource}.` : ''
  const discover = ctx.discoveryTool
    ? ` Call ${ctx.discoveryTool} to re-resolve a current id.`
    : ' Ask the user to confirm the id.'
  return `${ctx.kind} ${ctx.id} not found in this workspace.${supersession}${extra}${source}${discover} Do NOT retry this exact id.`
}

/** `{ data, isError: true }` frame around `notFoundMessage`. */
export function notFoundFailure(ctx: NotFoundContext): { data: string; isError: true } {
  return { data: notFoundMessage(ctx), isError: true }
}
