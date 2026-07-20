/**
 * `generateSkillDraft` — turn a skill-drafting CONVERSATION into a revised
 * workspace-skill draft (or a plain reply when the user asked a question /
 * the agent needs an answer before it can draft).
 *
 * The agent follows the `skill-builder` builtin skill (D3 of
 * `docs/plans/brain-skill-management-ux.md`, as amended for conversational
 * iteration): the drafting METHODOLOGY lives in that skill's markdown and is
 * embedded into the system prompt here, so improving how skills get drafted
 * is itself a skill edit, not a code change. This module adds only the wire
 * discipline around it: the brain context, the transcript → message
 * assembly, the live `currentDraft` hand-edit contract, and the strict JSON
 * output union.
 *
 * Two execution paths:
 *   - plain turn   — one stateless `provider.stream()` call
 *     (`collectStream`), the `theme-generator.ts` shape.
 *   - research turn — a small constrained `queryLoop` armed with ONLY
 *     `webSearch` + `urlReader` (the `home/refresh.ts` harness pattern:
 *     synthetic ToolContext, tight `maxTurns`, drain events, parse the final
 *     turn's text). Deliberately NOT the deep-research coordinator and not
 *     quota-metered like chat research — the route bounds it with its own
 *     rate limiter instead.
 *
 * Pure orchestration: no DB, no Express — the route (`routes/skills.ts` →
 * POST /draft) resolves the context, template, attachments, model tier and
 * maps {@link SkillDraftError} to a 422.
 *
 * [COMP:skills/draft-generator]
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  collectStream,
  queryLoop,
  webSearchTool,
  urlReaderTool,
  extractionSpecSchema,
  type ContentBlock,
  type ExtractionSpec,
  type LLMProvider,
  type Message,
  type TokenUsage,
  type Tool,
} from '@use-brian/core'

/** The model couldn't produce a usable draft or reply. */
export class SkillDraftError extends Error {
  constructor(message = 'Could not draft a skill from that description') {
    super(message)
    this.name = 'SkillDraftError'
  }
}

/** Fallback when the route doesn't resolve a tier — real procedural
 *  writing, not just extraction. */
const DRAFT_MODEL = 'gemini-flash'

/** Transcript caps — the route validates looser ones; these are the
 *  authoritative backstops (stateless endpoint: the client resends the
 *  whole conversation every turn). */
const MAX_TRANSCRIPT_MESSAGES = 12
const MAX_TRANSCRIPT_CHARS = 16_000
/** Cap on the template body embedded in the grounding section. */
const MAX_TEMPLATE_CHARS = 8000

/** Research-turn loop budget — grounding lookups, not deep research. */
const RESEARCH_MAX_TURNS = 4
const RESEARCH_MAX_TOOL_CALLS = 8
const RESEARCH_TIMEOUT_MS = 60_000

/** Workspace grounding pulled by `draft-context.ts` (plan §3.2: memories,
 *  entity vocabulary, existing-skill voice). All strings are pre-truncated. */
export type SkillDraftContext = {
  memories: string[]
  entities: string[]
  existingSkills: Array<{ name: string; whenToUse: string | null }>
}

export type SkillDraftTemplate = {
  name: string
  whenToUse?: string | null
  content: string
}

/** One transcript entry, oldest first; the last entry must be `user`. */
export type SkillDraftTurn = { role: 'user' | 'assistant'; content: string }

/** The live document state — client-authoritative, INCLUDING the user's own
 *  hand edits between turns. The agent revises from this, never from its own
 *  last output. */
export type SkillDraftFields = {
  name: string
  description: string
  whenToUse: string
  content: string
  sensitivity: 'public' | 'internal' | 'confidential'
  /** Structural-synthesis Phase 2: when the skill produces a structured artifact,
   *  its output shape lives here as a blueprint spec (not baked into `content`);
   *  the save path mints + links a `workspace_page_templates` blueprint from it. */
  extraction?: ExtractionSpec
}

/** Attachment payload for the latest user message, pre-built by the route
 *  from the file cache (the chat route's block-building pattern). */
export type SkillDraftAttachments = {
  /** Inline media blocks (`image/*` or `application/pdf` as base64). */
  blocks: ContentBlock[]
  /** `<attached_file>` text envelopes (inlined text files + media stubs). */
  textParts: string[]
}

export type SkillDraftResult =
  | { kind: 'draft'; draft: SkillDraftFields; message: string; usage: TokenUsage | null }
  | { kind: 'reply'; message: string; usage: TokenUsage | null }

