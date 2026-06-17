/**
 * Calendar canonical adapter — public surface.
 *
 * Aggregates the per-source pieces a canonical adapter contributes per
 * the ingest.md §Adapter strategy reference shape:
 *
 *   - `source` — short stable identifier matching `connector_instance.provider`
 *   - `normalize` — raw Google Calendar `Event` resource → filter-ready shape
 *   - `filterImplementations` — the four Calendar filters
 *   - `defaultRules` — pre-seeded rule list per ingest.md:758
 *
 * The barrel re-export in `packages/core/src/ingest/index.ts` is updated
 * by the coordinator after merge (WS-7 wave dispatch convention) — this
 * file is the in-package entry point until then.
 *
 * Webhook receiving + Google Calendar API fetching live downstream
 * (`apps/api`); this module is pure TypeScript with no network or DB
 * dependencies, matching `packages/core/CLAUDE.md`'s rule.
 *
 * [COMP:brain/source-adapters/calendar]
 */

export {
  CALENDAR_EVENT_STATUSES,
  rawCalendarEventSchema,
  type CalendarEventStatus,
  type CalendarNormalizedEvent,
  type RawCalendarEvent,
} from './types.js'

export { normalizeCalendarEvent } from './normalize.js'

export {
  attendeeMatch,
  organizerMatch,
  subjectContains,
  isRecurring,
  attendeeMatchParamsSchema,
  organizerMatchParamsSchema,
  subjectContainsParamsSchema,
  isRecurringParamsSchema,
  calendarFilterImplementations,
  calendarFilterParamsSchemas,
  type AttendeeMatchParams,
  type OrganizerMatchParams,
  type SubjectContainsParams,
  type IsRecurringParams,
  type CalendarFilterType,
} from './filters.js'

export {
  calendarDefaultRules,
  type CalendarDefaultRule,
} from './default-rules.js'

import { normalizeCalendarEvent } from './normalize.js'
import {
  calendarFilterImplementations,
  calendarFilterParamsSchemas,
} from './filters.js'
import { calendarDefaultRules } from './default-rules.js'

/**
 * Aggregate Calendar adapter. The shared `ConnectorAdapter` interface
 * (planned for `packages/core/src/ingest/` once all WS-7 sessions
 * merge) will line up with this shape — until then the type is
 * intentionally local to keep this WU self-contained.
 */
export const calendarAdapter = {
  source: 'calendar' as const,
  normalize: normalizeCalendarEvent,
  filterImplementations: calendarFilterImplementations,
  filterParamsSchemas: calendarFilterParamsSchemas,
  defaultRules: calendarDefaultRules,
}

export type CalendarAdapter = typeof calendarAdapter
