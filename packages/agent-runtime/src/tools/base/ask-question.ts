import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * askQuestion tool — used when the model needs to ask the user for clarification.
 * Returns the question text, which the query loop surfaces to the user.
 * The user's response comes as the next message in the conversation.
 */
export type AssistantQuestion = z.infer<typeof askQuestionSchema>

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1).describe('The question to ask the user'),
  allowCustom: z.boolean().optional().describe('Whether a typed answer outside the options is allowed; defaults to true'),
  actionId: z.string().min(1).max(256).optional(),
  version: z.union([z.string().max(256), z.number().int()]).optional(),
  context: z.string().max(8000).optional().describe('Authored context for this question, not execution authority'),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(8)
    .refine((labels) => new Set(labels).size === labels.length, 'Options must be distinct')
    .optional().describe('Optional single-choice suggestions; the user can also type an answer'),
})

export const askQuestionTool = buildTool({
  name: 'askQuestion',
  description: 'Ask the user a question when you need clarification before proceeding. Only use when the answer genuinely changes what you would do.',
  inputSchema: askQuestionSchema,
  isConcurrencySafe: true,
  isReadOnly: true,

  async execute(input) {
    // The question text is returned as the tool result.
    // The query loop will recognize this and include it in the response.
    return { data: `[Question for user]: ${input.question}` }
  },
})

/**
 * The question payload a suspended askQuestion carries to every boundary: the
 * pending-question hook, the direct stream frame, the resume point, the stored
 * approval and the pending read. A valid input is the parsed schema output.
 * Otherwise each schema field is kept only when it validates on its own, so an
 * invalid `options` list is dropped instead of becoming actionable choices.
 * Returns null without a valid question text. See
 * docs/architecture/engine/askquestion-suspend-resume.md → "Question payload contract".
 */
export function askQuestionPayload(input: unknown): AssistantQuestion | null {
  const parsed = askQuestionSchema.safeParse(input)
  if (parsed.success) return parsed.data
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const payload: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(askQuestionSchema.shape)) {
    if (raw[key] === undefined) continue
    const value = (field as z.ZodTypeAny).safeParse(raw[key])
    if (value.success && value.data !== undefined) payload[key] = value.data
  }
  return typeof payload.question === 'string' ? payload as AssistantQuestion : null
}

/** Every delivery surface can render this fallback; no interactive renderer is required. */
export function formatAssistantQuestion(question: AssistantQuestion): string {
  const options = question.options?.map((label, index) => `${index + 1}. ${label}`) ?? []
  return [question.question, ...options].join('\n')
}
