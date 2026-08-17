import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWordPressApi,
  getWordPressSiteIdentity,
  normalizeWordPressSiteUrl,
  packWordPressCredentials,
  unpackWordPressCredentials,
  type WordPressCredentials,
} from '../client.js'

const credentials: WordPressCredentials = {
  siteUrl: 'https://cms.example',
  username: 'site_editor',
  applicationPassword: 'abcd efgh ijkl mnop',
}
const allowPublicUrl = { validateUrl: async (raw: string) => new URL(raw) }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.WORDPRESS_ALLOW_INSECURE_LOOPBACK
})

describe('[COMP:api/wordpress-client] WordPress bridge client', () => {
  it('normalizes HTTPS base URLs, retains subdirectory installs, and rejects embedded credentials', () => {
    expect(normalizeWordPressSiteUrl('cms.example')).toBe('https://cms.example')
    expect(normalizeWordPressSiteUrl('https://cms.example/wordpress/')).toBe('https://cms.example/wordpress')
    expect(normalizeWordPressSiteUrl('https://user:pass@cms.example')).toBeNull()
    expect(normalizeWordPressSiteUrl('http://cms.example')).toBeNull()
  })

  it('allows loopback HTTP only with the explicit self-host development flag', () => {
    expect(normalizeWordPressSiteUrl('http://localhost:8080')).toBeNull()
    process.env.WORDPRESS_ALLOW_INSECURE_LOOPBACK = 'true'
    expect(normalizeWordPressSiteUrl('http://localhost:8080/wordpress/')).toBe('http://localhost:8080/wordpress')
  })

  it('round-trips the encrypted credential envelope and rejects malformed blobs', () => {
    expect(unpackWordPressCredentials(packWordPressCredentials(credentials))).toEqual(credentials)
    expect(unpackWordPressCredentials('{"siteUrl":"https://cms.example"}')).toBeNull()
    expect(unpackWordPressCredentials('not-json')).toBeNull()
  })

  it('verifies the fixed site endpoint and requires same-origin identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      site_url: 'https://cms.example',
      name: 'Example Studio',
      bridge_version: '0.1.0',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getWordPressSiteIdentity(credentials, allowPublicUrl)).resolves.toEqual({
      siteUrl: 'https://cms.example', name: 'Example Studio', bridgeVersion: '0.1.0',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cms.example/wp-json/use-brian/v1/site',
      expect.objectContaining({ redirect: 'error' }),
    )
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Basic /)
  })

  it('uses only fixed managed-content routes for reads and text writes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ page: 'home', slots: [] }))
      .mockResolvedValueOnce(jsonResponse({ page: 'home', revision: 'next' }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createWordPressApi(credentials, allowPublicUrl)

    await api.getManagedPage('home')
    await api.updatePageText({ page: 'home', slot: 'headline', value: 'Hello', expectedRevision: 'rev-1' })

    expect(fetchMock.mock.calls[0]![0]).toBe('https://cms.example/wp-json/use-brian/v1/managed-pages/home')
    expect(fetchMock.mock.calls[1]![0]).toBe('https://cms.example/wp-json/use-brian/v1/managed-pages/home/text/headline')
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({
      value: 'Hello', expected_revision: 'rev-1',
    })
  })

  it('uploads a new image as multipart data with revision and attachment guards', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ attachment_id: 42 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createWordPressApi(credentials, allowPublicUrl)
    await api.replacePageImage({
      page: 'home', slot: 'hero_image', bytes: new Uint8Array([1, 2, 3]),
      fileName: 'hero.png', mimeType: 'image/png', altText: 'Illustrated hero',
      expectedRevision: 'rev-1', expectedAttachmentId: 9,
    })

    expect(fetchMock.mock.calls[0]![0]).toBe('https://cms.example/wp-json/use-brian/v1/managed-pages/home/image/hero_image')
    const form = (fetchMock.mock.calls[0]![1] as RequestInit).body as FormData
    expect(form.get('alt_text')).toBe('Illustrated hero')
    expect(form.get('expected_revision')).toBe('rev-1')
    expect(form.get('expected_attachment_id')).toBe('9')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  it('translates provider errors without exposing raw remote text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      code: 'revision_conflict', message: 'sensitive PHP path and stack details',
    }, 409)))

    await expect(createWordPressApi(credentials, allowPublicUrl).updatePageText({
      page: 'home', slot: 'headline', value: 'Hello', expectedRevision: 'old',
    })).rejects.toMatchObject({
      code: 'revision_conflict', status: 409,
    })
    await expect(createWordPressApi(credentials, allowPublicUrl).updatePageText({
      page: 'home', slot: 'headline', value: 'Hello', expectedRevision: 'old',
    })).rejects.not.toThrow(/sensitive PHP/)
  })

  it('does not accept arbitrary path-like managed ids', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createWordPressApi(credentials, allowPublicUrl).getManagedPage('../users')).rejects.toMatchObject({ code: 'bridge_error' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('blocks a site when the DNS-aware public URL guard rejects the target', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(createWordPressApi(credentials, {
      validateUrl: vi.fn().mockResolvedValue(null),
    }).getManagedPage('home')).rejects.toMatchObject({ code: 'invalid_site_url' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('[COMP:wordpress/bridge-plugin] OSS WordPress bridge contract', () => {
  it('publishes only fixed managed-content routes with capability callbacks', async () => {
    const plugin = await readFile(new URL(
      '../../../../../integrations/wordpress/use-brian-bridge/use-brian-bridge.php',
      import.meta.url,
    ), 'utf8')

    expect(plugin).toContain("const NAMESPACE = 'use-brian/v1'")
    expect(plugin).toContain("'/managed-pages/(?P<page>")
    expect(plugin).toContain("/text/(?P<slot>")
    expect(plugin).toContain("/image/(?P<slot>")
    expect(plugin).toContain("'permission_callback' => array(__CLASS__, 'can_write_slot')")
    expect(plugin).toContain("current_user_can('upload_files')")
    expect(plugin).toContain("do_action('use_brian_managed_slot_updated'")
    expect(plugin).not.toMatch(/register_rest_route\([^\n]+\$request->get_param/)
  })
})
