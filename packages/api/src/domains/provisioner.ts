/**
 * Domain provisioner seam — how an attached custom domain gets DNS
 * instructions, verification, and (hosted) edge/TLS attachment.
 *
 * Two implementations behind one interface, picked at boot by
 * `createDomainProvisioner(env)`:
 * - `manual` (open default): no side effects; verification is a live DNS
 *   lookup against `PAGE_DOMAIN_CNAME_TARGET`. With no target configured it
 *   cannot verify the host is served by this deployment (a wildcard resolves
 *   every subdomain yet the edge 404s unattached hosts), so it never reports
 *   live — status stays pending until a target or the edge provider is set.
 * - `vercel` (hosted): attaches the hostname to the app-web Vercel project;
 *   Vercel issues TLS once DNS points at it.
 *
 * Spec: docs/architecture/features/custom-domains.md → "Provisioner seam".
 *
 * [COMP:doc/page-domains]
 */

import { resolve4, resolveCname } from 'node:dns/promises'
import { createVercelClient, type VercelClient } from '../vercel/client.js'

export type DnsInstruction = {
  type: 'CNAME' | 'A' | 'TXT'
  name: string
  value: string
}

export type DomainCheckResult = {
  live: boolean
  error: string | null
  instructions: DnsInstruction[]
}

export type DomainProvisioner = {
  kind: 'manual' | 'vercel'
  /** Called at attach time. Returns the DNS rows the owner must create. */
  add(hostname: string): Promise<{ instructions: DnsInstruction[] }>
  /** Re-run verification; the route maps `live` onto page_domains.status. */
  check(hostname: string): Promise<DomainCheckResult>
  /** Called at detach time. Best-effort — a failure never blocks the delete. */
  remove(hostname: string): Promise<void>
}

const stripDot = (host: string) => host.toLowerCase().replace(/\.$/, '')

// ── Manual (open default) ────────────────────────────────────

export function createManualDnsProvisioner(opts: { cnameTarget?: string }): DomainProvisioner {
  const target = opts.cnameTarget ? stripDot(opts.cnameTarget) : null
  const instructionsFor = (hostname: string): DnsInstruction[] =>
    target ? [{ type: 'CNAME', name: hostname, value: target }] : []

  return {
    kind: 'manual',
    async add(hostname) {
      return { instructions: instructionsFor(hostname) }
    },
    async check(hostname) {
      const instructions = instructionsFor(hostname)
      try {
        const cnames = await resolveCname(hostname).catch(() => [] as string[])
        if (!target) {
          // A bare DNS lookup does NOT prove this deployment serves the host.
          // A wildcard (`*.apex`) resolves every subdomain to our edge IPs, yet
          // the edge 404s any host not actually attached to it — so "resolves"
          // is not "live". With no CNAME target to compare against (and no edge
          // provider to query), verification is impossible here, so never claim
          // live. Status stays pending_dns; the page still serves once the host
          // is attached at the edge and DNS points here (status is UI-only, not
          // a serving gate — see custom-domains.md).
          const resolves =
            cnames.length > 0 || (await resolve4(hostname).catch(() => [] as string[])).length > 0
          return {
            live: false,
            error: resolves
              ? 'verification is not configured on this deployment (set PAGE_DOMAIN_CNAME_TARGET or the Vercel provider); the page serves once this host is attached at the edge'
              : 'hostname does not resolve',
            instructions,
          }
        }
        if (cnames.some((c) => stripDot(c) === target)) {
          return { live: true, error: null, instructions }
        }
        // Apex domains cannot CNAME: accept an A-record intersection with the
        // target's addresses.
        const [hostA, targetA] = await Promise.all([
          resolve4(hostname).catch(() => [] as string[]),
          resolve4(target).catch(() => [] as string[]),
        ])
        if (hostA.some((ip) => targetA.includes(ip))) {
          return { live: true, error: null, instructions }
        }
        return {
          live: false,
          error:
            cnames.length > 0
              ? `CNAME points at ${cnames[0]}, expected ${target}`
              : `no CNAME (or matching A record) pointing at ${target}`,
          instructions,
        }
      } catch (err) {
        return { live: false, error: (err as Error).message, instructions }
      }
    },
    async remove() {
      // Nothing was provisioned.
    },
  }
}

// ── Vercel (hosted) ──────────────────────────────────────────

const VERCEL_CNAME = 'cname.vercel-dns.com'
const VERCEL_APEX_A = '76.76.21.21'

export function createVercelProvisioner(opts: {
  client: VercelClient
  projectId: string
}): DomainProvisioner {
  const { client, projectId } = opts

  const dnsInstruction = (hostname: string, apexName: string | undefined): DnsInstruction =>
    apexName && apexName === hostname
      ? { type: 'A', name: hostname, value: VERCEL_APEX_A }
      : { type: 'CNAME', name: hostname, value: VERCEL_CNAME }

  async function collectState(hostname: string): Promise<DomainCheckResult> {
    let domain = await client.getProjectDomain(projectId, hostname)
    if (!domain) {
      return {
        live: false,
        error: 'domain is not attached to the project',
        instructions: [dnsInstruction(hostname, undefined)],
      }
    }
    if (!domain.verified) {
      // Cross-account claims need a TXT challenge; verify is idempotent.
      domain = await client.verifyProjectDomain(projectId, hostname).catch(() => domain)
    }
    const instructions: DnsInstruction[] = [dnsInstruction(hostname, domain?.apexName)]
    for (const v of domain?.verification ?? []) {
      if (v.type.toUpperCase() === 'TXT') {
        instructions.push({ type: 'TXT', name: v.domain, value: v.value })
      }
    }
    if (domain && !domain.verified) {
      return { live: false, error: 'ownership verification pending', instructions }
    }
    const config = await client.getDomainConfig(hostname)
    if (config.misconfigured) {
      return { live: false, error: 'DNS does not point at the site yet', instructions }
    }
    return { live: true, error: null, instructions }
  }

  return {
    kind: 'vercel',
    async add(hostname) {
      await client.addProjectDomain(projectId, hostname)
      const state = await collectState(hostname)
      return { instructions: state.instructions }
    },
    async check(hostname) {
      try {
        return await collectState(hostname)
      } catch (err) {
        return { live: false, error: (err as Error).message, instructions: [] }
      }
    },
    async remove(hostname) {
      try {
        await client.removeProjectDomain(projectId, hostname)
      } catch (err) {
        console.warn(`[domains] vercel detach failed for ${hostname}:`, err)
      }
    },
  }
}

// ── Factory ──────────────────────────────────────────────────

export type DomainProvisionerEnv = {
  PAGE_DOMAIN_VERCEL_TOKEN?: string
  PAGE_DOMAIN_VERCEL_PROJECT_ID?: string
  PAGE_DOMAIN_VERCEL_TEAM_ID?: string
  PAGE_DOMAIN_CNAME_TARGET?: string
}

export function createDomainProvisioner(env: DomainProvisionerEnv): DomainProvisioner {
  if (env.PAGE_DOMAIN_VERCEL_TOKEN && env.PAGE_DOMAIN_VERCEL_PROJECT_ID) {
    return createVercelProvisioner({
      client: createVercelClient({
        token: env.PAGE_DOMAIN_VERCEL_TOKEN,
        teamId: env.PAGE_DOMAIN_VERCEL_TEAM_ID,
      }),
      projectId: env.PAGE_DOMAIN_VERCEL_PROJECT_ID,
    })
  }
  return createManualDnsProvisioner({ cnameTarget: env.PAGE_DOMAIN_CNAME_TARGET })
}
