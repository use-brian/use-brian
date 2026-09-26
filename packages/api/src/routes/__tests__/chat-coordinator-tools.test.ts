import { describe, expect, it } from 'vitest'
import { createPlanTools, type PlanStore, filterToolsByCapabilities, type Tool } from '@use-brian/core'
import { createStructuredDocumentTools } from '../../structured-documents/tools.js'
import type { StructuredDocumentService } from '../../structured-documents/service.js'
import { filterCoordinatorTools } from '../chat-coordinator-tools.js'

const nativeNames = [
  'listDocumentExtractionConnectors', 'prepareDocumentExtraction',
  'startDocumentExtraction', 'readDocumentExtraction', 'proposeOfficeEvidenceFill',
]
const planNames = ['setPlan', 'updatePlanStep', 'abandonPlan']
const supportNames = ['saveFileToBrain', 'fileSearch', 'getOfficeArtifact']
const disallowed = ['webSearch', 'urlReader', 'mcpSearch', 'mcpCall', 'mcp__ocr__extract',
  'fileRead', 'fileWrite', 'fileAppend', 'fileDelete', 'fileSetMeta', 'sendFile',
  'createOfficeArtifact', 'reviseOfficeArtifact', 'runWorkflow', 'createTask']
function tools() {
  const native = createStructuredDocumentTools({
    service: {} as StructuredDocumentService,
    resolvePolicy: async () => 'ask',
  })
  const result = new Map(native.map(tool => [tool.name, tool]))
  for (const name of [...supportNames, ...disallowed, 'spawnWorker', 'saveMemory', 'delegateDocEdit', 'saveContact']) {
    result.set(name, { name, isReadOnly: ['getOfficeArtifact', 'fileSearch'].includes(name), requiresCapability: supportNames.includes(name)
      ? name === 'getOfficeArtifact' ? 'office' : 'files' : undefined } as Tool)
  }
  for (const tool of Object.values(createPlanTools({} as PlanStore))) result.set(tool.name, tool)
  return result
}
const mode = { coordinatorMode: true, researchMode: false, hasPreflightContext: false }

describe('chat coordinator tool admission', () => {
  it.each([false, true])('retains native workflow but not general execution tools (research=%s)', researchMode => {
    const input = tools()
    const admitted = filterToolsByCapabilities(input, new Set(['files', 'office', 'crm', 'home_app:office:read', 'home_app:office:write']))
    const output = filterCoordinatorTools(admitted, { ...mode, researchMode })
    for (const name of [...nativeNames, ...supportNames, ...planNames, 'spawnWorker', 'saveMemory', 'delegateDocEdit']) {
      // Keep the actual tool object, including its policy/confirmation hooks.
      expect(output.get(name), name).toBe(input.get(name))
    }
    for (const name of disallowed) expect(output.has(name), name).toBe(false)
    expect(output.has('saveContact')).toBe(researchMode)
    expect(input.size).toBe(tools().size)
  })

  it.each([{ grants: [] }, { grants: ['files'] }, { grants: ['office'] }])('cannot restore capability-denied tools (grants=$grants)', ({ grants }) => {
    const admitted = filterToolsByCapabilities(tools(), new Set(grants))
    const output = filterCoordinatorTools(admitted, mode)
    for (const name of [...nativeNames, ...supportNames]) {
      expect(output.has(name), name).toBe(admitted.has(name))
    }
    if (!grants.includes('files')) {
      for (const name of nativeNames.slice(0, 4)) expect(output.has(name)).toBe(false)
      expect(output.has('saveFileToBrain')).toBe(false)
      expect(output.has('fileSearch')).toBe(false)
    }
    if (!grants.includes('office')) expect(output.has('proposeOfficeEvidenceFill')).toBe(false)
  })

  it.each(['hidden', 'denied', 'removed'])('does not restore %s plan tools', kind => {
    const input = tools()
    for (const name of planNames) {
      if (kind === 'hidden') input.get(name)!.hiddenFromModel = true
      if (kind === 'denied') input.get(name)!.requiresCapability = 'plan-test-grant'
      if (kind === 'removed') input.delete(name)
    }
    const output = filterCoordinatorTools(filterToolsByCapabilities(input, new Set()), mode)
    for (const name of planNames) expect(output.has(name)).toBe(false)
  })

  it('preserves Office read/write governance independently of the Office capability', () => {
    const output = filterCoordinatorTools(filterToolsByCapabilities(tools(),
      new Set(['files', 'office', 'home_app:office:read'])), mode)
    expect(output.has('getOfficeArtifact')).toBe(true)
    expect(output.has('proposeOfficeEvidenceFill')).toBe(false)
    expect(output.has('startDocumentExtraction')).toBe(true)
  })

  it('does not restore hidden or previously surface-filtered tools', () => {
    const input = tools()
    input.get('startDocumentExtraction')!.hiddenFromModel = true
    input.delete('proposeOfficeEvidenceFill')
    const admitted = filterToolsByCapabilities(input, new Set(['files', 'office']))
    const output = filterCoordinatorTools(admitted, { ...mode, researchMode: true })
    expect(output.has('startDocumentExtraction')).toBe(false)
    expect(output.has('proposeOfficeEvidenceFill')).toBe(false)
    expect(filterCoordinatorTools(new Map(), mode).size).toBe(0)
  })

  it('leaves direct mode unchanged, including tools forbidden to the coordinator', () => {
    const input = tools()
    expect(filterCoordinatorTools(input, { ...mode, coordinatorMode: false })).toBe(input)
  })

  it('preserves the direct post-preflight filter: only web search and URL reader are removed', () => {
    const input = tools()
    const output = filterCoordinatorTools(input, { ...mode, coordinatorMode: false, hasPreflightContext: true })
    expect([...output]).toEqual([...input].filter(([name]) => !['webSearch', 'urlReader'].includes(name)))
  })
})
