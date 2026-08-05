import { OfficeArtifactSnapshotSchema, type OfficeArtifactSnapshot, type OfficeFamily } from './model.js'

export type OfficeCapabilityDisposition = 'editable' | 'converted' | 'rejected'
export type OfficeCapabilityImplementation = {
  schema: string
  command: string
  editor: string
  preview: string
  importer: string
  exporter: string
  reparse: string
  accessibility: string
  offline: string
}
export type OfficeCapability = {
  id: string
  family: OfficeFamily | 'shared'
  disposition: OfficeCapabilityDisposition
  implementation?: OfficeCapabilityImplementation
  reason?: string
}

const implemented = (id: string, family: OfficeFamily | 'shared'): OfficeCapability => ({
  id,
  family,
  disposition: 'editable',
  implementation: {
    schema: `model:${id}`,
    command: `command:${id}`,
    editor: `editor:${id}`,
    preview: `renderer:${id}`,
    importer: `import:${id}`,
    exporter: `export:${id}`,
    reparse: `reparse:${id}`,
    accessibility: `a11y:${id}`,
    offline: `offline:${id}`,
  },
})

const rejected = (id: string, family: OfficeFamily | 'shared', reason: string): OfficeCapability => ({
  id,
  family,
  disposition: 'rejected',
  reason,
})

/** The one versioned capability authority consumed by every Office path. */
export const officeCapabilityManifest = {
  version: 1,
  capabilities: [
    implemented('richText', 'shared'), implemented('hyperlink', 'shared'), implemented('table', 'shared'),
    implemented('image', 'shared'), implemented('chart', 'shared'), implemented('video', 'shared'),
    implemented('namedStyles', 'document'), implemented('heading', 'document'), implemented('nestedList', 'document'),
    implemented('pageSetup', 'document'), implemented('pageBreak', 'document'), implemented('sectionBreak', 'document'),
    implemented('headerFooter', 'document'), implemented('pageNumber', 'document'),
    implemented('theme', 'presentation'), implemented('master', 'presentation'), implemented('layout', 'presentation'),
    implemented('placeholder', 'presentation'), implemented('textBox', 'presentation'), implemented('basicShape', 'presentation'),
    implemented('connector', 'presentation'), implemented('zOrder', 'presentation'), implemented('speakerNotes', 'presentation'),
    implemented('slideReorder', 'presentation'),
    rejected('macro', 'shared', 'Macros and executable package content are not supported'),
    rejected('externalRelationship', 'shared', 'External data/media relationships are not fetched or preserved'),
    rejected('animation', 'presentation', 'Animations, transitions, and timing trees are not supported'),
    rejected('audio', 'shared', 'Audio is outside the v1 media contract'),
    rejected('smartArt', 'shared', 'SmartArt is not in the admitted object vocabulary'),
    rejected('wordArt', 'shared', 'WordArt is not in the admitted object vocabulary'),
    rejected('equation', 'shared', 'Equations are not in the admitted object vocabulary'),
    rejected('ink', 'shared', 'Ink is not in the admitted object vocabulary'),
    rejected('threeDimensional', 'shared', '3-D objects and effects are not supported'),
    rejected('floatingWordObject', 'document', 'Documents support inline objects only'),
    rejected('nestedTable', 'document', 'Nested document tables are not supported'),
    rejected('trackedChanges', 'document', 'Imported Office tracked changes are not supported'),
    rejected('hiddenSlide', 'presentation', 'Hidden slides and custom shows are not supported'),
    rejected('embeddedWorksheet', 'presentation', 'Embedded worksheets and linked charts are not supported'),
  ] satisfies OfficeCapability[],
} as const

export type OfficePreflightDiagnostic = {
  severity: 'error' | 'warning'
  code: string
  path: string
  message: string
  capabilityId?: string
}
export type OfficePreflightResult = {
  ok: boolean
  diagnostics: OfficePreflightDiagnostic[]
  snapshot?: OfficeArtifactSnapshot
}

export function validateOfficeCapabilityManifest(): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const capability of officeCapabilityManifest.capabilities) {
    if (ids.has(capability.id)) errors.push(`Duplicate capability: ${capability.id}`)
    ids.add(capability.id)
    if (capability.disposition === 'editable') {
      const implementation = capability.implementation
      if (!implementation || Object.values(implementation).some((value) => !value)) errors.push(`Editable capability ${capability.id} is missing an implementation path`)
    } else if (!capability.reason) {
      errors.push(`Rejected capability ${capability.id} has no remediation reason`)
    }
  }
  return errors
}

export function preflightOfficeCandidate(input: unknown): OfficePreflightResult {
  const parsed = OfficeArtifactSnapshotSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      diagnostics: parsed.error.issues.map((issue) => ({
        severity: 'error',
        code: 'model.invalid',
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }

  const diagnostics: OfficePreflightDiagnostic[] = []
  const snapshot = parsed.data
  const resourceIds = new Set(snapshot.resources.map((resource) => resource.id))
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value)) {
      const object = value as Record<string, unknown>
      if ((object.kind === 'image' || object.kind === 'video') && typeof object.resourceId === 'string' && !resourceIds.has(object.resourceId)) {
        diagnostics.push({ severity: 'error', code: 'resource.missing', path, message: `Referenced resource ${object.resourceId} is missing` })
      }
      if (object.kind === 'image' && typeof object.resourceId === 'string' && object.decorative !== true && !object.altText) {
        diagnostics.push({ severity: 'error', code: 'accessibility.alt_text', path, message: 'Non-decorative images require alt text', capabilityId: 'image' })
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key)
  }
  visit(snapshot, '')
  return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), diagnostics, snapshot }
}
