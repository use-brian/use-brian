/**
 * Provider `describe()` derivation (M3 WP3): official families describe the
 * tools their core factories actually build (over inert ports), with JSON
 * Schema, so a search hit needs no activation and the hosted drift sweep can
 * compare the real runtime surface with `OFFICIAL_CONNECTOR_TOOLS`.
 */
import { describe, expect, it } from 'vitest'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import { PROVIDER_MODULES } from '../providers/index.js'
import { staticNativeDescriptorRecords } from '../descriptors.js'
import { inertPort } from '../providers/describe.js'

const described = Object.values(PROVIDER_MODULES).flatMap((provider) => provider.describe())
const byConnector = (connectorId: string) => described.filter((descriptor) => descriptor.connectorId === connectorId).map((d) => d.name)

describe('[COMP:api/mcp-catalog] provider describe() derivation', () => {
  it('describes every registry connector with tools, reporting unregistered built tools as drift', () => {
    for (const [connectorId, rows] of Object.entries(OFFICIAL_CONNECTOR_TOOLS)) {
      if (rows.length === 0 || connectorId === 'files' || !byConnector(connectorId).length) continue
      const built = new Set(byConnector(connectorId))
      const registered = new Set(rows.map((row) => row.name))
      expect([...built].filter((name) => registered.has(name)).length, connectorId).toBeGreaterThan(0)
    }
    // The one silent-invisible built tool the drift sweep must keep reporting.
    expect(byConnector('gdrive')).toContain('findGDriveFiles')
    expect((OFFICIAL_CONNECTOR_TOOLS.gdrive ?? []).some((row) => row.name === 'findGDriveFiles')).toBe(false)
  })

  it('describes each built tool with its own model-facing description', () => {
    const github = PROVIDER_MODULES.github.describe().find((descriptor) => descriptor.name === 'githubCreateIssue')!
    const registry = (OFFICIAL_CONNECTOR_TOOLS.github ?? []).find((row) => row.name === 'githubCreateIssue')!
    expect(github.description).toContain('Approve/Deny')
    expect(github.classification).toBe(registry.classification)
  })

  it('carries a JSON Schema for every static descriptor and never touches a port', () => {
    for (const descriptor of described) {
      expect(descriptor.origin).toBe('static')
      expect(descriptor.inputSchema.kind).toBe('static')
      expect(descriptor.inputSchema.schema, descriptor.name).toMatchObject({ type: 'object' })
    }
  })

  it('memoizes describe() per process and feeds the catalog records', () => {
    expect(PROVIDER_MODULES.github.describe()).toBe(PROVIDER_MODULES.github.describe())
    const records = staticNativeDescriptorRecords(Object.values(PROVIDER_MODULES))
    const github = records.find((record) => record.connectorId === 'github')!
    expect(github.tools.find((tool) => tool.name === 'githubCreateIssue')?.inputSchema.schema).toMatchObject({ required: expect.arrayContaining(['owner', 'repo']) })
  })

  it('makes inert ports refuse every call', () => {
    const port = inertPort<{ client: { send(): void } }>('fixture')
    expect(() => port.client.send()).toThrow(/inert/)
  })
})
