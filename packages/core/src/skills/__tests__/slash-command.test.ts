/**
 * Slash-command parsing + invocation block.
 * Component tag: [COMP:skills/slash-command].
 *
 * The parser is the deterministic entry into the skill system: the whole
 * message must be `/name [args]`, the name maps to a skill slug threaded as
 * an `enforceSlugs` entry, and everything that is not that exact shape must
 * fall through untouched — paths, fractions, prose with slashes. The block
 * builder is asserted for the load-bearing sentences: it names the skill,
 * carries the raw args, and forbids answering the message any other way.
 */

import { describe, it, expect } from 'vitest'
import {
  parseSlashCommand,
  prepareSlashCommand,
  prepareNativeSlashCommands,
  resolveNativeSlashCommand,
  buildSlashCommandBlock,
  buildWorkflowSlashCommandBlock,
} from '../slash-command.js'

describe('[COMP:skills/slash-command] slash-command parsing', () => {
  it('parses a bare command with empty args', () => {
    expect(parseSlashCommand('/goal')).toEqual({ name: 'goal', args: '' })
  })

  it('parses a command with args, trimming both ends', () => {
    expect(parseSlashCommand('  /goal register the Tokyo Marathon  ')).toEqual({
      name: 'goal',
      args: 'register the Tokyo Marathon',
    })
  })

  it('keeps multi-line args intact', () => {
    const parsed = parseSlashCommand('/goal register the marathon\nbudget $20\nby Friday')
    expect(parsed?.name).toBe('goal')
    expect(parsed?.args).toBe('register the marathon\nbudget $20\nby Friday')
  })

  it('lower-cases the command name (skill slugs are lower case)', () => {
    expect(parseSlashCommand('/Goal do it')?.name).toBe('goal')
  })

  it('accepts hyphenated names', () => {
    expect(parseSlashCommand('/workflow-builder daily digest')?.name).toBe('workflow-builder')
  })

  it('rejects everything that is not a whole-message command', () => {
    expect(parseSlashCommand('plain text')).toBeNull()
    expect(parseSlashCommand('please run /goal for me')).toBeNull()
    expect(parseSlashCommand('/usr/bin/env node')).toBeNull()
    expect(parseSlashCommand('/2 of the cake')).toBeNull()
    expect(parseSlashCommand('/ goal spaced slash')).toBeNull()
    expect(parseSlashCommand('//goal double slash')).toBeNull()
    expect(parseSlashCommand('')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('rejects a name over 64 chars (typo/paste guard, not a real command)', () => {
    expect(parseSlashCommand('/' + 'a'.repeat(65) + ' args')).toBeNull()
  })
})

describe('[COMP:skills/slash-command] invocation block', () => {
  it('names the command, carries the args verbatim, and forbids answering otherwise', () => {
    const block = buildSlashCommandBlock({ name: 'goal', args: 'register the marathon' })
    expect(block).toContain('# Slash command: /goal')
    expect(block).toContain('Arguments: register the marathon')
    expect(block).toContain('# Required Skills')
    expect(block).toMatch(/Do not answer the message any other way/)
  })

  it('marks empty args explicitly', () => {
    expect(buildSlashCommandBlock({ name: 'goal', args: '' })).toContain('Arguments: (none)')
  })
})

describe('[COMP:skills/slash-command] prepared commands', () => {
  it('keeps direct skill slugs and supports the explicit skill namespace', () => {
    expect(prepareSlashCommand('/goal register it')).toMatchObject({
      kind: 'skill', name: 'goal', args: 'register it',
    })
    expect(prepareSlashCommand('/skill workflow-builder daily digest')).toMatchObject({
      kind: 'skill', name: 'workflow-builder', args: 'daily digest',
    })
  })

  it('parses workflow ids and quoted names without losing arguments', () => {
    expect(prepareSlashCommand('/workflow 1234 region=apac')).toMatchObject({
      kind: 'workflow', target: '1234', args: 'region=apac',
    })
    const command = prepareSlashCommand('/workflow "Daily Digest" send now')
    expect(command).toMatchObject({ kind: 'workflow', target: 'Daily Digest', args: 'send now' })
    if (command?.kind === 'workflow') {
      expect(buildWorkflowSlashCommandBlock(command)).toContain('runWorkflow')
      expect(buildWorkflowSlashCommandBlock(command)).toContain('Daily Digest')
    }
  })

  it('rejects incomplete reserved commands instead of treating them as skill slugs', () => {
    expect(prepareSlashCommand('/skill')).toBeNull()
    expect(prepareSlashCommand('/workflow')).toBeNull()
    expect(prepareSlashCommand('/ask')).toBeNull()
  })
})

describe('[COMP:skills/slash-command] native command catalog', () => {
  const targets = [
    { kind: 'skill' as const, slug: 'workflow-builder', name: 'Workflow Builder' },
    {
      kind: 'workflow' as const,
      workflowId: '11111111-2222-4333-8444-555555555555',
      name: 'Daily Digest',
      description: 'Send the daily summary',
    },
  ]

  it('generates provider-safe skill and workflow commands', () => {
    const catalog = prepareNativeSlashCommands(targets)
    expect(catalog.commands.map((command) => command.name)).toEqual([
      'workflow_builder',
      'workflow_daily_digest',
    ])
    expect(catalog.commands.every((command) => /^[a-z][a-z0-9_]{0,31}$/.test(command.name))).toBe(true)
  })

  it('resolves generated names to exact skill slugs and workflow ids', () => {
    const catalog = prepareNativeSlashCommands(targets)
    expect(resolveNativeSlashCommand('/workflow_builder draft one', catalog)).toMatchObject({
      kind: 'skill', name: 'workflow-builder', args: 'draft one',
    })
    expect(resolveNativeSlashCommand('/workflow_daily_digest region=apac', catalog)).toMatchObject({
      kind: 'workflow',
      workflowId: '11111111-2222-4333-8444-555555555555',
      args: 'region=apac',
    })
  })

  it('uses deterministic suffixes for truncation and collisions', () => {
    const catalog = prepareNativeSlashCommands([
      { kind: 'skill', slug: 'a-very-long-skill-name-that-exceeds-provider-limits', name: 'Long' },
      { kind: 'skill', slug: 'same-name', name: 'One' },
      { kind: 'skill', slug: 'same_name', name: 'Two' },
    ])
    expect(catalog.commands.every((command) => command.name.length <= 32)).toBe(true)
    expect(new Set(catalog.commands.map((command) => command.name)).size).toBe(3)
    expect(prepareNativeSlashCommands([...targets].reverse())).toEqual(prepareNativeSlashCommands(targets))
  })

  it('reports targets omitted by the provider cap', () => {
    const catalog = prepareNativeSlashCommands(targets, 1)
    expect(catalog.commands).toHaveLength(1)
    expect(catalog.omitted).toHaveLength(1)
  })
})
