/**
 * Calendar adapter — default rule templates.
 *
 * Pre-seeded into `ingest_rules` (migration 130) on `connector_instance`
 * creation for a Calendar provider. The user customizes per-instance via
 * the agent (per ingest.md §Agent-mediated rule management).
 *
 * Order matters: first-match-wins evaluation. The `:workspace_members`
 * / `:crm_contacts` placeholders are resolved at evaluation time by the
 * engine (ingest.md:454), not at rule-creation time.
 *
 * Spec (ingest.md:758–764):
 *
 *     1. attendee_match  { :workspace_members }   → realtime
 *     2. attendee_match  { :crm_contacts }        → realtime
 *     3. is_recurring                             → drop
 *     4. always                                    → scheduled '0 8 * * *'
 *
 * [COMP:brain/source-adapters/calendar]
 */

export type CalendarDefaultRule = {
  filter_type: string
  filter_params: Record<string, unknown>
  routing_mode: 'realtime' | 'scheduled' | 'drop'
  routing_schedule?: string
  alert?: boolean
}

export const calendarDefaultRules: readonly CalendarDefaultRule[] = [
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
] as const
