/**
 * Unit tests for the skill loader.
 * Component tag: [COMP:skills/loader].
 *
 * Verifies parseSkillMarkdown — the markdown frontmatter parser — across
 * the Agent-Skills-Spec (`name` + `metadata:` block) and legacy flat
 * formats, required-field rejection, requires_connectors as a
 * comma-string vs a YAML array, category validation, applies_to_app_type,
 * and description truncation; plus loadBuiltinSkills caching.
 *
 * Markdown fixtures are built with `[...].join('\n')` so frontmatter
 * lines are flush-left — the hand-rolled YAML parser is indentation-
 * sensitive, and an indented template literal would corrupt the input.
 */

import { describe, it, expect } from 'vitest'
import {
  parseSkillMarkdown,
  loadBuiltinSkills,
  _resetBuiltinCache,
} from '../loader.js'

describe('[COMP:skills/loader] parseSkillMarkdown', () => {
  it('parses the Agent-Skills-Spec format (name + metadata block)', () => {
    const md = [
      '---',
      'name: research-helper',
      'description: Helps with research tasks',
      'metadata:',
      '  category: research',
      '  when_to_use: when the user asks for research',
      '---',
      'The skill body.',
    ].join('\n')
    const s = parseSkillMarkdown(md)
    expect(s).not.toBeNull()
    expect(s!.id).toBe('research-helper') // id falls back to name
    expect(s!.name).toBe('research-helper')
    expect(s!.category).toBe('research')
    expect(s!.whenToUse).toBe('when the user asks for research')
    expect(s!.content).toBe('The skill body.')
    expect(s!.source).toBe('builtin') // default source
  })

  it('parses the legacy flat format and the supplied source', () => {
    const md = [
      '---',
      'id: old-skill',
      'name: Old Skill',
      'description: A legacy skill',
      'category: productivity',
      'when_to_use: legacy usage note',
      'requires_connectors: gmail, gcal',
      '---',
      'Body text.',
    ].join('\n')
    const s = parseSkillMarkdown(md, 'user')
    expect(s!.id).toBe('old-skill')
    expect(s!.name).toBe('Old Skill')
    expect(s!.category).toBe('productivity')
    expect(s!.requiresConnectors).toEqual(['gmail', 'gcal'])
    expect(s!.source).toBe('user')
  })

  it('returns null when the file has no frontmatter', () => {
    expect(parseSkillMarkdown('Just plain text, no frontmatter.')).toBeNull()
  })

  it('returns null when a required field is missing', () => {
    const md = ['---', 'name: incomplete', '---', 'Body.'].join('\n')
    expect(parseSkillMarkdown(md)).toBeNull() // no description
  })

  it('parses requires_connectors given as a YAML array', () => {
    const md = [
      '---',
      'id: a',
      'name: A',
      'description: d',
      'requires_connectors:',
      '  - gmail',
      '  - notion',
      '---',
      'body',
    ].join('\n')
    expect(parseSkillMarkdown(md)!.requiresConnectors).toEqual(['gmail', 'notion'])
  })

  it('falls back to the custom category for an unknown category', () => {
    const md = [
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  category: bogus-category',
      '---',
      'body',
    ].join('\n')
    expect(parseSkillMarkdown(md)!.category).toBe('custom')
  })

  it('truncates an over-long description to 1024 chars', () => {
    const md = [
      '---',
      'name: x',
      'description: ' + 'x'.repeat(2000),
      '---',
      'body',
    ].join('\n')
    expect(parseSkillMarkdown(md)!.description.length).toBe(1024)
  })

  it('recognizes applies_to_app_type: distribution and ignores other values', () => {
    const dist = [
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  applies_to_app_type: distribution',
      '---',
      'body',
    ].join('\n')
    expect(parseSkillMarkdown(dist)!.appliesToAppType).toBe('distribution')

    const other = [
      '---',
      'name: x',
      'description: d',
      'metadata:',
      '  applies_to_app_type: webapp',
      '---',
      'body',
    ].join('\n')
    expect(parseSkillMarkdown(other)!.appliesToAppType).toBeUndefined()
  })
})

describe('[COMP:skills/loader] loadBuiltinSkills', () => {
  it('caches the result — repeated calls return the same array reference', () => {
    _resetBuiltinCache()
    const first = loadBuiltinSkills()
    const second = loadBuiltinSkills()
    expect(Array.isArray(first)).toBe(true)
    expect(second).toBe(first)
  })

  it('_resetBuiltinCache forces a fresh load (new reference, same content)', () => {
    _resetBuiltinCache()
    const a = loadBuiltinSkills()
    _resetBuiltinCache()
    const b = loadBuiltinSkills()
    expect(b).not.toBe(a)
    expect(b).toEqual(a)
  })
})
