/** Immutable Office source bindings and high-water output classification.
 * [COMP:api/office-resources] */
import { createHash } from 'node:crypto'
import type { WorkspaceFile } from '@use-brian/core'

export type OfficeFileBinding = {
  fileId: string
  workspaceId: string
  scopeVersion: string
  mime: string
  hash: string
  sensitivity: 'public' | 'internal' | 'confidential'
  compartments: string[]
  projectIds: string[]
}

export type OfficeOutputScope = Pick<OfficeFileBinding, 'sensitivity' | 'compartments' | 'projectIds'>

const sensitivityRank = { public: 0, internal: 1, confidential: 2 } as const
const sorted = (values: readonly string[] | null | undefined) => [...new Set(values ?? [])].sort()

export function bindOfficeFile(file: WorkspaceFile, bytes: Uint8Array): OfficeFileBinding {
  return {
    fileId: file.id,
    workspaceId: file.workspaceId,
    scopeVersion: file.scopeVersion ?? '',
    mime: file.mime,
    hash: createHash('sha256').update(bytes).digest('hex'),
    sensitivity: file.sensitivity,
    compartments: sorted(file.compartments),
    projectIds: sorted(file.projectIds),
  }
}

export function officeFileBindingRevision(binding: OfficeFileBinding): string {
  return JSON.stringify([
    binding.fileId,
    binding.workspaceId,
    binding.scopeVersion,
    binding.mime,
    binding.hash,
    binding.sensitivity,
    sorted(binding.compartments),
    sorted(binding.projectIds),
  ])
}

export function sameOfficeFileBinding(left: OfficeFileBinding, right: OfficeFileBinding): boolean {
  return officeFileBindingRevision(left) === officeFileBindingRevision(right)
}

export function classifyOfficeOutput(...sources: Array<OfficeOutputScope | null | undefined>): OfficeOutputScope {
  let sensitivity: OfficeOutputScope['sensitivity'] = 'public'
  const compartments: string[] = []
  const projectIds: string[] = []
  for (const source of sources) {
    if (!source) continue
    if (sensitivityRank[source.sensitivity] > sensitivityRank[sensitivity]) sensitivity = source.sensitivity
    compartments.push(...(source.compartments ?? []))
    projectIds.push(...(source.projectIds ?? []))
  }
  return { sensitivity, compartments: sorted(compartments), projectIds: sorted(projectIds) }
}

export function officeOutputScopeRevision(scope: OfficeOutputScope): string {
  return JSON.stringify([scope.sensitivity, sorted(scope.compartments), sorted(scope.projectIds)])
}

export function officeScopePathSegment(scope: OfficeOutputScope): string {
  return createHash('sha256').update(officeOutputScopeRevision(scope)).digest('hex').slice(0, 24)
}

export function fileMatchesOfficeOutput(file: WorkspaceFile, bytes: Uint8Array, expected: { hash: string; mime: string; scope: OfficeOutputScope }): boolean {
  return file.mime === expected.mime &&
    createHash('sha256').update(bytes).digest('hex') === expected.hash &&
    officeOutputScopeRevision({
      sensitivity: file.sensitivity,
      compartments: file.compartments ?? [],
      projectIds: file.projectIds ?? [],
    }) === officeOutputScopeRevision(expected.scope)
}
