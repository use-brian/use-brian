import type { Tool } from '../types.js'
import { urlReaderTool } from './url-reader.js'
import { webSearchTool } from './web-search.js'
import { xSearchTool } from './x-search.js'
import { askQuestionTool } from './ask-question.js'
import { createTaskTool, updateTaskTool, _getSessionTasksSize } from './tasks.js'
import { getTimeTool } from './get-time.js'
export { createReportBugTool } from './report-bug.js'
export type { BugReportStore } from './report-bug.js'
export { createConfirmRecordingProcessingTool } from './confirm-recording-processing.js'
export type { ConfirmRecordingProcessingDeps } from './confirm-recording-processing.js'

export {
  urlReaderTool,
  webSearchTool,
  xSearchTool,
  askQuestionTool,
  createTaskTool,
  updateTaskTool,
  getTimeTool,
  _getSessionTasksSize,
}

/**
 * Create a Map of all base tools for use with the query loop.
 *
 * `webSearch` + `urlReader` together implement the explicit search → fetch
 * → cite loop. When these tools are passed to the provider, Gemini's
 * passive Google Search grounding is gated off (see providers/gemini.ts) —
 * the model drives the full loop via tool calls instead. See
 * docs/architecture/integrations/search-and-fetch.md.
 *
 * `xSearch` (Grok) is registered only when `XAI_API_KEY` is set — fail-closed.
 * See docs/architecture/integrations/xai.md.
 */
export function createBaseTools(): Map<string, Tool> {
  const tools: Tool[] = [
    webSearchTool,
    urlReaderTool,
    askQuestionTool,
    createTaskTool,
    updateTaskTool,
    getTimeTool,
  ]

  if (process.env.XAI_API_KEY) {
    tools.push(xSearchTool)
  }

  return new Map(tools.map((t) => [t.name, t]))
}
