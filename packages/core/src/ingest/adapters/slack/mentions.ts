/**
 * Slack mention resolution — rewrite `<@U…>` tokens into human names.
 *
 * Slack encodes a mention inline as `<@U0AQT24KHEV>` (or, when the client
 * had a label handy, `<@U0AQT24KHEV|dustin_gmat>`). That raw token flows
 * straight into Pipeline B's extraction LLM, which reads the bare id and
 * mints a `person` entity whose `display_name` IS the id. This pure
 * function rewrites each token to a resolved name BEFORE the text reaches
 * extraction, so the brain records people by name and keeps the Slack id
 * as metadata (see the caller — it stamps `external_ref`).
 *
 * Pure: no Slack API calls, no DB. The caller resolves the
 * `directory` (id → preferred name) via `users.info` and passes it in.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → Source adapters →
 * Slack → "Mention resolution".
 *
 * [COMP:brain/source-adapters/slack]
 */

/**
 * Slack mention token. Captures the user id (`U…`/`W…`) and the optional
 * `|label` Slack sometimes embeds (the client-side display form). Global so
 * `replace`/`matchAll` walk every mention in the message.
 */
const SLACK_MENTION_TOKEN = /<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g

export type ResolvedMention = {
  /** Slack user id (`U…` / `W…`). */
  id: string
  /** The name the token was rewritten to. */
  name: string
}

export type SlackMentionResolution = {
  /** Message text with every resolvable `<@U…>` token replaced by a name. */
  text: string
  /**
   * One entry per token that was rewritten to a name (deduped by id, first
   * win). Drives the caller's `external_ref` directory so the person entity
   * carries the Slack id as metadata. Tokens left unresolved are absent.
   */
  resolved: ResolvedMention[]
}

/**
 * Rewrite `<@U…>` mention tokens in `text` using `directory` (Slack user id
 * → preferred display name). Resolution order per token:
 *
 *   1. `directory.get(id)` — the authoritative name the caller resolved via
 *      `users.info` (real name → display name → handle).
 *   2. the token's embedded `|label`, when present.
 *   3. otherwise the token is **left unchanged** — we never fabricate a
 *      name. This is strictly no worse than the pre-resolution behavior and
 *      only happens when `users.info` failed AND no label was embedded.
 */
export function resolveSlackMentions(
  text: string,
  directory: ReadonlyMap<string, string>,
): SlackMentionResolution {
  const resolved: ResolvedMention[] = []
  const seen = new Set<string>()

  const rewritten = text.replace(SLACK_MENTION_TOKEN, (whole, id: string, label?: string) => {
    const fromDir = directory.get(id)
    const name = (fromDir && fromDir.trim()) || (label && label.trim()) || null
    if (!name) return whole // unresolvable — leave the raw token in place
    if (!seen.has(id)) {
      seen.add(id)
      resolved.push({ id, name })
    }
    return name
  })

  return { text: rewritten, resolved }
}

/**
 * Pull the unique Slack user ids out of every `<@U…>` mention token in
 * `text`. The caller feeds these to the name resolver before rewriting.
 * Order-preserving, deduped.
 */
export function extractMentionIds(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(SLACK_MENTION_TOKEN)) {
    const id = m[1]
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}
