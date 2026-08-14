/**
 * Fixed-route HTTP client for the OSS Use Brian WordPress Bridge.
 *
 * No caller can supply a REST path. The only variable path segments are
 * validated managed page/slot ids from the bridge catalog.
 * See docs/architecture/integrations/wordpress.md.
 */

import type { WordPressApi } from '@use-brian/core'
import { validateUrlAsync } from '../routes/doc-og.js'

const BRIDGE_NAMESPACE = '/wp-json/use-brian/v1'
const REQUEST_TIMEOUT_MS = 20_000
const MANAGED_ID = /^[a-z][a-z0-9_-]{0,99}$/

export type WordPressCredentials = {
  siteUrl: string
  username: string
  applicationPassword: string
}

export type WordPressSiteIdentity = {
  siteUrl: string
  name: string
  bridgeVersion: string
}

export type WordPressClientOptions = {
  /** Test seam; defaults to the shared DNS-aware public-URL SSRF guard. */
  validateUrl?: (raw: string) => Promise<URL | null>
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>
}

export type WordPressConnectorErrorCode =
  | 'invalid_site_url'
  | 'invalid_credentials'
  | 'forbidden'
  | 'bridge_required'
  | 'managed_page_not_found'
  | 'managed_slot_not_found'
  | 'wrong_slot_type'
  | 'revision_conflict'
  | 'attachment_conflict'
  | 'unsupported_image'
  | 'file_too_large'
  | 'timeout'
  | 'bridge_error'

