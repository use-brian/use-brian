import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENGINE_PROVIDER_COST_PER_1K } from '../../billing/engine-provider-rates.js'
import { SEARCH_PROVIDER_COST_PER_1K } from '../../billing/search-provider-rates.js'
import { createWorkflowTools } from '../../workflow/tools.js'
import type { WorkflowDefinition, WorkflowTrigger } from '../../workflow/types.js'
import type { ToolContext } from '../../tools/types.js'
import { loadBuiltinSkills, _resetBuiltinCache } from '../loader.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000003'
const PAGE_ID = '00000000-0000-4000-8000-000000000004'
const PROJECT_ID = '00000000-0000-4000-8000-000000000005'
const SLACK_CHANNEL_ID = 'C0123MARKETING'

const PRIMARY_QUERIES = [
  'What is Use Brian?',
  'What is an AI company brain?',
  'Best AI company brain for small teams',
  'AI operating system for small businesses',
  'AI assistant that remembers company context',
  'AI workspace with memory and workflows',
  'Open-source company brain',
  'Self-hosted AI company brain',
  'AI assistant for Telegram Slack and web',
  'Automate business operations with an AI assistant',
  'Use Brian pricing',
  'Is Use Brian open source?',
]

const STUDIO_QUERIES = [
  'What is AI operations consulting?',
  'What does an AI operations consultant do?',
  'Best AI operations consulting firm in Hong Kong',
  'AI automation consultant Hong Kong',
  'AI workflow automation consulting for small and mid-sized businesses',
  'How do I automate business operations with AI?',
  'AI operations audit for a company',
  'Enterprise AI implementation partner Hong Kong',
  'AI consulting for professional services firms Hong Kong',
  'Generative AI training for companies Hong Kong',
  'AI workshops for business teams Hong Kong',
  'On-premise private AI consulting Hong Kong',
  'AI consultant that audits, builds, and hands over workflows',
  'AI consulting firm that lets clients keep ownership of their systems',
  'What is Brian Studio?',
  'Is Brian Studio the services arm of Use Brian?',
  'Brian Studio pricing or consultation',
]

const PRIMARY_AI = [
  PRIMARY_QUERIES[0], PRIMARY_QUERIES[10], PRIMARY_QUERIES[11],
  PRIMARY_QUERIES[2], PRIMARY_QUERIES[7], PRIMARY_QUERIES[8],
  PRIMARY_QUERIES[1], PRIMARY_QUERIES[4], PRIMARY_QUERIES[9],
]

const STUDIO_AI = [
  STUDIO_QUERIES[14], STUDIO_QUERIES[15], STUDIO_QUERIES[16],
  STUDIO_QUERIES[2], STUDIO_QUERIES[3], STUDIO_QUERIES[4],
  STUDIO_QUERIES[0], STUDIO_QUERIES[5], STUDIO_QUERIES[11],
]

function skillSource(file: string): string {
  return readFileSync(fileURLToPath(new URL(`../builtin/${file}`, import.meta.url)), 'utf8')
}

function assistant(
  id: string,
  prompt: string,
  nextStepId: string | string[] | null,
  extras: Record<string, unknown> = {},
) {
  return {
    id,
    type: 'assistant_call' as const,
    target: { assistantId: 'primary' as const },
    prompt,
    nextStepId,
    ...extras,
  }
}

