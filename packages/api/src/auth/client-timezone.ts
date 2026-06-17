import type { Request, Response, NextFunction } from 'express'

declare global {
  namespace Express {
    interface Request {
      /**
       * The browser-reported IANA timezone from `X-Client-Timezone`.
       * Null when the header is missing, malformed, or the client can't
       * report one (plain curl, Telegram webhook, WA connector, etc.).
       *
       * Downstream code should treat this as a soft signal — fall through
       * to `users.timezone` when null. See
       * `docs/architecture/engine/scheduled-jobs.md` → "Timezone flow".
       */
      clientTimezone?: string
    }
  }
}

/**
 * Validate an IANA timezone name by attempting to construct a formatter.
 * Node.js + modern browsers reject unknown zones with a RangeError.
 * Exported so other routes (e.g. `/auth/google`) can validate body fields
 * that bypass the header-only `attachClientTimezone` middleware.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Express middleware that parses the `X-Client-Timezone` header and
 * attaches a validated IANA zone to `req.clientTimezone`. Never 4xx —
 * the header is optional and malformed values are silently dropped so
 * a buggy client can't lock itself out. Mount after body-parsers, once
 * globally, ahead of all routes that care.
 */
export function attachClientTimezone() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const raw = req.headers['x-client-timezone']
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (trimmed && trimmed.length < 80 && isValidTimezone(trimmed)) {
        req.clientTimezone = trimmed
      }
    }
    next()
  }
}

/**
 * How long a stored `last_seen_tz` observation stays usable for
 * cross-channel presence inheritance. Past this window the value is
 * treated as too stale (the user has had time to fly home and back),
 * and we fall through to the anchor zone instead.
 *
 * 24h is long enough that a Telegram-only message on the same trip
 * day still benefits from the morning's web visit, and short enough
 * that a returned-home user is not mistakenly displayed as still
 * abroad.
 */
const PRESENCE_TZ_FRESHNESS_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the *presence* timezone for the per-turn `# User Context`
 * block — the zone reflecting where the user actually is right now,
 * which may differ from their stored anchor (`users.timezone`).
 *
 * Resolution order:
 *   1. Live header (`req.clientTimezone`) when present and valid.
 *      This is the freshest signal we have on web requests and
 *      always wins.
 *   2. Stored `last_seen_tz` if observed within the freshness window.
 *      Lets channels without a browser (Telegram/Slack/WhatsApp)
 *      inherit the same trip presence the user just stamped from web.
 *   3. Anchor `users.timezone`. The original behaviour, used as a
 *      fallback for new users, expired observations, and offline
 *      channels.
 *   4. `'UTC'` if even the anchor is missing.
 *
 * The decision is intentionally one-shot and stateless. The drift
 * detector (`scheduling/tz-drift-detector.ts`) handles the slower
 * "permanent move" question separately by reading the analytics
 * audit trail.
 */
export function resolvePresenceTimezone(input: {
  liveClientTz?: string | null
  lastSeenTz?: string | null
  lastSeenTzAt?: Date | null
  anchorTimezone?: string | null
  /** Override for tests; defaults to `Date.now()`. */
  now?: () => number
}): string {
  const live = input.liveClientTz?.trim()
  if (live && live !== 'UTC' && isValidTimezone(live)) return live

  const stored = input.lastSeenTz?.trim()
  const stamped = input.lastSeenTzAt
  if (stored && stored !== 'UTC' && isValidTimezone(stored) && stamped) {
    const ageMs = (input.now?.() ?? Date.now()) - stamped.getTime()
    if (ageMs >= 0 && ageMs <= PRESENCE_TZ_FRESHNESS_MS) {
      return stored
    }
  }

  const anchor = input.anchorTimezone?.trim()
  if (anchor && isValidTimezone(anchor)) return anchor

  return 'UTC'
}
