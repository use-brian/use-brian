/** DNS-rebinding-safe HTTPS transport for hosted custom LLM endpoints. */

import { lookup as nodeLookup } from 'node:dns/promises'
import { request as nodeHttpsRequest, type RequestOptions } from 'node:https'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'

export type PublicEndpointAddress = {
  address: string
  family: 4 | 6
}

export type PublicEndpointLookup = (hostname: string) => Promise<readonly PublicEndpointAddress[]>

export class CustomLlmPublicEndpointError extends Error {
  readonly code = 'endpoint_public_address_required' as const

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CustomLlmPublicEndpointError'
  }
}

function ipv4Number(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => Number(part))
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0
}

function ipv4InCidr(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base)
  if (baseNumber === null) return false
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (address & mask) === (baseNumber & mask)
}

const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

/** Conservative global-unicast check for an address used by hosted Brian. */
export function isPublicCustomLlmAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4Number(address)
    return value !== null && !BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(value, base, prefix))
  }
  if (family !== 6) return false

  // Globally routable IPv6 lives in 2000::/3. Exclude documentation and
  // transition/special-purpose allocations from that otherwise broad range.
  const normalized = address.toLowerCase()
  const segments = normalized.split(':')
  const first = Number.parseInt(segments[0] || '0', 16)
  const second = Number.parseInt(segments[1] || '0', 16)
  if (first < 0x2000 || first > 0x3fff) return false
  if (first === 0x2001 && second <= 0x01ff) return false
  if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return false
  if (normalized.startsWith('2002:')) return false
  if (first === 0x3fff && second <= 0x0fff) return false
  return true
}

function normalizedHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
])

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return BLOCKED_HOSTNAMES.has(host)
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
}

const defaultLookup: PublicEndpointLookup = async (hostname) => {
  const answers = await nodeLookup(hostname, { all: true, verbatim: true })
  return answers
    .filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6)
    .map(({ address, family }) => ({ address, family }))
}

/**
 * Resolve every address before the request and fail closed if any answer is
 * non-public. Returning one vetted address lets the transport pin its lookup.
 */
export async function resolvePublicCustomLlmTarget(
  url: URL,
  lookup: PublicEndpointLookup = defaultLookup,
): Promise<PublicEndpointAddress> {
  if (url.protocol !== 'https:') {
    throw new CustomLlmPublicEndpointError('Hosted Brian requires a public HTTPS endpoint URL')
  }
  const hostname = normalizedHostname(url)
  if (isBlockedHostname(hostname)) {
    throw new CustomLlmPublicEndpointError('Hosted Brian cannot connect to local or private endpoint addresses')
  }

  const literalFamily = isIP(hostname)
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await lookup(hostname).catch((cause: unknown) => {
        throw new CustomLlmPublicEndpointError('Hosted Brian could not resolve the endpoint hostname', { cause })
      })
  if (answers.length === 0) {
    throw new CustomLlmPublicEndpointError('Hosted Brian could not resolve the endpoint hostname')
  }
  if (answers.some(({ address }) => !isPublicCustomLlmAddress(address))) {
    throw new CustomLlmPublicEndpointError('Hosted Brian cannot connect to local or private endpoint addresses')
  }

  // Prefer IPv4 when both are available. The security property is that every
  // answer was validated and this exact address is pinned, not which family wins.
  return answers.find(({ family }) => family === 4) ?? answers[0]!
}

type HttpsRequest = typeof nodeHttpsRequest

function requestBody(body: RequestInit['body']): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  throw new TypeError('Hosted custom LLM requests require a buffered request body')
}

/**
 * A fetch-compatible transport for the OpenAI Chat Completions adapter.
 * Redirects are surfaced as ordinary non-2xx responses and never followed.
 */
export function createPublicCustomLlmFetch(options?: {
  lookup?: PublicEndpointLookup
  request?: HttpsRequest
}): typeof fetch {
  const lookup = options?.lookup ?? defaultLookup
  const request = options?.request ?? nodeHttpsRequest

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString())
    const target = await resolvePublicCustomLlmTarget(url, lookup)
    const hostname = normalizedHostname(url)
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = requestBody(init?.body)

    return await new Promise<Response>((resolve, reject) => {
      const requestOptions: RequestOptions = {
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        headers,
        signal: init?.signal ?? undefined,
        servername: isIP(hostname) ? undefined : hostname,
        lookup: (_requestedHostname, _lookupOptions, callback) => {
          callback(null, target.address, target.family)
        },
      }
      const outgoing = request(url, requestOptions, (incoming) => {
        const responseHeaders = new Headers()
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item))
          else if (value !== undefined) responseHeaders.set(name, value)
        }
        const status = incoming.statusCode ?? 502
        const responseBody = status === 204 || status === 304
          ? null
          : Readable.toWeb(incoming) as ReadableStream<Uint8Array>
        resolve(new Response(responseBody, {
          status,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }))
      })
      outgoing.once('error', reject)
      if (body !== undefined) outgoing.write(body)
      outgoing.end()
    })
  }) as typeof fetch
}
