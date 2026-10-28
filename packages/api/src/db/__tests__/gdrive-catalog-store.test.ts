import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import {
  completeGDriveCatalogSync,
  configureGDriveCatalog,
  getGDriveCatalogReadPolicy,
  listGDriveCatalogArtifactsOutsideGeneration,
  listStaleGDriveCatalogArtifacts,
} from '../gdrive-catalog-store.js'

const mockQuery = vi.mocked(query)

describe('[COMP:integrations/gdrive-enrichment] Drive catalog store', () => {
  beforeEach(() => vi.clearAllMocks())

  it('starts a new scope generation and deactivates the previous snapshot together', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as never)
      .mockResolvedValueOnce({ rows: [{ generation: 'generation-2' }] } as never)

    const generation = await configureGDriveCatalog({
      actingUserId: 'user-1',
      workspaceId: 'ws-1',
      connectorInstanceId: 'ci-1',
      syncScope: 'selected_folders',
      selectedFolders: [{ id: 'folder-1', name: 'Company' }],
      estimatedFiles: 42,
    })

    expect(generation).toBe('generation-2')
    expect(mockQuery.mock.calls[1]?.[0]).toContain('deactivated AS')
    expect(mockQuery.mock.calls[1]?.[0]).toContain('SET active = false')
  })

  it('allows selected-folder reads only from active membership', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      sync_scope: 'selected_folders',
      status: 'done',
      selected_folders: [{ id: 'folder-1', name: 'Company' }],
      in_catalog: false,
    }] } as never)

    const result = await getGDriveCatalogReadPolicy({
      workspaceId: 'ws-1', connectorInstanceId: 'ci-1', externalFileId: 'outside-1',
    })
    expect(result.allowed).toBe(false)
    expect(mockQuery.mock.calls[0]?.[0]).toContain('c.active = true')
  })

  it('promotes the completed generation and removes stale membership atomically', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await completeGDriveCatalogSync({
      id: 'job-1', workspaceId: 'ws-1', connectorInstanceId: 'ci-1',
      generation: 'generation-2', filesSeen: 50, filesIndexed: 42,
    })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0]?.[0]).toContain('activated AS')
    expect(mockQuery.mock.calls[0]?.[0]).toContain('removed AS')
    expect(mockQuery.mock.calls[0]?.[0]).toContain("status = 'done'")
  })

  const selectors = [
    ['scope replacement', listGDriveCatalogArtifactsOutsideGeneration],
    ['recurring completion', listStaleGDriveCatalogArtifacts],
  ] as const

  it.each(selectors)('%s selects the exact scope and generation, retaining row order and duplicates', async (_name, select) => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { artifact_file_id: 'artifact-2' },
      { artifact_file_id: 'artifact-1' },
      { artifact_file_id: 'artifact-2' },
    ] } as never)
    const input = { workspaceId: 'workspace-fixture', connectorInstanceId: 'connector-fixture', generation: 'generation-7' }

    await expect(select(input)).resolves.toEqual(['artifact-2', 'artifact-1', 'artifact-2'])

    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery).toHaveBeenCalledWith(
      `SELECT artifact_file_id
       FROM gdrive_file_catalog
      WHERE workspace_id = $1 AND connector_instance_id = $2
        AND last_seen_generation <> $3 AND artifact_file_id IS NOT NULL`,
      ['workspace-fixture', 'connector-fixture', 'generation-7'],
    )
  })

  it.each(selectors)('%s returns an empty artifact list without inventing membership', async (_name, select) => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await expect(select({ workspaceId: 'workspace-fixture', connectorInstanceId: 'connector-fixture', generation: 'generation-7' })).resolves.toEqual([])
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it.each(selectors)('%s preserves a rejected query error', async (_name, select) => {
    const error = new Error('fictional catalog query failure')
    mockQuery.mockRejectedValueOnce(error)
    await expect(select({ workspaceId: 'workspace-fixture', connectorInstanceId: 'connector-fixture', generation: 'generation-7' })).rejects.toBe(error)
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

})