function weeklyDefinition(): WorkflowDefinition {
  const failureDelivery = { channelType: 'slack' as const, channelId: SLACK_CHANNEL_ID }
  return {
    startStepId: 'gsc_sites',
    failureDelivery,
    steps: [
      {
        id: 'gsc_sites', type: 'tool_call', toolName: 'searchConsoleListSites',
        arguments: {}, storeOutputAs: 'gsc_sites', nextStepId: 'cheap_preflight',
      },
      assistant(
        'cheap_preflight',
        `Cheap preflight for Project GEO (${PROJECT_ID}), GSC sc-domain:usebrian.ai, the 29/54 unit portfolio-geo-v1 manifest, scorecard page, blueprint, and Slack ${SLACK_CHANNEL_ID}. Return PASS only when every check succeeds.`,
        'preflight_gate',
        {
          page: { id: PAGE_ID },
          tools: ['getCurrentPage', 'searchConsoleListSites'],
          enforcedSkills: ['seo-geo-audit'],
          storeOutputAs: 'preflight',
        },
      ),
      {
        id: 'preflight_gate', type: 'branch',
        condition: { '==': [{ var: 'vars.preflight' }, 'PASS'] },
        nextStepIdIfTrue: 'start_collectors', nextStepIdIfFalse: 'preflight_fail',
      },
      {
        id: 'preflight_fail', type: 'tool_call', toolName: 'searchConsoleQuery',
        arguments: { siteUrl: 'preflight_failed', startDate: '2000-01-01', endDate: '2000-01-01' },
        nextStepId: null,
      },
      assistant(
        'start_collectors',
        'Return the verified preflight manifest unchanged. Do not call a paid provider.',
        ['gsc_technical', 'primary_google', 'studio_google', 'primary_ai', 'studio_ai'],
      ),
      assistant(
        'gsc_technical',
        'Collect compact GSC 7/7 and 28/28 windows for both exact hosts, sitemap state, homepages, and rotating priority URLs.',
        'portfolio_analysis',
        {
          tools: ['searchConsoleQuery', 'searchConsoleInspectUrl', 'searchConsoleListSitemaps'],
          enforcedSkills: ['seo-geo-audit'],
          storeOutputAs: 'gsc',
        },
      ),
      {
        id: 'primary_google', type: 'tool_call', toolName: 'webSearch',
        arguments: {
          queries: PRIMARY_QUERIES, provider: 'serpapi', resultMode: 'measurement',
          trackDomains: ['usebrian.ai', 'studio.usebrian.ai'],
        },
        storeOutputAs: 'primary_google', nextStepId: 'portfolio_analysis',
      },
      {
        id: 'studio_google', type: 'tool_call', toolName: 'webSearch',
        arguments: {
          queries: STUDIO_QUERIES, provider: 'serpapi', resultMode: 'measurement',
          trackDomains: ['usebrian.ai', 'studio.usebrian.ai'],
        },
        storeOutputAs: 'studio_google', nextStepId: 'portfolio_analysis',
      },
      assistant(
        'primary_ai',
        `Ask exactly these nine primary questions once per granted engine, with checkFor Use Brian/usebrian.ai and answerMaxChars 1200: ${JSON.stringify(PRIMARY_AI)}. Return only normalized compact evidence.`,
        'portfolio_analysis',
        {
          tools: ['askOpenAI', 'askGemini', 'askPerplexity'],
          enforcedSkills: ['seo-geo-audit'],
          storeOutputAs: 'primary_ai',
        },
      ),
      assistant(
        'studio_ai',
        `Ask exactly these nine Studio questions once per granted engine, with checkFor Brian Studio/studio.usebrian.ai and answerMaxChars 1200: ${JSON.stringify(STUDIO_AI)}. Return only normalized compact evidence.`,
        'portfolio_analysis',
        {
          tools: ['askOpenAI', 'askGemini', 'askPerplexity'],
          enforcedSkills: ['seo-geo-audit'],
          storeOutputAs: 'studio_ai',
        },
      ),
      assistant(
        'portfolio_analysis',
        'Consume only compact collector variables. Apply deterministic complete/partial/failed coverage, history, ownership, persistence, and candidate rules.',
        'record_scorecard',
        { enforcedSkills: ['seo-geo-audit'], storeOutputAs: 'analysis' },
      ),
      assistant(
        'record_scorecard',
        'Write schemaVersion 1 to the portfolio scorecard in fixed section order, then read it back. A write/read-back failure is failed.',
        'route_actions',
        {
          page: { id: PAGE_ID }, blueprintId: 'portfolio-geo-scorecard',
          tools: ['getCurrentPage', 'patchPage', 'saveBlueprintRecord'],
          enforcedSkills: ['seo-geo-audit'], storeOutputAs: 'scorecard',
        },
      ),
      assistant(
        'route_actions',
        'Upsert deterministic three-lane tasks. Mutate at most 8 and create at most 3 new Brian tasks. A failed analysis mutates none.',
        'slack_summary',
        {
          tools: ['listTasks', 'getTask', 'saveTask', 'updateTask', 'closeTask', 'reopenTask'],
          enforcedSkills: ['seo-geo-audit'], storeOutputAs: 'actions',
        },
      ),
      assistant(
        'slack_summary',
        'Post status, period, coverage, per-site GSC/Google/AI movement, ownership findings, lane counts, blockers, and run/scorecard/task links.',
        null,
        { deliver: failureDelivery },
      ),
    ],
  }
}