// The model returns exactly one of these two JSON shapes. `message` rides
// the draft so the chat rail can narrate the change; it's optional there
// (the client falls back to localized copy when absent).
const draftSchema = z.object({
  action: z.literal('draft'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(250),
  whenToUse: z.string().trim().min(1).max(500),
  content: z.string().trim().min(1).max(5000),
  sensitivity: z.enum(['public', 'internal', 'confidential']),
  message: z.string().trim().max(600).optional(),
  // Structural-synthesis Phase 2: when the skill's job is to produce a STRUCTURED
  // artifact (a doc/report/brief with defined sections), the model emits the
  // output shape HERE as a blueprint extraction spec instead of baking format
  // prose into `content`; on save the API mints + links a blueprint from it.
  extraction: extractionSpecSchema.optional(),
})
const replySchema = z.object({
  action: z.literal('reply'),
  message: z.string().trim().min(1).max(2000),
})
const outputSchema = z.union([draftSchema, replySchema])

function systemPrompt(builderSkill: string, research: boolean): string {
  const researchRule = research
    ? `\n- Web grounding is ON for this turn: use webSearch (and urlReader on the most relevant results) to ground the procedure in current facts or best practice the user asked about, THEN return the JSON contract as your final message. Do not put raw URLs in the skill body unless the user asked for sources.`
    : ''
  return `You help a team author one workspace skill through a short conversation. A skill is a named, reusable procedure for the team's AI assistants; a human reviews and saves the final draft — never assume it activates as-is.

Follow this methodology exactly:

<methodology>
${builderSkill.trim() || '(methodology unavailable — apply the rules below conservatively)'}
</methodology>

Return ONE JSON object and NOTHING else — no markdown fences, no commentary. Exactly one of these two shapes:

1. The revised draft — whenever the user asks you to create the skill or change ANYTHING about it (this is the default):
{ "action": "draft", "name": "<2-5 word imperative name>", "description": "<one sentence>", "whenToUse": "<trigger phrases + situations, concrete>", "content": "<markdown body, numbered steps>", "sensitivity": "public" | "internal" | "confidential", "message": "<1-2 plain sentences telling the user what you created or changed>", "extraction"?: { "sections": [{ "heading": "<title>", "instruction": "<how to fill this section from the source>", "outputType": "prose"|"list"|"table" }], "capture": ["company"|"contact"|"deal"|"task"] } }

2. A reply with no draft change — ONLY when the user asked a question, or you genuinely cannot draft without one or two specific answers:
{ "action": "reply", "message": "<your answer or your clarifying questions, plain text>" }

Hard rules:
- "## Current draft" in the latest message is the LIVE document, including the user's own hand edits since your last revision — revise FROM it; never silently discard their edits.
- Never ask clarifying questions twice in a row: if the user already answered a clarify reply, you MUST return the draft shape.
- The body is markdown with numbered steps in execution order, under ~60 lines, no secrets/credentials, no frozen one-off facts.
- **Output structure goes in "extraction", not the body.** If the skill's PURPOSE is to produce a structured document (a brief, report, spec, or a contact/company list with defined sections captured the same way every time), add "extraction": put each output section (heading + how to fill it from the source + prose/list/table) in "sections", and list which brain entities the run should capture in "capture". Keep "content" for the PROCEDURE (how to gather and decide). Never duplicate the section layout in both "content" and "extraction". A purely procedural skill (no fixed output document) omits "extraction" entirely.
- Ground the draft in the workspace context: prefer the team's stated preferences and real entity names over generic best practice.${researchRule}`
}

/** The grounding sections appended to the FIRST user message — starting
 *  template and the brain context. Rebuilt every turn (the endpoint is
 *  stateless), so their position in the prompt is stable. Reference material
 *  has no section of its own: pasted text arrives inside the user's message,
 *  documents arrive as attachments. */
function groundingSections(params: {
  template?: SkillDraftTemplate
  context: SkillDraftContext
}): string[] {
  const parts: string[] = []
  if (params.template) {
    parts.push(
      `## Starting template: "${params.template.name}"${params.template.whenToUse ? `\nWhen to use: ${params.template.whenToUse}` : ''}\n${params.template.content.slice(0, MAX_TEMPLATE_CHARS)}`,
    )
  }
  const ctx = params.context
  if (ctx.memories.length > 0) {
    parts.push(`## Workspace memories (team preferences + patterns)\n- ${ctx.memories.join('\n- ')}`)
  }
  if (ctx.entities.length > 0) {
    parts.push(`## Entity vocabulary (use these real names in examples)\n${ctx.entities.join(', ')}`)
  }
  if (ctx.existingSkills.length > 0) {
    parts.push(
      `## Existing skills (match their granularity; never duplicate one)\n${ctx.existingSkills
        .map((s) => `- ${s.name}${s.whenToUse ? ` (when: ${s.whenToUse})` : ''}`)
        .join('\n')}`,
    )
  }
  return parts
}

/** The live-document section appended to the LAST user message. Empty draft
 *  (nothing typed yet) ⇒ omitted, so the model knows it's creating. */
function currentDraftSection(draft: SkillDraftFields | null | undefined): string | null {
  if (!draft) return null
  const blank =
    !draft.name.trim() && !draft.description.trim() && !draft.whenToUse.trim() && !draft.content.trim()
  if (blank) return null
  return [
    '## Current draft (the LIVE document — the user may have hand-edited it; revise from this)',
    `name: ${draft.name.trim() || '(empty)'}`,
    `description: ${draft.description.trim() || '(empty)'}`,
    `whenToUse: ${draft.whenToUse.trim() || '(empty)'}`,
    `sensitivity: ${draft.sensitivity}`,
    'content:',
    draft.content.trim() || '(empty)',
  ].join('\n')
}

/**
 * Transcript → provider messages. The first USER message carries the
 * grounding sections; the last user message carries the current-draft
 * section + attachments (as content blocks when media is present). Trimmed
 * to the freshest {@link MAX_TRANSCRIPT_MESSAGES} / {@link MAX_TRANSCRIPT_CHARS},
 * always starting on a user turn so role alternation survives the cut.
 */
function buildMessages(params: {
  transcript: SkillDraftTurn[]
  template?: SkillDraftTemplate
  currentDraft?: SkillDraftFields | null
  attachments?: SkillDraftAttachments
  context: SkillDraftContext
}): Message[] {
  // Freshest-suffix trim, then drop leading assistant turns so the window
  // opens on a user message.
  let window = params.transcript.slice(-MAX_TRANSCRIPT_MESSAGES)
  let chars = window.reduce((n, m) => n + m.content.length, 0)
  while (window.length > 1 && chars > MAX_TRANSCRIPT_CHARS) {
    chars -= window[0]!.content.length
    window = window.slice(1)
  }
  while (window.length > 1 && window[0]!.role !== 'user') {
    window = window.slice(1)
  }

  const lastIndex = window.length - 1
  const firstUserIndex = window.findIndex((m) => m.role === 'user')

  return window.map((turn, i) => {
    const sections: string[] = [turn.content.trim()]
    if (i === firstUserIndex) {
      sections.push(...groundingSections(params))
    }
    if (i === lastIndex) {
      const draftSection = currentDraftSection(params.currentDraft)
      if (draftSection) sections.push(draftSection)
      if (params.attachments && params.attachments.textParts.length > 0) {
        sections.push(params.attachments.textParts.join('\n'))
      }
    }
    const text = sections.join('\n\n')
    // Media blocks ride only the latest user message (mirrors the chat route).
    if (i === lastIndex && params.attachments && params.attachments.blocks.length > 0) {
      return {
        role: turn.role,
        content: [{ type: 'text', text } as ContentBlock, ...params.attachments.blocks],
      }
    }
    return { role: turn.role, content: text }
  })
}

/** Default research-turn registry — the explicit search → fetch loop. */
function defaultResearchTools(): Map<string, Tool> {
  return new Map<string, Tool>([
    [webSearchTool.name, webSearchTool as Tool],
    [urlReaderTool.name, urlReaderTool as Tool],
  ])
}

/**
 * One conversational draft turn: revised draft or plain reply. Throws
 * {@link SkillDraftError} when the model output can't be parsed/validated;
 * the route maps that to a 422 so the user can rephrase.
 */
export async function generateSkillDraft(params: {
  provider: LLMProvider
  /** Resolved provider model id (the route maps the tier alias via `resolveModel`). */
  model?: string
  /** Chat transcript, oldest first. The last entry must be role `user`. */
  transcript: SkillDraftTurn[]
  template?: SkillDraftTemplate
  /** Live document state (client-authoritative, includes hand edits). */
  currentDraft?: SkillDraftFields | null
  attachments?: SkillDraftAttachments
  context: SkillDraftContext
  /** The `skill-builder` builtin skill body (D3) — the drafting methodology. */
  builderSkill: string
  /** Arm webSearch + urlReader for this turn (small constrained query loop). */
  research?: boolean
  /** Test seam — research-turn tool registry override. */
  researchTools?: Map<string, Tool>
  /** Identity for the research loop's ToolContext (analytics/abort only). */
  identity?: { userId: string; workspaceId: string }
}): Promise<SkillDraftResult> {
  const transcript = params.transcript.filter((m) => m.content.trim().length > 0)
  if (transcript.length === 0 || transcript[transcript.length - 1]!.role !== 'user') {
    throw new SkillDraftError('Describe what the skill should do first')
  }

  const model = params.model ?? DRAFT_MODEL
  const messages = buildMessages({ ...params, transcript })
  const system = systemPrompt(params.builderSkill, params.research === true)

  const { text, usage } = params.research
    ? await runResearchTurn({
        provider: params.provider,
        model,
        system,
        messages,
        tools: params.researchTools ?? defaultResearchTools(),
        identity: params.identity,
      })
    : await runPlainTurn({ provider: params.provider, model, system, messages })

  const parsed = extractOutput(text)

  if (parsed.action === 'reply') {
    return { kind: 'reply', message: parsed.message, usage }
  }
  return {
    kind: 'draft',
    draft: {
      name: parsed.name,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      content: parsed.content,
      sensitivity: parsed.sensitivity,
      extraction: parsed.extraction,
    },
    message: parsed.message ?? '',
    usage,
  }
}

/** Plain turn — one stateless stream call (the theme-generator shape). */
async function runPlainTurn(params: {
  provider: LLMProvider
  model: string
  system: string
  messages: Message[]
}): Promise<{ text: string; usage: TokenUsage | null }> {
  const response = await collectStream(
    params.provider.stream({
      model: params.model,
      systemPrompt: params.system,
      messages: params.messages,
      maxTokens: 3000,
      // Procedural writing: mostly faithful to the inputs, a little latitude
      // for naming + step phrasing.
      temperature: 0.4,
    }),
  )
  return { text: responseText(response.content), usage: response.usage }
}

/**
 * Research turn — the `home/refresh.ts` harness: a stateless `queryLoop`
 * with ONLY the search/fetch tools, synthetic ToolContext, tight budget.
 * The JSON contract is parsed from the FINAL turn's text (`turn_complete`
 * carries the final response; intermediate tool-turn text is ignored).
 */
async function runResearchTurn(params: {
  provider: LLMProvider
  model: string
  system: string
  messages: Message[]
  tools: Map<string, Tool>
  identity?: { userId: string; workspaceId: string }
}): Promise<{ text: string; usage: TokenUsage | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS)
  let text = ''
  let usage: TokenUsage | null = null
  try {
    for await (const event of queryLoop({
      provider: params.provider,
      model: params.model,
      systemPrompt: params.system,
      messages: params.messages,
      tools: params.tools,
      context: {
        userId: params.identity?.userId ?? 'skill-draft',
        assistantId: 'skill-draft',
        sessionId: randomUUID(),
        appId: 'skill-draft',
        channelType: 'skill-draft',
        channelId: params.identity?.workspaceId ?? 'skill-draft',
        workspaceId: params.identity?.workspaceId,
        abortSignal: controller.signal,
      },
      maxTurns: RESEARCH_MAX_TURNS,
      maxToolCalls: RESEARCH_MAX_TOOL_CALLS,
      stateless: true,
    })) {
      if (event.type === 'turn_complete') {
        text = responseText(event.response.content)
        usage = event.totalUsage
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return { text, usage }
}

function responseText(content: { type: string; text?: string }[]): string {
  return content
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('')
    .trim()
}

/**
 * Forgiving output extraction: strip ```json fences, grab the first {…} block,
 * parse + validate against the two-shape contract. Throws
 * {@link SkillDraftError} on anything unparseable (same shape as the
 * theme-generator's `extractSeed`).
 */
function extractOutput(text: string): z.infer<typeof outputSchema> {
  const unfenced = text.replace(/```(?:json)?/gi, '').trim()
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start === -1 || end <= start) throw new SkillDraftError()

  let raw: unknown
  try {
    raw = JSON.parse(unfenced.slice(start, end + 1))
  } catch {
    throw new SkillDraftError()
  }
  const parsed = outputSchema.safeParse(raw)
  if (!parsed.success) throw new SkillDraftError()
  return parsed.data
}
