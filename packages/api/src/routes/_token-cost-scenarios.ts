/**
 * Per-turn input token cost — shared scenarios + measurement.
 *
 * Used by two consumers:
 *   1. `__tests__/prompt-token-cost.test.ts` — regression guard.
 *   2. `packages/api/scripts/token-report.ts` — standalone CLI that
 *      regenerates the committed snapshot under
 *      `docs/architecture/context-engine/token-cost-snapshot.md`.
 *
 * Keeping both paths on a single scenario list guarantees the test
 * and the snapshot can't silently diverge. If you add a scenario
 * here, it shows up in both.
 *
 * # What's real and what's approximate
 *
 * Real:
 * - `buildFullSystemPrompt` — same assembly chat.ts / telegram.ts /
 *   channel-pipeline.ts emit.
 * - `buildMemoryContext` — same call shape those routes feed it.
 * - Tool schemas loaded from the actual factories (`createBaseTools`,
 *   `createGoogleCalendarTools`, `createGmailTools`,
 *   `createGoogleTasksTools`, `createGitHubTools`, `createNotionTools`,
 *   `createMcpSearchTools`) with Proxy-stubbed API adapters — the
 *   stubs satisfy the TS contract but never actually run (we only
 *   introspect definitions).
 * - Zod → JSON Schema via the same transform the engine applies
 *   (`jsonSchemaFromZod` copied inline from
 *   `packages/core/src/engine/query-loop.ts` — if the engine's version
 *   changes, mirror it here).
 * - Wire shape via the same `{name, description, parameters}`
 *   projection that `toToolDeclarations()` uses in
 *   `packages/core/src/providers/gemini.ts`.
 *
 * Approximate:
 * - Token count: `Math.ceil(chars / 3.5)`. Gemini's real tokenizer
 *   swings ~10% either way depending on content. Fixed divisor keeps
 *   the numbers deterministic and comparable across scenarios.
 *   Production truth lives in `usageMetadata.promptTokenCount`.
 *
 * # Skipped tool additions
 *
 * `createBaseTools()` covers only the core-package subset (~8 tools).
 * The API-layer adds ~7 more (scheduling, workers, cache, files, bug
 * report) via `buildAllTools()` in the server apps. They are not
 * exercised here — the scenarios undercount total tools by ~7 vs
 * real production. Directionally correct; if we ever want exact
 * numbers, extract `buildAllTools()` into a standalone helper.
 */

import {
  buildMemoryContext,
  LAYER_1_SYSTEM_PROMPT,
  createBaseTools,
  createGoogleCalendarTools,
  createGmailTools,
  createGoogleTasksTools,
  createGitHubTools,
  createNotionTools,
  createMcpSearchTools,
  buildToolIndex,
  type Tool,
  type McpServerConfig,
  type McpSettingsStore,
} from '@sidanclaw/core'
import { buildFullSystemPrompt } from './_prompt-builder.js'

// ── Token helpers ────────────────────────────────────────────────

export function approxTokens(s: string): number {
  return Math.ceil(s.length / 3.5)
}

// ── Zod → JSON schema mirror ────────────────────────────────────

type JsonSchema = {
  type: string
  properties?: Record<string, unknown>
  required?: string[]
  items?: unknown
  description?: string
  enum?: string[]
}

