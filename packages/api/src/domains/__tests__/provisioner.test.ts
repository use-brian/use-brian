import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:dns/promises', () => ({
  resolveCname: vi.fn(),
  resolve4: vi.fn(),
}))

import { resolve4, resolveCname } from 'node:dns/promises'
import {
  createDomainProvisioner,
  createManualDnsProvisioner,
  createVercelProvisioner,
} from '../provisioner.js'
import type { VercelClient } from '../../vercel/client.js'

const mockCname = vi.mocked(resolveCname)
const mockA = vi.mocked(resolve4)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:doc/page-domains] Domain provisioner seam', () => {
  describe('manual DNS provisioner', () => {
    it('goes live on a CNAME matching the target (trailing dot / case ignored)', async () => {
      mockCname.mockResolvedValueOnce(['App.Example.Com.'])
      const p = createManualDnsProvisioner({ cnameTarget: 'app.example.com' })
      const r = await p.check('docs.acme.com')
      expect(r.live).toBe(true)
      expect(r.error).toBeNull()
    })

    it('falls back to an A-record intersection for apex domains', async () => {
      mockCname.mockRejectedValueOnce(new Error('ENODATA'))
      mockA.mockResolvedValueOnce(['1.2.3.4']) // hostname
      mockA.mockResolvedValueOnce(['9.9.9.9', '1.2.3.4']) // target
      const p = createManualDnsProvisioner({ cnameTarget: 'app.example.com' })
      const r = await p.check('acme.com')
      expect(r.live).toBe(true)
    })

    it('reports a mismatched CNAME with instructions', async () => {
      mockCname.mockResolvedValueOnce(['elsewhere.example.net.'])
      mockA.mockResolvedValue([])
      const p = createManualDnsProvisioner({ cnameTarget: 'app.example.com' })
      const r = await p.check('docs.acme.com')
      expect(r.live).toBe(false)
      expect(r.error).toContain('elsewhere.example.net')
      expect(r.instructions).toEqual([
        { type: 'CNAME', name: 'docs.acme.com', value: 'app.example.com' },
      ])
    })

    it('with no target configured, only requires the hostname to resolve', async () => {
      mockCname.mockRejectedValueOnce(new Error('ENODATA'))
      mockA.mockResolvedValueOnce(['1.2.3.4'])
      const p = createManualDnsProvisioner({})
      const r = await p.check('docs.acme.com')
      expect(r.live).toBe(true)
      expect(r.instructions).toEqual([])
    })
  })

  describe('vercel provisioner', () => {
    function stubClient(overrides: Partial<VercelClient> = {}): VercelClient {
      return {
        addProjectDomain: vi.fn(async () => ({ name: 'docs.acme.com', apexName: 'acme.com', verified: true })),
        getProjectDomain: vi.fn(async () => ({ name: 'docs.acme.com', apexName: 'acme.com', verified: true })),
        verifyProjectDomain: vi.fn(async () => ({ name: 'docs.acme.com', apexName: 'acme.com', verified: true })),
        getDomainConfig: vi.fn(async () => ({ misconfigured: false })),
        removeProjectDomain: vi.fn(async () => {}),
        ...overrides,
      }
    }

    it('is live when verified and DNS is configured', async () => {
      const p = createVercelProvisioner({ client: stubClient(), projectId: 'prj_1' })
      const r = await p.check('docs.acme.com')
      expect(r.live).toBe(true)
      expect(r.instructions[0]).toEqual({
        type: 'CNAME',
        name: 'docs.acme.com',
        value: 'cname.vercel-dns.com',
      })
    })

    it('surfaces the TXT ownership challenge while unverified', async () => {
      const unverified = {
        name: 'docs.acme.com',
        apexName: 'acme.com',
        verified: false,
        verification: [
          { type: 'TXT', domain: '_vercel.acme.com', value: 'vc-domain-verify=abc' },
        ],
      }
      const client = stubClient({
        getProjectDomain: vi.fn(async () => unverified),
        verifyProjectDomain: vi.fn(async () => unverified),
      })
      const p = createVercelProvisioner({ client, projectId: 'prj_1' })
      const r = await p.check('docs.acme.com')
      expect(r.live).toBe(false)
      expect(r.error).toContain('verification')
      expect(r.instructions).toContainEqual({
        type: 'TXT',
        name: '_vercel.acme.com',
        value: 'vc-domain-verify=abc',
      })
    })

    it('recommends the apex A record for apex domains', async () => {
      const client = stubClient({
        getProjectDomain: vi.fn(async () => ({ name: 'acme.com', apexName: 'acme.com', verified: true })),
      })
      const p = createVercelProvisioner({ client, projectId: 'prj_1' })
      const r = await p.check('acme.com')
      expect(r.instructions[0]).toEqual({ type: 'A', name: 'acme.com', value: '76.76.21.21' })
    })

    it('is not live while DNS is misconfigured', async () => {
      const client = stubClient({ getDomainConfig: vi.fn(async () => ({ misconfigured: true })) })
      const p = createVercelProvisioner({ client, projectId: 'prj_1' })
      const r = await p.check('docs.acme.com')
      expect(r.live).toBe(false)
    })
  })

  describe('factory', () => {
    it('picks vercel only when token + project id are both set', () => {
      expect(createDomainProvisioner({}).kind).toBe('manual')
      expect(createDomainProvisioner({ PAGE_DOMAIN_VERCEL_TOKEN: 't' }).kind).toBe('manual')
      expect(
        createDomainProvisioner({
          PAGE_DOMAIN_VERCEL_TOKEN: 't',
          PAGE_DOMAIN_VERCEL_PROJECT_ID: 'prj',
        }).kind,
      ).toBe('vercel')
    })
  })
})
