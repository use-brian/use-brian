import { describe, it, expect } from 'vitest'
import { slashActionFor, ALL_SLASH_KINDS } from '../slash-actions.js'

describe('[COMP:app-web/slash-actions] slashActionFor', () => {
  it('maps every slash kind to a defined command', () => {
    for (const kind of ALL_SLASH_KINDS) {
      expect(slashActionFor(kind).command).toBeTruthy()
    }
  })

  it('maps prose kinds to their node commands', () => {
    expect(slashActionFor('text')).toEqual({ command: 'setParagraph' })
    expect(slashActionFor('heading')).toEqual({ command: 'setHeading', level: 1 })
    expect(slashActionFor('bulleted_list_item')).toEqual({ command: 'toggleBulletList' })
    expect(slashActionFor('numbered_list_item')).toEqual({ command: 'toggleOrderedList' })
    expect(slashActionFor('to_do')).toEqual({ command: 'toggleTaskList' })
    expect(slashActionFor('quote')).toEqual({ command: 'setBlockquote' })
    expect(slashActionFor('code')).toEqual({ command: 'setCodeBlock' })
    expect(slashActionFor('divider')).toEqual({ command: 'insertDivider' })
  })

  it('routes every embed kind (incl. video/audio) through insertEmbed carrying its block', () => {
    for (const block of ['image', 'file', 'bookmark', 'video', 'audio', 'data', 'chart'] as const) {
      expect(slashActionFor(block)).toEqual({ command: 'insertEmbed', block })
    }
  })

  it('maps heading at level 4 (Notion H4) and routes the editor-handled kinds', () => {
    expect(slashActionFor('child_page')).toEqual({ command: 'createChildPage' })
    expect(slashActionFor('link_to_page')).toEqual({ command: 'linkToPage' })
  })
})