function executorDefinition(): WorkflowDefinition {
  return {
    startStepId: 'execute',
    failureDelivery: { channelType: 'slack', channelId: SLACK_CHANNEL_ID },
    steps: [assistant(
      'execute',
      'Claim and execute {{input.event.taskId}}. Verify the result and end exactly done or blocked.',
      null,
      {
        tools: ['getTask', 'listTasks', 'updateTask', 'closeTask'],
        enforcedSkills: ['seo-geo-task-executor'],
      },
    )],
  }
}

function notifierDefinition(): WorkflowDefinition {
  return {
    startStepId: 'notify',
    steps: [assistant(
      'notify',
      'Read {{input.event.taskId}} and emit the exact COMPLETED or BLOCKED terminal task payload.',
      null,
      { tools: ['getTask'], deliver: { channelType: 'slack', channelId: SLACK_CHANNEL_ID } },
    )],
  }
}

function watchdogDefinition(): WorkflowDefinition {
  return {
    startStepId: 'watchdog',
    failureDelivery: { channelType: 'slack', channelId: SLACK_CHANNEL_ID },
    steps: [assistant(
      'watchdog',
      'Block Brian-routed queued/running tasks only after more than two hours without progress. Do not execute them.',
      null,
      {
        tools: ['listTasks', 'getTask', 'updateTask'],
        enforcedSkills: ['seo-geo-task-executor'],
      },
    )],
  }
}

const triggers: Record<string, WorkflowTrigger> = {
  weekly: {
    kind: 'schedule',
    schedule: { type: 'weekly', days: ['monday'], time: '09:00' },
    timezone: 'Asia/Hong_Kong',
  },
  executor: {
    kind: 'event',
    event: {
      sources: [{
        source: { type: 'task' },
        match: {
          inChannels: ['created', 'tagged', 'updated', 'reopened'],
          tags: ['geo:queued'], currentTags: ['geo:route:brian'], fromBots: true,
        },
      }],
    },
  },
  notifier: {
    kind: 'event',
    event: {
      sources: [{
        source: { type: 'task' },
        match: {
          inChannels: ['completed', 'blocked'], currentTags: ['geo:route:brian'], fromBots: true,
        },
      }],
    },
  },
  watchdog: {
    kind: 'schedule', schedule: { type: 'cron', expression: '0 * * * *' },
    timezone: 'Asia/Hong_Kong',
  },
}

function context(): ToolContext {
  return {
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    sessionId: 'seo-geo-contract',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web',
    workspaceId: WORKSPACE_ID,
    activeProjectId: PROJECT_ID,
    abortSignal: new AbortController().signal,
  }
}

function proposalTools() {
  return createWorkflowTools({
    workflowStore: {
      create: async () => { throw new Error('not used') },
      getById: async () => null,
      list: async () => [],
      update: async () => null,
      delete: async () => false,
      findByWebhookSlugSystem: async () => null,
      findByIdSystem: async () => null,
      updateAutoName: async () => false,
    },
    runStore: {} as never,
    executorDeps: {} as never,
    resolvePageAnchor: async () => ({ workspaceId: WORKSPACE_ID, state: 'saved', name: 'Portfolio GEO scorecard' }),
    listAuthorableSkills: async () => [
      { slug: 'seo-geo-audit', name: 'SEO/GEO audit' },
      { slug: 'seo-geo-task-executor', name: 'SEO/GEO task executor' },
    ],
    isKnownTool: () => true,
    resolveKnownWorkflowTools: async ({ toolNames }) => toolNames,
    preflightConnectorTool: async ({ toolName }) => {
      if (toolName.startsWith('searchConsole')) return { ok: true, provider: 'gsc', policy: 'allow' }
      return null
    },
    validateDeliveryTarget: async () => ({ ok: true }),
  })
}

