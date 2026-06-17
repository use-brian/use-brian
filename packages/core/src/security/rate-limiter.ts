/**
 * Sliding-window rate limiter. Defaults to keying by IP, but the
 * Express middleware accepts a custom `keyFn` so callers can key by
 * authenticated user id instead — important for browser apps where
 * many users sit behind shared NAT/proxy IPs.
 */

type RateLimitEntry = {
  timestamps: number[]
}

type RateLimiterRequest = {
  ip?: string
  headers: Record<string, string | string[] | undefined>
}

export type RateLimiterOptions = {
  maxRequests?: number
  windowMs?: number
}

const DEFAULT_MAX_REQUESTS = 30
const DEFAULT_WINDOW_MS = 60_000

export function createRateLimiter(options?: RateLimiterOptions) {
  const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS
  const entries = new Map<string, RateLimitEntry>()

  // Cleanup stale entries every 5 minutes
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [ip, entry] of entries) {
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)
      if (entry.timestamps.length === 0) entries.delete(ip)
    }
  }, 5 * 60_000)

  // Don't prevent process exit
  if (cleanupInterval.unref) cleanupInterval.unref()

  return {
    /**
     * Check if a request from this IP is allowed.
     * Returns true if allowed, false if rate limited.
     */
    check(ip: string): boolean {
      const now = Date.now()
      let entry = entries.get(ip)

      if (!entry) {
        entry = { timestamps: [] }
        entries.set(ip, entry)
      }

      // Remove timestamps outside the window
      entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs)

      if (entry.timestamps.length >= maxRequests) {
        return false
      }

      entry.timestamps.push(now)
      return true
    },

    /**
     * Express-compatible middleware. `keyFn` lets callers derive a
     * per-user key (e.g. JWT subject) instead of per-IP — required for
     * authenticated browser apps where many users share an outbound IP.
     */
    middleware(
      req: RateLimiterRequest,
      res: { status(code: number): { json(data: unknown): void } },
      next: () => void,
      keyFn?: (req: RateLimiterRequest) => string,
    ): void {
      const key = keyFn ? keyFn(req) : ipKey(req)

      if (!this.check(key)) {
        res.status(429).json({ error: 'Too many requests' })
        return
      }

      next()
    },

    destroy() {
      clearInterval(cleanupInterval)
    },
  }
}

function ipKey(req: RateLimiterRequest): string {
  const forwarded = req.headers['x-forwarded-for']
  const forwardedHead = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return req.ip ?? forwardedHead?.split(',')[0]?.trim() ?? 'unknown'
}
