/**
 * Slack adapter — default rule templates.
 *
 * Pre-seeded into `ingest_rules` (migration 130) on `connector_instance`
 * creation for a Slack provider. The user customizes per-instance via
 * the agent (ingest.md §Agent-mediated rule management).
 *
 * Order matters: first-match-wins evaluation. The `:workspace_members`
 * / `:crm_contacts` placeholders are resolved at evaluation time by the
 * engine (ingest.md:454), not at rule-creation time.
 *
 * Default posture: team @-mentions, DMs, and threads with a known
 * contact route realtime; everything else collects into a weekday
 * digest (the `always` rule, per the ingest.md:709 worked example).
 *
 * [COMP:brain/source-adapters/slack]
 */

export type SlackDefaultRule = {
  filter_type: string
  filter_params: Record<string, unknown>
  routing_mode: 'realtime' | 'scheduled' | 'drop'
  routing_schedule?: string
  alert?: boolean
}

export const slackDefaultRules: readonly SlackDefaultRule[] = [
  {
    filter_type: 'is_mention',
    filter_params: { values: [':workspace_members'] },
    routing_mode: 'realtime',
  },
  {
    filter_type: 'is_dm',
    filter_params: {},
    routing_mode: 'realtime',
  },
  {
    filter_type: 'user_match',
    filter_params: { values: [':crm_contacts'] },
    routing_mode: 'realtime',
  },
  {
    filter_type: 'always',
    filter_params: {},
    routing_mode: 'scheduled',
    routing_schedule: '0 9 * * 1-5',
  },
] as const
