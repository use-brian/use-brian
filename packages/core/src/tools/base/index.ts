import type { Tool } from '../types.js'
import type { EnginesEnv } from '../../engines/ask-engines.js'
import { urlReaderTool } from './url-reader.js'
import { webSearchTool } from './web-search.js'
import { xSearchTool } from './x-search.js'
import { askQuestionTool } from './ask-question.js'
import { createTaskTool, updateTaskTool, _getSessionTasksSize } from './tasks.js'
import { getTimeTool } from './get-time.js'
import { createEngineBaseTools } from './ask-engines.js'

export {
  urlReaderTool,
  webSearchTool,
  askQuestionTool,
  createTaskTool,
  updateTaskTool,
  getTimeTool,
  createEngineBaseTools,
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
 *
 * The engine observation tools (`askOpenAI` / `askGemini` / `askPerplexity` /
 * `askClaude` / `searchConsoleQuery`) follow the same fail-closed rule, one
 * `ENGINES_*` credential at a time. `enginesEnv` is threaded rather than read
 * globally only so tests can pin it; production passes nothing and gets
 * `process.env`, exactly as `xSearch` does. See
 * docs/architecture/integrations/engines-mcp.md.
 */
export function createBaseTools(enginesEnv: EnginesEnv = process.env as EnginesEnv): Map<string, Tool> {
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

  tools.push(...createEngineBaseTools(enginesEnv))

  return new Map(tools.map((t) => [t.name, t]))
}
