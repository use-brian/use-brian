/**
 * Unit tests for the connector registry loader + schema.
 * Component tag: [COMP:api/connector-registry].
 *
 * Mocks `node:fs`. Verifies loadConnectorRegistry (official connectors
 * always present, community connector.json files validated + tagged
 * category:'community', malformed-JSON and schema-invalid entries
 * skipped, readdir failure → official-only fallback) and the
 * @use-brian/shared schema (ConnectorEntrySchema defaults + the
 * OFFICIAL_CONNECTORS table's own integrity).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}))

import { readFileSync, readdirSync } from 'node:fs'
import { loadConnectorRegistry } from '../load-registry.js'
import { ConnectorEntrySchema, OFFICIAL_CONNECTORS } from '@use-brian/shared'

const mockRead = vi.mocked(readFileSync)
const mockReaddir = vi.mocked(readdirSync)

function dirent(name: string, isDir = true) {
  return { name, isDirectory: () => isDir }
}

beforeEach(() => {
  mockRead.mockReset()
  mockReaddir.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('[COMP:api/connector-registry] loadConnectorRegistry', () => {
  it('always includes every official connector', () => {
    mockReaddir.mockReturnValueOnce([] as never)
    const registry = loadConnectorRegistry()
    for (const official of OFFICIAL_CONNECTORS) {
      expect(registry.some((c) => c.id === official.id)).toBe(true)
    }
  })

  it('loads a valid community connector.json and tags it category:community', () => {
    mockReaddir.mockReturnValueOnce([dirent('weather')] as never)
    mockRead.mockReturnValueOnce(
      JSON.stringify({ id: 'weather', name: 'Weather', description: 'Forecast lookups.' }) as never,
    )
    const community = loadConnectorRegistry().find((c) => c.id === 'weather')
    expect(community).toMatchObject({
      id: 'weather',
      category: 'community',
      oauth_required: false,
      enabled: true,
      auth_type: 'none',
    })
  })

  it('skips a connector dir whose connector.json is malformed JSON', () => {
    mockReaddir.mockReturnValueOnce([dirent('broken')] as never)
    mockRead.mockReturnValueOnce('not json at all' as never)
    expect(loadConnectorRegistry().some((c) => c.id === 'broken')).toBe(false)
  })

  it('skips a connector.json that fails schema validation', () => {
    mockReaddir.mockReturnValueOnce([dirent('partial')] as never)
    mockRead.mockReturnValueOnce(JSON.stringify({ id: 'partial' }) as never) // no name/description
    const registry = loadConnectorRegistry()
    expect(registry.some((c) => c.id === 'partial')).toBe(false)
    expect(registry.length).toBe(OFFICIAL_CONNECTORS.length)
  })

  it('falls back to official-only and stays quiet when brian-tools is absent (ENOENT)', () => {
    const warn = vi.spyOn(console, 'warn')
    mockReaddir.mockImplementationOnce(() => {
      const err = new Error('no such file') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    })
    expect(loadConnectorRegistry().length).toBe(OFFICIAL_CONNECTORS.length)
    // A missing community registry is the expected open-source default, not a
    // fault — it must not warn (only an info log).
    expect(warn).not.toHaveBeenCalled()
  })

  it('falls back to the official list and warns on a non-ENOENT read failure', () => {
    const warn = vi.spyOn(console, 'warn')
    mockReaddir.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied')
    })
    expect(loadConnectorRegistry().length).toBe(OFFICIAL_CONNECTORS.length)
    expect(warn).toHaveBeenCalled()
  })
})

describe('[COMP:api/connector-registry] ConnectorEntrySchema', () => {
  it('applies the documented defaults for omitted optional fields', () => {
    const parsed = ConnectorEntrySchema.parse({
      id: 'x',
      name: 'X',
      description: 'desc',
      category: 'official',
    })
    expect(parsed.auth_type).toBe('none')
    expect(parsed.oauth_required).toBe(false)
    expect(parsed.tags).toEqual([])
    expect(parsed.enabled).toBe(true)
  })

  it('every OFFICIAL_CONNECTORS row is schema-valid and has a unique id', () => {
    for (const entry of OFFICIAL_CONNECTORS) {
      expect(ConnectorEntrySchema.safeParse(entry).success).toBe(true)
    }
    const ids = OFFICIAL_CONNECTORS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
