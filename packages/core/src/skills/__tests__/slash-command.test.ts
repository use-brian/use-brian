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
import { parseSlashCommand, buildSlashCommandBlock } from '../slash-command.js'

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
