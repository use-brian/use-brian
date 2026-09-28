/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/dictionaries/en'
import { attachOfficeMetadata } from '@/lib/office/metadata'
import type { OfficeArtifact, OfficeReleaseReceipt } from '@/lib/office/api'
import { OfficeReview } from '../office-review'
import { documentFixture } from './editor-fixtures'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const state = vi.hoisted(() => ({
  viewer: 'viewer-a',
  review: vi.fn(),
  release: vi.fn(),
  read: vi.fn(),
}))

vi.mock('@/lib/user', () => ({ getUserInfo: () => ({ id: state.viewer }) }))
vi.mock('@/lib/workspace-context', () => ({ useOptionalWorkspaceContext: () => ({ workspaceId: 'workspace-a', me: { id: state.viewer } }) }))
vi.mock('@/lib/office/api', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/office/api')>(),
  reviewOfficeRelease: (...args: unknown[]) => state.review(...args),
  releaseOfficeArtifact: (...args: unknown[]) => state.release(...args),
  readOfficeReleasedFile: (...args: unknown[]) => state.read(...args),
  requestOfficeOfflinePackage: vi.fn(),
  transitionOfficeLifecycle: vi.fn(),
}))

const receipt: OfficeReleaseReceipt = { status: 'ready', version: 2, action: 'export', blocks: [], warnings: [], acknowledgedCodes: [] }
const artifact = (artifactId = 'artifact-a'): OfficeArtifact => ({ artifactId, family: 'document', title: 'Department report', version: 2, lifecycleState: 'active', role: 'edit' })
const protectedValue = <T extends object>(value: T) => attachOfficeMetadata(value, 30_000, performance.now(), state.viewer)

describe('[COMP:app-web/office-iteration-panel] protected Office output retention', () => {
  let host: HTMLDivElement
  let root: Root
  let revoke: ReturnType<typeof vi.fn>

  const render = (subject = artifact()) => act(() => root.render(
    <I18nProvider locale="en" dict={en}>
      <OfficeReview artifact={subject} artifactId={subject.artifactId} workspaceId="workspace-a" snapshot={{ ...documentFixture(), artifactId: subject.artifactId, workspaceId: 'workspace-a' }} selectedObjectIds={[]} onLifecycle={() => undefined} />
    </I18nProvider>,
  ))

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    state.viewer = 'viewer-a'
    state.review.mockReset()
    state.release.mockReset()
    state.read.mockReset()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:protected-office-output'),
      revokeObjectURL: revoke = vi.fn(),
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it('revokes a preview and removes its protected projection on focus re-entry', async () => {
    state.review.mockResolvedValue(protectedValue({ ...receipt }))
    state.release.mockResolvedValue(protectedValue({ releaseId: 'release-a', fileId: 'file-a', receipt }))
    state.read.mockResolvedValue(protectedValue(new Blob(['pdf'], { type: 'application/pdf' })))
    render()
    const preview = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === en.office.previewDocumentPdf)!
    await act(async () => { preview.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(host.querySelector('iframe')?.getAttribute('src')).toBe('blob:protected-office-output')
    act(() => window.dispatchEvent(new Event('focus')))
    expect(host.querySelector('iframe')).toBeNull()
    expect(revoke).toHaveBeenCalledWith('blob:protected-office-output')
  })

  it('discards a late review after the mounted artifact owner changes', async () => {
    let resolveReview!: (value: OfficeReleaseReceipt) => void
    state.review.mockImplementation(() => new Promise(resolve => { resolveReview = resolve }))
    render()
    const download = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === en.office.downloadFile)!
    act(() => download.click())
    render(artifact('artifact-b'))
    await act(async () => resolveReview(protectedValue({ ...receipt })))
    expect(state.release).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain(en.office.releaseReady)
  })
})