function zodFieldToJsonSchema(field: { _def: Record<string, unknown> }): JsonSchema {
  const def = field._def
  const typeName = def.typeName as string

  switch (typeName) {
    case 'ZodString':
      return { type: 'string', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodNumber':
      return { type: 'number', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodBoolean':
      return { type: 'boolean', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodOptional': {
      const inner = zodFieldToJsonSchema({ _def: (def.innerType as { _def: Record<string, unknown> })._def })
      if (def.description && !inner.description) inner.description = def.description as string
      return inner
    }
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[], ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodArray':
      return { type: 'array', items: zodFieldToJsonSchema({ _def: (def.type as { _def: Record<string, unknown> })._def }) }
    case 'ZodLiteral':
      return { type: 'string', enum: [String(def.value)] }
    case 'ZodObject':
      return jsonSchemaFromZod(field as { _def: unknown })
    default:
      return { type: 'string' }
  }
}

function jsonSchemaFromZod(schema: { _def: unknown }): JsonSchema {
  const def = schema._def as Record<string, unknown>
  if (def.typeName === 'ZodObject') {
    const shape = (def as { shape: () => Record<string, { _def: Record<string, unknown> }> }).shape()
    const properties: Record<string, JsonSchema> = {}
    const required: string[] = []
    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodFieldToJsonSchema(fieldSchema)
      if (fieldSchema._def.typeName !== 'ZodOptional') required.push(key)
    }
    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
  }
  return { type: 'object', properties: {} }
}

export function toDeclarations(tools: Tool[]): Array<{
  name: string
  description: string
  parameters: JsonSchema
}> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema
      ? jsonSchemaFromZod(t.inputSchema as unknown as { _def: unknown })
      : { type: 'object', properties: {} },
  }))
}

// ── API stubs for tool factories ────────────────────────────────

function stubApi<T>(): T {
  return new Proxy(
    {},
    {
      get: () => () => {
        throw new Error('stub API — token-cost scenarios only introspect tool definitions, never execute them')
      },
    },
  ) as T
}

const stubSettingsStore: McpSettingsStore = {
  getPolicy: async () => 'ask',
  setPolicy: async () => { /* noop */ },
  listPolicies: async () => [],
} as unknown as McpSettingsStore

/**
 * Build the mcp_search + mcp_call pair from arbitrary sources. Default
 * is a single empty remote stub (matches the legacy "custom MCP only"
 * shape). Pass `localBundles` to simulate the post-refactor world where
 * built-ins (Google / GitHub / Notion / Fathom / KB) feed into the
 * index as local sources — the model only sees the 2 gateway tools but
 * the search index covers everything.
 *
 * Used by both the legacy `mcpPair` bundle (no local sources) and the
 * post-refactor `power-built-in-search` scenario.
 */
export function buildMcpPair(opts?: {
  remoteServers?: Array<{ name: string; toolCount: number }>
  localBundles?: Array<{ serverName: string; tools: Tool[] }>
}): Tool[] {
  const remoteServers = opts?.remoteServers ?? [{ name: 'stub', toolCount: 0 }]
  const localBundles = opts?.localBundles ?? []

  const remoteSources = remoteServers.map((r) => {
    const server: McpServerConfig = {
      name: r.name,
      url: `https://${r.name}.local`,
      tools: Array.from({ length: r.toolCount }, (_, i) => ({
        name: `${r.name}_tool_${i}`,
        description: `Stub tool ${i} on ${r.name}`,
        inputSchema: { type: 'object', properties: {} },
      })),
    } as unknown as McpServerConfig
    return {
      kind: 'remote' as const,
      server,
      serverUrl: server.url,
      callMcpTool: async () => { throw new Error('stub') },
    }
  })

  const localSources = localBundles.map((b) => ({
    kind: 'local' as const,
    serverName: b.serverName,
    tools: b.tools,
  }))

  const index = buildToolIndex([...remoteSources, ...localSources])
  return createMcpSearchTools({
    index,
    settingsStore: stubSettingsStore,
    assistantId: 'a_test',
    userId: 'u_test',
    callMcpTool: async () => { throw new Error('stub') },
  })
}

// ── Tool bundle builders (real factories, stub APIs) ────────────

export const toolBundles = {
  base: (): Tool[] => Array.from(createBaseTools().values()),
  googleCalendar: (): Tool[] => createGoogleCalendarTools(stubApi(), 'America/Los_Angeles'),
  gmail: (): Tool[] => createGmailTools(stubApi()),
  googleTasks: (): Tool[] => createGoogleTasksTools(stubApi()),
  github: (): Tool[] => createGitHubTools(stubApi()),
  notion: (): Tool[] => createNotionTools(stubApi()),
  mcpPair: (): Tool[] => buildMcpPair(),
}

// ── Fixture helpers ─────────────────────────────────────────────

