import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * getTime tool — returns the current date and time.
 * No parameters required. The model can use this to answer
 * time-related questions without needing a web search.
 */
export const getTimeTool = buildTool({
  name: 'getTime',
  description: 'Get the current date and time. ALWAYS call this tool fresh every time the user asks about time, schedules, or deadlines — never reuse a previous result, because time has passed since then. Use the timezone from the User Context section of your system prompt. No web search needed.',
  inputSchema: z.object({
    timezone: z.string().optional().describe('IANA timezone (e.g. "Asia/Hong_Kong", "America/New_York"). Defaults to UTC.'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,

  async execute(input) {
    const tz = input.timezone ?? 'UTC'
    try {
      const now = new Date()
      const formatted = now.toLocaleString('en-US', {
        timeZone: tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      })
      return { data: formatted }
    } catch {
      return { data: `Invalid timezone "${tz}". Use IANA format like "Asia/Hong_Kong".`, isError: true }
    }
  },
})
