import { z } from 'zod'
import { buildTool } from '../types.js'
import { toolFailure } from '../tool-failure.js'

export type BugReportStore = {
  create(params: {
    assistantId: string
    userId: string
    sessionId?: string
    channelType: string
    channelId?: string
    title: string
    description?: string
    severity?: 'low' | 'medium' | 'high' | 'critical'
  }): Promise<{ id: string }>
}

export function createReportBugTool(store: BugReportStore) {
  return buildTool({
    name: 'reportBug',
    description: 'Report a bug or issue. Users trigger this with /bug or :bug followed by a description of what went wrong. Extract a short title and optional longer description from their message.',
    inputSchema: z.object({
      title: z.string().describe('Brief title summarizing the bug (under 100 chars)'),
      description: z.string().optional().describe('Detailed description of what happened, expected behavior, and steps to reproduce'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium').describe('Bug severity: low (cosmetic), medium (broken but workaround exists), high (blocks user), critical (data loss or security)'),
    }),
    isConcurrencySafe: true,
    isReadOnly: false,

    async execute(input, context) {
      let report: { id: string }
      try {
        report = await store.create({
          assistantId: context.assistantId,
          userId: context.userId,
          sessionId: context.sessionId,
          channelType: context.channelType,
          channelId: context.channelId,
          title: input.title,
          description: input.description,
          severity: input.severity,
        })
      } catch (err) {
        // A silently-lost bug report is worse than a visible one: the user
        // believes the team has been told. Say plainly that nothing was filed.
        return toolFailure(err, {
          tool: 'reportBug',
          action: 'Filing the bug report',
          target: `"${input.title}"`,
          mutating: true,
          next:
            'NOTHING was recorded and the team has not been told — do not tell the user their report was received. Repeat their report back to them and tell them to send it to support directly.',
        })
      }
      return {
        data: `Bug report filed (ID: ${report.id.slice(0, 8)}). Thank the user for reporting and let them know the team will look into it.`,
      }
    },
  })
}