const STANDARD_DATETIME = 'Monday, April 20, 2026 at 09:15 AM PDT'
const STANDARD_TZ = 'America/Los_Angeles'

function identityMem(id: string, summary: string, detail: string | null = null) {
  return { id, summary, detail }
}
function indexMem(id: string, type: string, summary: string, tags: string[] = []) {
  return { id, type, summary, tags, appId: null as string | null }
}
function buildIndexRows(count: number, typeCycle = ['preference', 'context', 'fact']) {
  const rows: ReturnType<typeof indexMem>[] = []
  for (let i = 0; i < count; i++) {
    rows.push(indexMem(
      `mid${String(i).padStart(5, '0')}`,
      typeCycle[i % typeCycle.length],
      `Summary of memory #${i} with a bit of detail to reach realistic size`,
      i % 3 === 0 ? ['tag-a', 'tag-b'] : [],
    ))
  }
  return rows
}

function minimalPromptArgs() {
  return {
    basePrompt: LAYER_1_SYSTEM_PROMPT,
    currentDateTime: STANDARD_DATETIME,
    timezone: STANDARD_TZ,
  }
}

// ── Scenarios ───────────────────────────────────────────────────

export type ScenarioBuild = {
  systemPrompt: string
  tools: Tool[]
}

export type Scenario = {
  id: string
  label: string
  /** One-line note shown in the snapshot for context (what the scenario represents). */
  note: string
  build: () => ScenarioBuild
}

