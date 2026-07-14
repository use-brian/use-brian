/**
 * Vercel API client — thin fetch-based wrappers for project domain
 * management (the hosted custom-domain provisioner). Each function makes a
 * single API call; the token/team scope rides a shared config object.
 * See docs/architecture/features/custom-domains.md → "Provisioner seam".
 */

const VERCEL_API = 'https://api.vercel.com'

export type VercelClientConfig = {
  token: string
  teamId?: string
}

export type VercelDomainVerification = {
  type: string
  domain: string
  value: string
  reason?: string
}

export type VercelProjectDomain = {
  name: string
  apexName: string
  verified: boolean
  verification?: VercelDomainVerification[]
}

export type VercelDomainConfig = {
  misconfigured: boolean
}

export class VercelApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'VercelApiError'
  }
}

async function vercelFetch(
  config: VercelClientConfig,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const sep = path.includes('?') ? '&' : '?'
  const url = `${VERCEL_API}${path}${config.teamId ? `${sep}teamId=${encodeURIComponent(config.teamId)}` : ''}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let code: string | null = null
    let message = ''
    try {
      const body = (await res.json()) as { error?: { code?: string; message?: string } }
      code = body.error?.code ?? null
      message = body.error?.message ?? ''
    } catch {
      // non-JSON error body; status is enough
    }
    throw new VercelApiError(
      `Vercel API error (${res.status})${code ? ` [${code}]` : ''}: ${message}`,
      res.status,
      code,
    )
  }
  return res
}

export type VercelClient = {
  /** Attach a domain to the project. Idempotent: an already-attached domain resolves. */
  addProjectDomain(projectId: string, hostname: string): Promise<VercelProjectDomain>
  getProjectDomain(projectId: string, hostname: string): Promise<VercelProjectDomain | null>
  /** Ask Vercel to re-run ownership verification (TXT challenge). */
  verifyProjectDomain(projectId: string, hostname: string): Promise<VercelProjectDomain>
  /** DNS-level config state: misconfigured=false means DNS points at Vercel. */
  getDomainConfig(hostname: string): Promise<VercelDomainConfig>
  removeProjectDomain(projectId: string, hostname: string): Promise<void>
}

export function createVercelClient(config: VercelClientConfig): VercelClient {
  return {
    async addProjectDomain(projectId, hostname) {
      try {
        const res = await vercelFetch(config, `/v10/projects/${encodeURIComponent(projectId)}/domains`, {
          method: 'POST',
          body: JSON.stringify({ name: hostname }),
        })
        return (await res.json()) as VercelProjectDomain
      } catch (err) {
        // Already attached to THIS project: treat as success (re-attach flow).
        if (err instanceof VercelApiError && err.code === 'domain_already_in_use_by_project') {
          const existing = await this.getProjectDomain(projectId, hostname)
          if (existing) return existing
        }
        throw err
      }
    },

    async getProjectDomain(projectId, hostname) {
      try {
        const res = await vercelFetch(
          config,
          `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`,
        )
        return (await res.json()) as VercelProjectDomain
      } catch (err) {
        if (err instanceof VercelApiError && err.status === 404) return null
        throw err
      }
    },

    async verifyProjectDomain(projectId, hostname) {
      const res = await vercelFetch(
        config,
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}/verify`,
        { method: 'POST' },
      )
      return (await res.json()) as VercelProjectDomain
    },

    async getDomainConfig(hostname) {
      const res = await vercelFetch(config, `/v6/domains/${encodeURIComponent(hostname)}/config`)
      return (await res.json()) as VercelDomainConfig
    },

    async removeProjectDomain(projectId, hostname) {
      try {
        await vercelFetch(
          config,
          `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(hostname)}`,
          { method: 'DELETE' },
        )
      } catch (err) {
        if (err instanceof VercelApiError && err.status === 404) return
        throw err
      }
    },
  }
}
