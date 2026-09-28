import { describe, expect, it } from 'vitest'
import type { WorkspaceFile } from '@use-brian/core'
import {
  bindOfficeFile,
  classifyOfficeOutput,
  fileMatchesOfficeOutput,
  officeOutputScopeRevision,
  sameOfficeFileBinding,
} from '../file-binding.js'

function file(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    workspaceId: '10000000-0000-4000-8000-000000000002',
    path: '/office/fixture.bin',
    parentPath: '/office',
    name: 'fixture.bin',
    title: null,
    summary: null,
    mime: 'application/octet-stream',
    sizeBytes: 3,
    tags: [],
    relatedIds: [],
    storageUri: 'memory://fixture',
    sensitivity: 'internal',
    compartments: ['finance', 'legal'],
    projectIds: ['project-b', 'project-a'],
    metadata: {},
    userId: null,
    assistantId: null,
    source: 'office',
    sourceEpisodeId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date(0),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    createdByUserId: null,
    createdByAssistantId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scopeVersion: '7',
    ...overrides,
  }
}

describe('[COMP:api/office-resources] Office file binding and output classification', () => {
  it('binds bytes, MIME, scope revision, and normalized department/project labels', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const binding = bindOfficeFile(file(), bytes)
    expect(binding).toMatchObject({
      scopeVersion: '7',
      mime: 'application/octet-stream',
      sensitivity: 'internal',
      compartments: ['finance', 'legal'],
      projectIds: ['project-a', 'project-b'],
    })
    expect(sameOfficeFileBinding(binding, { ...binding, compartments: ['legal', 'finance'] })).toBe(true)
    expect(sameOfficeFileBinding(binding, { ...binding, scopeVersion: '8' })).toBe(false)
    expect(sameOfficeFileBinding(binding, { ...binding, hash: 'changed' })).toBe(false)
  })

  it('classifies output at the union and highest sensitivity of every admitted input', () => {
    const scope = classifyOfficeOutput(
      { sensitivity: 'public', compartments: ['sales'], projectIds: ['project-a'] },
      { sensitivity: 'confidential', compartments: ['finance', 'sales'], projectIds: ['project-b'] },
      { sensitivity: 'internal', compartments: ['legal'], projectIds: [] },
    )
    expect(scope).toEqual({
      sensitivity: 'confidential',
      compartments: ['finance', 'legal', 'sales'],
      projectIds: ['project-a', 'project-b'],
    })
    expect(officeOutputScopeRevision(scope)).toBe(officeOutputScopeRevision({
      sensitivity: 'confidential',
      compartments: ['sales', 'finance', 'legal'],
      projectIds: ['project-b', 'project-a'],
    }))
  })

  it('permits same-byte reuse only when hash, MIME, and full scope all match', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const expected = {
      hash: bindOfficeFile(file(), bytes).hash,
      mime: 'application/octet-stream',
      scope: { sensitivity: 'internal' as const, compartments: ['finance', 'legal'], projectIds: ['project-a', 'project-b'] },
    }
    expect(fileMatchesOfficeOutput(file(), bytes, expected)).toBe(true)
    expect(fileMatchesOfficeOutput(file({ mime: 'text/plain' }), bytes, expected)).toBe(false)
    expect(fileMatchesOfficeOutput(file({ compartments: ['finance'] }), bytes, expected)).toBe(false)
    expect(fileMatchesOfficeOutput(file(), new Uint8Array([1, 2, 4]), expected)).toBe(false)
  })
})