export const scenarios: Scenario[] = [
  {
    id: 'fresh',
    label: 'fresh user',
    note: 'No memories, no connectors, no custom instructions. Baseline cost per turn.',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        memoryContext: buildMemoryContext({ identityMemories: [], memoryIndex: [] }),
      }),
      tools: toolBundles.base(),
    }),
  },
  {
    id: 'light',
    label: 'light user (Calendar)',
    note: '~10 memories, Google Calendar connector, custom instructions, no skills.',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        assistantInstructions: 'Always reply in a friendly tone.',
        memoryContext: buildMemoryContext({
          soul: 'Concise tone, no sycophancy.',
          identityMemories: [
            identityMem('id0aaa1b', 'Vegetarian', 'No dairy, allergic to mushrooms'),
            identityMem('id0aaa2b', 'Lives in Tokyo'),
            identityMem('id0aaa3b', 'Works at Google'),
          ],
          memoryIndex: buildIndexRows(7),
          totalNonIdentityCount: 7,
        }),
      }),
      tools: [...toolBundles.base(), ...toolBundles.googleCalendar()],
    }),
  },
  {
    id: 'active',
    label: 'active user (200 mem, 3 Google)',
    note: '200 memories (cap kicks in: 60 shown + footer hinting at 125 more), Calendar + Gmail + Tasks, skills.',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        assistantInstructions: 'Reply in the user\'s language. Keep answers under 3 sentences when possible.',
        memoryContext: buildMemoryContext({
          soul: 'Concise tone. User prefers bullet lists for comparisons.',
          identityMemories: Array.from({ length: 15 }, (_, i) =>
            identityMem(
              `idntty${i.toString().padStart(2, '0')}`,
              `Identity fact #${i}`,
              `Extra detail about identity ${i} that the model should always know`,
            ),
          ),
          memoryIndex: buildIndexRows(60),
          totalNonIdentityCount: 185,
        }),
        skillsFragment: '## Skills\n- mode:research\n- kb:search',
      }),
      tools: [
        ...toolBundles.base(),
        ...toolBundles.googleCalendar(),
        ...toolBundles.gmail(),
        ...toolBundles.googleTasks(),
      ],
    }),
  },
  {
    id: 'power',
    label: 'power user (1000 mem, full suite)',
    note: 'Post-PR#4: 1,000 memories, Google suite + GitHub + Notion + custom MCP — all routed behind mcp_search/mcp_call. Worst-case fully-connected user.',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        assistantInstructions: 'Code-first. Show examples before explaining.',
        memoryContext: buildMemoryContext({
          soul: 'Prefers code samples to prose. Technical audience.',
          identityMemories: Array.from({ length: 15 }, (_, i) =>
            identityMem(
              `powid${i.toString().padStart(3, '0')}`,
              `Power identity #${i}`,
              `Detail about identity ${i}`,
            ),
          ),
          memoryIndex: buildIndexRows(60),
          totalNonIdentityCount: 985,
        }),
        skillsFragment: '## Skills\n- mode:research\n- mode:long-task\n- kb:search',
        unavailableCapabilitiesPrompt: '# Unavailable capabilities\nDo NOT search for: whatsapp, slack.',
      }),
      // PR #4 production shape: built-ins are local sources behind
      // mcp_search/mcp_call, not directly injected. The model sees
      // base tools + 2 gateway tools, regardless of how many providers
      // are connected. The schemas live in the index, not the prompt.
      tools: [
        ...toolBundles.base(),
        ...buildMcpPair({
          remoteServers: [{ name: 'custom-mcp', toolCount: 5 }],
          localBundles: [
            { serverName: 'gcal', tools: toolBundles.googleCalendar() },
            { serverName: 'gmail', tools: toolBundles.gmail() },
            { serverName: 'gtasks', tools: toolBundles.googleTasks() },
            { serverName: 'github', tools: toolBundles.github() },
            { serverName: 'notion', tools: toolBundles.notion() },
          ],
        }),
      ],
    }),
  },
  {
    id: 'power-legacy',
    label: 'power user (pre-PR#4 baseline)',
    note: 'PRE-PR#4 baseline kept for historical A/B comparison: same memories + connectors as `power`, but every built-in tool schema inlined into the prompt. Will be retired once PR #4 ships and the savings are documented in the snapshot.',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        assistantInstructions: 'Code-first. Show examples before explaining.',
        memoryContext: buildMemoryContext({
          soul: 'Prefers code samples to prose. Technical audience.',
          identityMemories: Array.from({ length: 15 }, (_, i) =>
            identityMem(
              `powid${i.toString().padStart(3, '0')}`,
              `Power identity #${i}`,
              `Detail about identity ${i}`,
            ),
          ),
          memoryIndex: buildIndexRows(60),
          totalNonIdentityCount: 985,
        }),
        skillsFragment: '## Skills\n- mode:research\n- mode:long-task\n- kb:search',
        unavailableCapabilitiesPrompt: '# Unavailable capabilities\nDo NOT search for: whatsapp, slack.',
      }),
      tools: [
        ...toolBundles.base(),
        ...toolBundles.googleCalendar(),
        ...toolBundles.gmail(),
        ...toolBundles.googleTasks(),
        ...toolBundles.github(),
        ...toolBundles.notion(),
        ...toolBundles.mcpPair(),
      ],
    }),
  },
  {
    id: 'team',
    label: 'team user',
    note: 'Personal + team memories + Calendar. Team identity + team index rendered below personal.',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        memoryContext: buildMemoryContext({
          identityMemories: [identityMem('u0aaaaaa', 'Design lead at Acme')],
          memoryIndex: buildIndexRows(30),
          totalNonIdentityCount: 30,
          workspaceIdentityMemories: [identityMem('t0aaaaaa', 'Acme design team', 'Focused on onboarding flow Q2 2026')],
          teamMemoryIndex: buildIndexRows(20),
          assistantName: 'Acme Design Bot',
        }),
      }),
      tools: [...toolBundles.base(), ...toolBundles.googleCalendar()],
    }),
  },
  {
    id: 'group-chat',
    label: 'group-chat turn',
    note: 'Light user + group-chat context block (Slack/Telegram groups).',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        memoryContext: buildMemoryContext({
          identityMemories: [identityMem('idaaaaaa', 'Works at Google')],
          memoryIndex: buildIndexRows(5),
          totalNonIdentityCount: 5,
        }),
        groupChatContext: '# Group chat\nParticipants: Alice, Bob, Carol. Recent messages: …',
      }),
      tools: toolBundles.base(),
    }),
  },
  {
    id: 'reply-context',
    label: 'reply-context turn',
    note: 'Light user + reply block (user replied to a specific earlier message).',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        memoryContext: buildMemoryContext({
          identityMemories: [identityMem('idaaaaaa', 'Based in Tokyo')],
          memoryIndex: buildIndexRows(5),
          totalNonIdentityCount: 5,
        }),
        replyContext: {
          text: 'Yes, I confirmed the booking for Friday 7pm.',
          fromAssistant: true,
        },
      }),
      tools: toolBundles.base(),
    }),
  },
  {
    id: 'resume-topic',
    label: 'resume-topic turn',
    note: 'Light user + episodic history + topic hint (user resuming an earlier topic).',
    build: () => ({
      systemPrompt: buildFullSystemPrompt({
        ...minimalPromptArgs(),
        memoryContext: buildMemoryContext({
          identityMemories: [identityMem('idaaaaaa', 'Planning a Japan trip')],
          memoryIndex: buildIndexRows(10),
          totalNonIdentityCount: 10,
        }),
        episodicContext: '# Relevant topic history\nTrip planning — visited Tokyo in 2024, now considering Kyoto + Osaka for March 2026. User prefers small ryokans over big hotels.',
        topicHint: {
          topic_label: 'japan-trip',
          state: 'resume',
          confidence: 0.9,
          related_topics: [],
        },
      }),
      tools: toolBundles.base(),
    }),
  },
]

