import { describe, expect, it, vi } from 'vitest'
import type { OfficeArtifactRow } from '../../db/office-artifacts.js'
import { createOfficeService } from '../service.js'

const artifact: OfficeArtifactRow = {
  id: '10000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000002',
  family: 'document',
  mode: 'artifact',
  title: 'Beacon plan',
  creatorUserId: '10000000-0000-4000-8000-000000000003',
  ownerUserId: '10000000-0000-4000-8000-000000000003',
  templateVersionId: null,
  headVersionId: null,
  headVersion: 1,
  capabilityVersion: 1,
  sensitivity: 'internal',
  compartments: ['team:sales'],
  projectIds: ['10000000-0000-4000-8000-000000000004'],
  defaultWorkspaceRole: 'view',
  lifecycleState: 'active',
  updatedAt: new Date(0),
}

const access = {
  role: 'edit',
  canComment: true,
} as never

function service() {
  const createJob = vi.fn()
  const deps = {
    generationAvailable: vi.fn(() => true),
    createShell: vi.fn(),
    deleteEmptyShell: vi.fn(),
    getArtifact: vi.fn(async () => artifact),
    raiseScope: vi.fn(async () => true),
    resolveAccess: vi.fn(async () => access),
    createJob,
    latestJob: vi.fn(async () => null),
    getSnapshot: vi.fn(async () => null),
  }
  return { port: createOfficeService(deps as never), createJob }
}

describe('[COMP:brain/context-projection] Office turn-scope projection', () => {
  it('makes an out-of-Project id indistinguishable from an unknown artifact', async () => {
    const { port } = service()
    await expect(port.get({
      userId: artifact.ownerUserId,
      artifactId: artifact.id,
      clearance: 'confidential',
      compartmentGrant: ['team:sales'],
      projectGrant: ['10000000-0000-4000-8000-000000000099'],
    })).resolves.toBeNull()
  })

  it('requires every Team compartment and sensitivity tier before returning metadata', async () => {
    const { port } = service()
    await expect(port.get({
      userId: artifact.ownerUserId,
      artifactId: artifact.id,
      clearance: 'public',
      compartmentGrant: [],
      projectGrant: artifact.projectIds,
    })).resolves.toBeNull()
  })

  it('does not queue a revision when the active Project excludes the artifact', async () => {
    const { port, createJob } = service()
    await expect(port.revise({
      userId: artifact.ownerUserId,
      assistantId: '10000000-0000-4000-8000-000000000005',
      artifactId: artifact.id,
      instruction: 'Revise',
      targetIds: ['10000000-0000-4000-8000-000000000006'],
      expectedVersion: 1,
      idempotencyKey: 'revision-12345678',
      sensitivity: 'internal',
      compartments: artifact.compartments,
      projectIds: artifact.projectIds,
      clearance: 'confidential',
      compartmentGrant: artifact.compartments,
      projectGrant: [],
    })).resolves.toBeNull()
    expect(createJob).not.toHaveBeenCalled()
  })
})
