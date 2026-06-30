/**
 * Maps a slash-menu block kind to an editor-command descriptor. Pure (no
 * Tiptap import) so it unit-tests standalone; `collab-page-editor` interprets
 * the descriptor into a `editor.chain()` command. On the single whole-page
 * Tiptap doc this replaces the per-block transform/insert juggling the old
 * `page-renderer` deferred.
 *
 * [COMP:app-web/slash-actions]
 */

import type { SlashMenuBlockKind } from './slash-menu'

export type EmbedKind =
  | 'image'
  | 'file'
  | 'bookmark'
  | 'video'
  | 'audio'
  | 'data'
  | 'chart'
  | 'diagram'
  | 'extraction_slot'

export type SlashAction =
  | { command: 'setParagraph' }
  | { command: 'setHeading'; level: 1 | 2 | 3 | 4 }
  | { command: 'toggleBulletList' }
  | { command: 'toggleOrderedList' }
  | { command: 'toggleTaskList' }
  | { command: 'setToggle' }
  | { command: 'setBlockquote' }
  | { command: 'setCallout' }
  | { command: 'setCodeBlock' }
  | { command: 'insertDivider' }
  | { command: 'insertTable' }
  | { command: 'insertEmbed'; block: EmbedKind }
  // Async / picker actions — `executeSlashItem` is a no-op for these; the
  // editor's slash `onSelect` (in `collab-page-editor`) intercepts them
  // because they need workspace context + the router + a page picker / the
  // template gallery.
  | { command: 'createChildPage' }
  | { command: 'linkToPage' }
  | { command: 'openTemplateGallery' }

/** Every slash kind, for exhaustiveness checks + tests. */
export const ALL_SLASH_KINDS: readonly SlashMenuBlockKind[] = [
  'text',
  'heading',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'toggle',
  'table',
  'quote',
  'callout',
  'code',
  'divider',
  'image',
  'video',
  'audio',
  'file',
  'bookmark',
  'data',
  'chart',
  'diagram',
  'extraction_slot',
  'child_page',
  'link_to_page',
  'template',
]

export function slashActionFor(kind: SlashMenuBlockKind): SlashAction {
  switch (kind) {
    case 'text':
      return { command: 'setParagraph' }
    case 'heading':
      return { command: 'setHeading', level: 1 }
    case 'bulleted_list_item':
      return { command: 'toggleBulletList' }
    case 'numbered_list_item':
      return { command: 'toggleOrderedList' }
    case 'to_do':
      return { command: 'toggleTaskList' }
    case 'toggle':
      return { command: 'setToggle' }
    case 'quote':
      return { command: 'setBlockquote' }
    case 'callout':
      return { command: 'setCallout' }
    case 'code':
      return { command: 'setCodeBlock' }
    case 'divider':
      return { command: 'insertDivider' }
    case 'table':
      return { command: 'insertTable' }
    case 'image':
    case 'file':
    case 'bookmark':
    case 'video':
    case 'audio':
    case 'data':
    case 'chart':
    case 'diagram':
    case 'extraction_slot':
      return { command: 'insertEmbed', block: kind }
    case 'child_page':
      return { command: 'createChildPage' }
    case 'link_to_page':
      return { command: 'linkToPage' }
    case 'template':
      return { command: 'openTemplateGallery' }
  }
}