// ── Measurement + rendering ─────────────────────────────────────

export type Measurement = {
  id: string
  label: string
  note: string
  toolCount: number
  promptChars: number
  toolsChars: number
  promptTokens: number
  toolTokens: number
  totalTokens: number
  /** The rendered system prompt — kept for assertion-style regression tests. */
  systemPrompt: string
}

export function measureScenario(s: Scenario): Measurement {
  const built = s.build()
  const toolsPayload = JSON.stringify(toDeclarations(built.tools))
  return {
    id: s.id,
    label: s.label,
    note: s.note,
    toolCount: built.tools.length,
    promptChars: built.systemPrompt.length,
    toolsChars: toolsPayload.length,
    promptTokens: approxTokens(built.systemPrompt),
    toolTokens: approxTokens(toolsPayload),
    totalTokens: approxTokens(built.systemPrompt) + approxTokens(toolsPayload),
    systemPrompt: built.systemPrompt,
  }
}

export function measureAll(): Measurement[] {
  return scenarios.map(measureScenario)
}

/** Render an ASCII-framed table of measurements suitable for stdout. */
export function renderAsciiTable(measurements: Measurement[]): string {
  if (measurements.length === 0) return ''
  const header = ['Scenario', 'Tools', 'Prompt tok', 'Tool tok', 'Total tok']
  const rows = measurements.map((m) => [
    m.label,
    String(m.toolCount),
    String(m.promptTokens),
    String(m.toolTokens),
    String(m.totalTokens),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const pad = (cells: string[]) =>
    '│ ' + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join(' │ ') + ' │'
  const sep = '├─' + widths.map((w) => '─'.repeat(w)).join('─┼─') + '─┤'
  const top = '┌─' + widths.map((w) => '─'.repeat(w)).join('─┬─') + '─┐'
  const bottom = '└─' + widths.map((w) => '─'.repeat(w)).join('─┴─') + '─┘'
  return [top, pad(header), sep, ...rows.map(pad), bottom].join('\n')
}

/** Render a markdown table suitable for the committed snapshot. */
export function renderMarkdownTable(measurements: Measurement[]): string {
  const header = `| Scenario | Tools | Prompt tokens | Tool tokens | **Total tokens** | Notes |`
  const sep = `|---|---:|---:|---:|---:|---|`
  const rows = measurements.map((m) =>
    `| ${m.label} | ${m.toolCount} | ${m.promptTokens} | ${m.toolTokens} | **${m.totalTokens}** | ${m.note} |`,
  )
  return [header, sep, ...rows].join('\n')
}

export const LAYER_1_TOKENS = approxTokens(LAYER_1_SYSTEM_PROMPT)
export const LAYER_1_CHARS = LAYER_1_SYSTEM_PROMPT.length
