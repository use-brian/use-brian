/** Published library reads bind the registry and immutable version. [COMP:app-web/office-published-template] */
import type { OfficeTemplateBundle } from '@use-brian/office-model'
import type { OfficeOutputScope } from './file-binding.js'

export function createPublishedOfficeTemplateReader(deps: {
  getTemplate(userId: string, templateId: string): Promise<{ workspaceId: string; lifecycleState: string } | null>
  getVersion(userId: string, versionId: string): Promise<{ templateId: string; workspaceId: string; status: string } | null>
  readBundle(userId: string, workspaceId: string, versionId: string, onSource: (scope: OfficeOutputScope, revision: string) => void): Promise<OfficeTemplateBundle | null>
}) {
  return async (userId: string, templateId: string, versionId: string) => {
    const template = await deps.getTemplate(userId, templateId)
    const version = await deps.getVersion(userId, versionId)
    if (!template || template.lifecycleState !== 'admitted' || !version || version.templateId !== templateId || version.workspaceId !== template.workspaceId || version.status !== 'admitted') return null
    const sources: Array<{ scope: OfficeOutputScope; revision: string }> = []
    const bundle = await deps.readBundle(userId, template.workspaceId, versionId, (scope, revision) => { sources.push({ scope, revision }) })
    const source = sources[0]
    return bundle && source ? { bundle, ...source } : null
  }
}
