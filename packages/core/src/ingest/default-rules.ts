// [COMP:brain/default-rules]
// Spec: docs/plans/company-brain/ingest.md §Default rule templates per source
// DB:   packages/api/migrations/130_ingest_rules.sql
//
// Pure data. Seeded into `ingest_rules` per `connector_instance` at setup time;
// `connector_instance_id`, `source`, `rule_order`, and `routing_timezone` are
// assigned by the seeder. Placeholders (`:crm_contacts`, `:workspace_members`,
// `:priority_channels`, `:assistant`) are resolved at evaluation time, not here.

export type IngestRoutingMode = 'realtime' | 'scheduled' | 'drop'

export type DefaultRuleTemplate = {
  readonly filter_type: string
  readonly filter_params: Readonly<Record<string, unknown>>
  readonly routing_mode: IngestRoutingMode
  readonly routing_schedule?: string
  readonly alert?: boolean
}

// Single source of truth for ingest-adapter identifiers. The literal type is
// derived from the runtime tuple so admin surfaces (which need a real registry
// they can enumerate) and engine code (which switches on the union) stay in
// lockstep. Never hardcode this list elsewhere — derive from the constant.
// Providers with ingest adapters (Pipeline B). Genuinely a subset of
// OFFICIAL_CONNECTORS — notion / gdrive / files / gmail have no ingest engine
// support and must not appear here. (Gmail stays a send/read connector but is
// not an ingestion source — its poll producer + adapter were removed.) Do not
// derive from OFFICIAL_CONNECTORS.
export const INGEST_SOURCE_PROVIDERS = ['slack', 'github', 'calendar', 'fathom'] as const // drift-sweep: intentionally-narrow:ingest-engine-only
export type IngestSourceProvider = typeof INGEST_SOURCE_PROVIDERS[number]

export const DEFAULT_INGEST_RULES: Readonly<
  Record<IngestSourceProvider, readonly DefaultRuleTemplate[]>
> = {
  // The realtime rules here are best-effort — slack normalize doesn't yet
  // emit pre-extracted `mentions` / `user_flags`, and the placeholder
  // resolver returns emails, not Slack user ids. Until Slack-flavored
  // placeholder resolution lands, the realtime rules are usually no-ops
  // and the `always → scheduled '0 9 * * 1-5'` catchall does the work:
  // every channel message lands in a daily digest Episode and Pipeline B's
  // LLM extraction decides what's signal vs noise. This matches the "let
  // the LLM filter noise" intent in ingest-pipeline.md → "Source adapters"
  // → Slack. The realtime entries are kept so agent-mediated edits can
  // upgrade them once the Slack id ↔ workspace member mapping ships.
  slack: [
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
  ],
  github: [
    {
      filter_type: 'event_type',
      filter_params: { values: ['pull_request.merged', 'security_alert', 'release'] },
      routing_mode: 'realtime',
      alert: true,
    },
    {
      filter_type: 'event_type',
      filter_params: { values: ['pull_request.opened', 'issue.opened'] },
      routing_mode: 'realtime',
    },
    {
      filter_type: 'branch_match',
      filter_params: { values: ['main'] },
      routing_mode: 'realtime',
    },
    {
      filter_type: 'actor_match',
      filter_params: { values: ['dependabot[bot]', 'renovate[bot]'] },
      routing_mode: 'drop',
    },
    {
      filter_type: 'always',
      filter_params: {},
      routing_mode: 'scheduled',
      routing_schedule: '0 18 * * 1-5',
    },
  ],
  calendar: [
    {
      filter_type: 'attendee_match',
      filter_params: { values: [':workspace_members'] },
      routing_mode: 'realtime',
    },
    {
      filter_type: 'attendee_match',
      filter_params: { values: [':crm_contacts'] },
      routing_mode: 'realtime',
    },
    {
      filter_type: 'is_recurring',
      filter_params: {},
      routing_mode: 'drop',
    },
    {
      filter_type: 'always',
      filter_params: {},
      routing_mode: 'scheduled',
      routing_schedule: '0 8 * * *',
    },
  ],
  fathom: [
    {
      filter_type: 'always',
      filter_params: {},
      routing_mode: 'realtime',
    },
  ],
}

export function getDefaultRules(
  source: IngestSourceProvider,
): readonly DefaultRuleTemplate[] {
  return DEFAULT_INGEST_RULES[source]
}