describe('[COMP:skills/seo-geo-operator] built-in skill contracts', () => {
  it('discovers the installer, audit, and executor skills through the canonical loader', () => {
    _resetBuiltinCache()
    const ids = new Set(loadBuiltinSkills().map((skill) => skill.id))
    expect(ids.has('seo-geo-workflow-builder')).toBe(true)
    expect(ids.has('seo-geo-audit')).toBe(true)
    expect(ids.has('seo-geo-task-executor')).toBe(true)
  })

  it('locks the complete ordered 12 + 17 registry and nine-per-site AI sample', () => {
    const builder = skillSource('seo-geo-workflow-builder.md')
    expect(PRIMARY_QUERIES).toHaveLength(12)
    expect(STUDIO_QUERIES).toHaveLength(17)
    expect(PRIMARY_AI).toHaveLength(9)
    expect(STUDIO_AI).toHaveLength(9)
    for (const [index, query] of PRIMARY_QUERIES.entries()) {
      expect(builder.indexOf(`U${String(index + 1).padStart(2, '0')} ${query}`)).toBeGreaterThan(-1)
    }
    for (const [index, query] of STUDIO_QUERIES.entries()) {
      expect(builder.indexOf(`S${String(index + 1).padStart(2, '0')} ${query}`)).toBeGreaterThan(-1)
    }
  })

  it('keeps the installer estimate synchronized with the active rate maps and gates creation on confirmation', () => {
    const search = 29 * (SEARCH_PROVIDER_COST_PER_1K.serpapi / 1000)
    const engines = 18 * (
      ENGINE_PROVIDER_COST_PER_1K.openai
      + ENGINE_PROVIDER_COST_PER_1K.gemini
      + ENGINE_PROVIDER_COST_PER_1K.perplexity
    ) / 1000
    expect(search + engines).toBeCloseTo(2.615, 6)

    const builder = skillSource('seo-geo-workflow-builder.md')
    expect(builder).toContain('$2.615')
    expect(builder).toContain('explicitly confirmed the cost and shape')
    expect(builder).toContain('Never reconstruct a receipt')
    expect(builder).toContain('Project named exactly `GEO`')
    expect(builder).toContain('Never emulate a Project with a `project:GEO` tag')
  })

  it('defines the three exclusive routes, persistence rule, churn caps, and terminal states', () => {
    const audit = skillSource('seo-geo-audit.md')
    const executor = skillSource('seo-geo-task-executor.md')
    for (const route of ['geo:route:brian', 'geo:route:coding', 'geo:route:human']) {
      expect(audit).toContain(route)
    }
    expect(audit).toContain('two consecutive valid runs')
    expect(audit).toContain('mutate at most 8 tasks')
    expect(audit).toContain('create at most 3 new Brian-routed tasks')
    expect(executor).toContain('Exactly one terminal outcome is required')
    expect(executor).toContain('status to `done`')
    expect(executor).toContain('status to `blocked`')
    expect(executor).toContain('more than two hours')
  })
})

describe('[COMP:skills/seo-geo-operator] canonical workflow blueprint', () => {
  it.each([
    ['Weekly Portfolio SEO/GEO', weeklyDefinition(), triggers.weekly],
    ['GEO Brian Action Executor', executorDefinition(), triggers.executor],
    ['GEO Brian Task Notifier', notifierDefinition(), triggers.notifier],
    ['GEO Brian Action Watchdog', watchdogDefinition(), triggers.watchdog],
  ])('passes canonical workflow proposal preflight: %s', async (name, definition, trigger) => {
    const result = await proposalTools().proposeWorkflow.execute({
      name,
      definition,
      trigger,
    }, context())
    expect(result.isError).not.toBe(true)
    expect(result.data).toEqual(expect.objectContaining({ ok: true, proposedName: name }))
  })

  it('uses one five-branch collector fan-out and exact 29-query SerpAPI coverage', () => {
    const definition = weeklyDefinition()
    const fanout = definition.steps.find((step) => step.id === 'start_collectors')
    expect(fanout?.nextStepId).toEqual([
      'gsc_technical', 'primary_google', 'studio_google', 'primary_ai', 'studio_ai',
    ])
    const google = definition.steps.filter((step) =>
      step.type === 'tool_call' && step.toolName === 'webSearch',
    )
    expect(google).toHaveLength(2)
    const calls = google.map((step) => step.type === 'tool_call' ? step.arguments : {})
    expect(calls.flatMap((args) => args.queries as string[])).toEqual([
      ...PRIMARY_QUERIES, ...STUDIO_QUERIES,
    ])
    expect(calls.every((args) => args.provider === 'serpapi' && args.resultMode === 'measurement')).toBe(true)
  })

  it('uses currentTags for terminal notification and keeps the four workflows Project-bound at authoring', () => {
    const notifier = triggers.notifier
    expect(notifier.kind).toBe('event')
    if (notifier.kind !== 'event') throw new Error('expected event trigger')
    expect(notifier.event.sources[0].match?.currentTags).toEqual(['geo:route:brian'])
    expect(context().activeProjectId).toBe(PROJECT_ID)
  })
})
