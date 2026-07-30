/**
 * [COMP:api/home-app-tools] — the assistant authoring path.
 *
 * The load-bearing claims, in the order they matter:
 *
 *   1. the SERVER re-validates every write and fails closed — a bundle that
 *      does not validate is not saved at all, because a half-valid app is a
 *      thing an admin would then be asked to grant scopes to;
 *   2. authoring never bypasses consent — a written app waits for a human;
 *   3. a write is a full REPLACE, not a patch, so a file from a previous
 *      version cannot survive undeclared and keep being served.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows: Array<Record<string, unknown>> = []
const applied: Array<Record<string, unknown>> = []

vi.mock('../../db/home-apps-store.js', () => ({
  listHomeApps: vi.fn(async () => rows),
  createHomeApp: vi.fn(async (params: Record<string, unknown>) => {
    const manifest = params.manifest as { name: string }
    const row = {
      id: `app-${rows.length + 1}`,
      workspaceId: params.workspaceId,
      kind: params.kind,
      name: manifest.name,
      description: null,
      manifest,
      grantedScopes: null,
      // A newly authored app ALWAYS lands here — the assistant can build, only
      // a human admin can grant.
      status: 'needs_consent',
      syncError: null,
      repo: null,
      branch: 'main',
    }
    rows.push(row)
    return row
  }),
  applyHomeAppManifest: vi.fn(async (params: Record<string, unknown>) => {
    applied.push(params)
    const row = rows.find((r) => r.id === params.appId)
    if (!row) return null
    row.manifest = params.manifest
    return { app: row, droppedToNeedsConsent: false }
  }),
}))

import { describeAppStatus, writeHomeAppBundle } from '../tools.js'

const MANIFEST = {
  manifestVersion: 1,
  name: 'Pipeline board',
  entry: 'index.html',
  scopes: { data: 'read' },
}

function bundle(over: Record<string, unknown> = {}) {
  return [
    { path: 'brian-app.json', content: JSON.stringify({ ...MANIFEST, ...over }) },
    { path: 'index.html', content: '<h1>hi</h1>' },
  ]
}

function deps() {
  const written: string[] = []
  const cleared: string[] = []
  return {
    written,
    cleared,
    value: {
      filesApi: {
        write: vi.fn(async (_ctx: unknown, p: { path: string }) => {
          written.push(p.path)
          return { ok: true, value: {} }
        }),
      } as never,
      workspaceId: 'ws-1',
      actingUserId: 'u-1',
      bundlePath: (appId: string, path: string) => `/apps/${appId}/${path}`,
      clearBundle: vi.fn(async (_ws: string, appId: string) => {
        cleared.push(appId)
      }),
    },
  }
}

beforeEach(() => {
  rows.length = 0
  applied.length = 0
})

describe('[COMP:api/home-app-tools] writeHomeApp', () => {
  it('creates an app and stores every file under its bundle prefix', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, { name: '', files: bundle() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.created).toBe(true)
    expect(d.written).toEqual(['/apps/app-1/brian-app.json', '/apps/app-1/index.html'])
  })

  it('lands at needs_consent — authoring never bypasses a human', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, { name: '', files: bundle() })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.app.status).toBe('needs_consent')
    expect(result.app.grantedScopes).toBeNull()
  })

  it('CLEARS the bundle before writing — a write is a replace, not a patch', async () => {
    // Otherwise a file from a previous version survives undeclared, and the
    // serving route would happily keep handing it out.
    const d = deps()
    await writeHomeAppBundle(d.value, { name: '', files: bundle() })
    expect(d.cleared).toEqual(['app-1'])
  })

  it('updates the SAME row on a second write of the same app', async () => {
    const d = deps()
    await writeHomeAppBundle(d.value, { name: '', files: bundle() })
    const second = await writeHomeAppBundle(d.value, { name: '', files: bundle() })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.created).toBe(false)
    expect(rows).toHaveLength(1)
    expect(applied).toHaveLength(1)
  })

  it('refuses a bundle with no manifest', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, {
      name: '',
      files: [{ path: 'index.html', content: '<h1>hi</h1>' }],
    })
    expect(result).toMatchObject({ ok: false })
    expect(d.written).toEqual([])
  })

  it('refuses unparseable manifest JSON without writing anything', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, {
      name: '',
      files: [
        { path: 'brian-app.json', content: '{ not json' },
        { path: 'index.html', content: 'x' },
      ],
    })
    expect(result).toMatchObject({ ok: false })
    expect(d.written).toEqual([])
    expect(rows).toEqual([])
  })

  it('FAILS CLOSED on an invalid manifest — nothing is stored', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, {
      name: '',
      files: bundle({ scopes: { data: 'god-mode' } }),
    })
    expect(result).toMatchObject({ ok: false })
    if (result.ok) return
    expect(result.message).toContain('scopes.data')
    // Not saved at all: an admin must never be asked to grant scopes to a
    // half-valid app.
    expect(rows).toEqual([])
    expect(d.written).toEqual([])
  })

  it('refuses a bundle whose declared entry is missing', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, {
      name: '',
      files: [{ path: 'brian-app.json', content: JSON.stringify(MANIFEST) }],
    })
    expect(result).toMatchObject({ ok: false })
    expect(rows).toEqual([])
  })

  it('surfaces advisory lint findings without failing', async () => {
    const d = deps()
    const result = await writeHomeAppBundle(d.value, {
      name: '',
      files: bundle({ scopes: { data: 'read_write' } }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((w) => w.includes('read_write'))).toBe(true)
  })
})

describe('[COMP:api/home-app-tools] describeAppStatus', () => {
  const base = { status: 'active', grantedScopes: { data: 'read' } } as never

  it('names what the app is waiting on, distinguishing first consent from re-consent', () => {
    expect(describeAppStatus(base)).toContain('live on Home')
    expect(
      describeAppStatus({ status: 'needs_consent', grantedScopes: null } as never),
    ).toContain('waiting on consent')
    // A standing grant plus needs_consent means the manifest WIDENED — a
    // different sentence, because the admin already approved something.
    expect(
      describeAppStatus({ status: 'needs_consent', grantedScopes: { data: 'read' } } as never),
    ).toContain('re-consent')
    expect(describeAppStatus({ status: 'disabled', grantedScopes: null } as never)).toContain(
      'turned off',
    )
  })
})