export class WordPressConnectorError extends Error {
  constructor(
    public readonly code: WordPressConnectorErrorCode,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WordPressConnectorError'
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/** Normalize the WordPress base URL, retaining a legitimate subdirectory install. */
export function normalizeWordPressSiteUrl(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`)
    const insecureLoopbackAllowed =
      url.protocol === 'http:' &&
      isLoopback(url.hostname) &&
      process.env.WORDPRESS_ALLOW_INSECURE_LOOPBACK === 'true'
    if (url.protocol !== 'https:' && !insecureLoopbackAllowed) return null
    if (url.username || url.password || url.search || url.hash) return null
    const basePath = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${basePath === '/' ? '' : basePath}`
  } catch {
    return null
  }
}

export function packWordPressCredentials(credentials: WordPressCredentials): string {
  const siteUrl = normalizeWordPressSiteUrl(credentials.siteUrl)
  const username = credentials.username.trim()
  const applicationPassword = credentials.applicationPassword.trim()
  if (!siteUrl || !username || !applicationPassword || username.includes(':')) {
    throw new WordPressConnectorError('invalid_site_url', 'WordPress credentials are incomplete or invalid')
  }
  return JSON.stringify({ siteUrl, username, applicationPassword })
}

export function unpackWordPressCredentials(blob: string): WordPressCredentials | null {
  try {
    const parsed = JSON.parse(blob) as Partial<WordPressCredentials>
    if (
      typeof parsed.siteUrl !== 'string' ||
      typeof parsed.username !== 'string' ||
      typeof parsed.applicationPassword !== 'string'
    ) return null
    const siteUrl = normalizeWordPressSiteUrl(parsed.siteUrl)
    const username = parsed.username.trim()
    const applicationPassword = parsed.applicationPassword.trim()
    if (!siteUrl || !username || !applicationPassword || username.includes(':')) return null
    return { siteUrl, username, applicationPassword }
  } catch {
    return null
  }
}

function managedId(value: string, kind: 'page' | 'slot'): string {
  if (!MANAGED_ID.test(value)) {
    throw new WordPressConnectorError('bridge_error', `Invalid managed ${kind} id`)
  }
  return encodeURIComponent(value)
}

function bridgeErrorCode(status: number, providerCode?: string): WordPressConnectorErrorCode {
  if (status === 401) return 'invalid_credentials'
  if (status === 403) return 'forbidden'
  if (status === 404 && (providerCode === 'rest_no_route' || !providerCode)) return 'bridge_required'
  const known: WordPressConnectorErrorCode[] = [
    'managed_page_not_found',
    'managed_slot_not_found',
    'wrong_slot_type',
    'revision_conflict',
    'attachment_conflict',
    'unsupported_image',
    'file_too_large',
  ]
  if (known.includes(providerCode as WordPressConnectorErrorCode)) {
    return providerCode as WordPressConnectorErrorCode
  }
  return 'bridge_error'
}

function safeErrorMessage(code: WordPressConnectorErrorCode): string {
  switch (code) {
    case 'invalid_credentials': return 'The WordPress username or Application Password is invalid'
    case 'forbidden': return 'The WordPress user does not have permission for this managed content'
    case 'bridge_required': return 'The Use Brian Bridge plugin is not installed, active, or reachable at this site URL'
    case 'managed_page_not_found': return 'That page is not in the site\'s managed-content catalog'
    case 'managed_slot_not_found': return 'That location is not in the page\'s managed-content catalog'
    case 'wrong_slot_type': return 'That managed location has a different content type'
    case 'revision_conflict': return 'The page changed after it was read. Read it again before updating'
    case 'attachment_conflict': return 'The image changed after it was read. Read the page again before updating'
    case 'unsupported_image': return 'The WordPress site rejected this image type'
    case 'file_too_large': return 'The image exceeds the WordPress site upload limit'
    case 'timeout': return 'The WordPress site did not respond in time'
    case 'invalid_site_url': return 'Enter a valid HTTPS WordPress site URL'
    default: return 'The WordPress bridge could not complete the request'
  }
}

async function wpFetch(
  credentials: WordPressCredentials,
  path: string,
  init?: RequestInit,
  options: WordPressClientOptions = {},
): Promise<unknown> {
  const siteUrl = normalizeWordPressSiteUrl(credentials.siteUrl)
  if (!siteUrl) throw new WordPressConnectorError('invalid_site_url', safeErrorMessage('invalid_site_url'))
  const auth = Buffer.from(`${credentials.username}:${credentials.applicationPassword}`, 'utf8').toString('base64')
  const targetUrl = `${siteUrl}${BRIDGE_NAMESPACE}${path}`
  const target = new URL(targetUrl)
  const insecureLoopbackAllowed =
    target.protocol === 'http:' &&
    isLoopback(target.hostname) &&
    process.env.WORDPRESS_ALLOW_INSECURE_LOOPBACK === 'true'
  if (!insecureLoopbackAllowed && !(await (options.validateUrl ?? validateUrlAsync)(targetUrl))) {
    throw new WordPressConnectorError('invalid_site_url', safeErrorMessage('invalid_site_url'))
  }

  let response: Response
  try {
    response = await (options.fetchFn ?? fetch)(targetUrl, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${auth}`,
        ...init?.headers,
      },
    })
  } catch (error) {
    if (error instanceof WordPressConnectorError) throw error
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    const code: WordPressConnectorErrorCode = timedOut ? 'timeout' : 'bridge_error'
    throw new WordPressConnectorError(code, safeErrorMessage(code), undefined, { cause: error })
  }

  const contentType = response.headers.get('content-type') ?? ''
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => null) as Record<string, unknown> | null
    : null

  if (!response.ok) {
    const providerCode = typeof body?.code === 'string' ? body.code : undefined
    const code = bridgeErrorCode(response.status, providerCode)
    throw new WordPressConnectorError(code, safeErrorMessage(code), response.status)
  }
  if (!body || typeof body !== 'object') {
    throw new WordPressConnectorError('bridge_error', 'The WordPress bridge returned an invalid response')
  }
  return body
}

export async function getWordPressSiteIdentity(
  credentials: WordPressCredentials,
  options: WordPressClientOptions = {},
): Promise<WordPressSiteIdentity> {
  const body = await wpFetch(credentials, '/site', undefined, options) as Record<string, unknown>
  const canonical = typeof body.site_url === 'string' ? normalizeWordPressSiteUrl(body.site_url) : null
  const requested = normalizeWordPressSiteUrl(credentials.siteUrl)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const bridgeVersion = typeof body.bridge_version === 'string' ? body.bridge_version.trim() : ''
  if (!canonical || canonical !== requested || !name || !bridgeVersion) {
    throw new WordPressConnectorError('bridge_error', 'The WordPress bridge returned an invalid site identity')
  }
  return { siteUrl: canonical, name, bridgeVersion }
}

export function createWordPressApi(
  credentials: WordPressCredentials,
  options: WordPressClientOptions = {},
): WordPressApi {
  return {
    async getManagedPage(page) {
      return wpFetch(credentials, `/managed-pages/${managedId(page, 'page')}`, undefined, options)
    },
    async updatePageText(params) {
      return wpFetch(
        credentials,
        `/managed-pages/${managedId(params.page, 'page')}/text/${managedId(params.slot, 'slot')}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: params.value, expected_revision: params.expectedRevision }),
        },
        options,
      )
    },
    async replacePageImage(params) {
      const form = new FormData()
      form.append('file', new Blob([Buffer.from(params.bytes)], { type: params.mimeType }), params.fileName)
      form.append('alt_text', params.altText)
      form.append('expected_revision', params.expectedRevision)
      form.append('expected_attachment_id', params.expectedAttachmentId === null ? '' : String(params.expectedAttachmentId))
      return wpFetch(
        credentials,
        `/managed-pages/${managedId(params.page, 'page')}/image/${managedId(params.slot, 'slot')}`,
        { method: 'POST', body: form },
        options,
      )
    },
  }
}
