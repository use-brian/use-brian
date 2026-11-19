/**
 * Resolve recording selections to workspace-owned blueprint rows before any
 * transcription is queued. The legacy wire name `blueprintSlug` is NOT an id.
 * Also used by synthesis to read jobs queued by older clients.
 * Spec: structural-synthesis.md -> Recording blueprint resolution.
 * [COMP:recordings/blueprint-resolution]
 */
import type { CustomPageTemplateSummary } from '@use-brian/core/doc/custom-template-types.js'
import type { PageTemplateStore } from '../db/page-templates-store.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const normalizeName = (value: string) => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ')

export class InvalidRecordingBlueprintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRecordingBlueprintError'
  }
}

export async function resolveRecordingBlueprint(
  store: Pick<PageTemplateStore, 'getById' | 'list'>,
  input: { userId: string; workspaceId: string; selection: string },
): Promise<CustomPageTemplateSummary> {
  const { userId, workspaceId } = input
  const selection = input.selection.trim()
  if (UUID.test(selection)) {
    const template = await store.getById(userId, selection)
    if (template?.workspaceId === workspaceId && template.extraction != null) return template
  } else if (selection) {
    const blueprints = (await store.list(userId, workspaceId)).filter(
      (template) => template.workspaceId === workspaceId && template.extraction != null,
    )
    const exact = blueprints.filter((template) => template.name.trim().toLowerCase() === selection.toLowerCase())
    const matches = exact.length > 0
      ? exact
      : blueprints.filter((template) => normalizeName(template.name) === normalizeName(selection))
    if (matches.length === 1) return matches[0]!
    if (matches.length > 1) {
      throw new InvalidRecordingBlueprintError(
        'The blueprint name is ambiguous. Use listBlueprints to choose the installed blueprint UUID, not its name.',
      )
    }
  }
  throw new InvalidRecordingBlueprintError(
    'The selected blueprint is not an accessible blueprint in this workspace. Use listBlueprints to get its installed UUID, or install it in Brain > Blueprints first. A starter catalog slug is not an installed blueprint id.',
  )
}
