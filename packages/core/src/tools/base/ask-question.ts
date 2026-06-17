import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * askQuestion tool — used when the model needs to ask the user for clarification.
 * Returns the question text, which the query loop surfaces to the user.
 * The user's response comes as the next message in the conversation.
 */
export const askQuestionTool = buildTool({
  name: 'askQuestion',
  description: 'Ask the user a question when you need clarification before proceeding. Only use when the answer genuinely changes what you would do.',
  inputSchema: z.object({
    question: z.string().describe('The question to ask the user'),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,

  async execute(input) {
    // The question text is returned as the tool result.
    // The query loop will recognize this and include it in the response.
    return { data: `[Question for user]: ${input.question}` }
  },
})
