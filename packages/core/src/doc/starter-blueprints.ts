/**
 * Starter blueprints — the installable catalog.
 *
 * A blueprint is a `workspace_page_templates` ROW carrying an `extraction`
 * contract; `isBlueprint(t) = t.extraction != null` makes blueprint-ness a
 * property of a row, not of a slug. That is why `BUILTIN_BLUEPRINT_SLUGS` is `[]`
 * and stays `[]`: a hardcoded slug would be a blueprint with no row — invisible
 * to `listPageTemplates`, unable to satisfy `workspaces.default_recording_blueprint_id`
 * (which takes a template id), and uneditable and undeletable by the team that
 * depends on it. The silent-invisible-object bug, by construction.
 *
 * So a starter is not a blueprint. It is the BLOCKS of one, and installing it
 * mints a real row the workspace owns through the same create path the editor
 * uses. After install there is nothing special about it: it can be edited,
 * renamed, or deleted like any other, and this module never hears about it again.
 *
 * The blocks (not the spec) are the source shape deliberately: `heading` +
 * `extraction_slot` pairs are what the WYSIWYG editor authors, so a starter
 * round-trips through `blocksToExtractionSpec` / `extractionSpecToBlocks` with no
 * second code path minting specs a human could not have authored.
 *
 * NOT auto-seeded on workspace creation: an unowned default nobody edits is how
 * you get 400 identical dead templates. Install is offered at the one moment the
 * user has demonstrated intent — the recording upload confirm.
 *
 * [COMP:doc/starter-blueprints]
 */

import type { Block } from '../views/blocks.js'
import {
  blocksToExtractionSpec,
  type BlueprintCaptureKind,
  type ExtractionSpec,
} from './custom-template-types.js'

export type StarterBlueprint = {
  /** Stable identity for the install UI. NOT a blueprint slug — nothing resolves a blueprint by this. */
  id: string
  name: string
  description: string
  blocks: Block[]
  capture: BlueprintCaptureKind[]
}

type Section = {
  key: string
  heading: string
  instruction: string
  outputType: 'prose' | 'list' | 'table'
  required?: boolean
}

/**
 * The meeting-notes sections, hand-authored and validated against a 96-minute
 * Cantonese meeting.
 *
 * Only four are `required`: those are the ones whose absence means the fill
 * FAILED rather than the meeting simply not having had that content. A meeting
 * with no notable quotes is normal; a meeting brief with no summary is broken.
 * Marking everything required would stamp every honest brief `incomplete` and
 * teach the team to ignore the status.
 *
 * Each instruction ends by demanding the `[H:MM:SS]` citation, because that text
 * is what the render-time decoration turns into a seek link and what the write
 * path resolves into a typed pointer (migration 333). An instruction that forgets
 * to ask for it produces a section you cannot click.
 */
const MEETING_SECTIONS: Section[] = [
  {
    key: 'summary',
    heading: 'Summary',
    instruction:
      'A short paragraph covering what this meeting was for and what came out of it, end to end. Write it so someone who missed the call knows where things stand. Cite the moment for each claim as [H:MM:SS].',
    outputType: 'prose',
    required: true,
  },
  {
    key: 'context',
    heading: 'Context and background',
    instruction:
      'The situation the meeting starts from: what happened before it, what the participants already agreed or disputed, and any constraint named as given. Only what is stated in the recording. Cite each with [H:MM:SS].',
    outputType: 'prose',
  },
  {
    key: 'key-points',
    heading: 'Key points discussed',
    instruction:
      'The substantive points raised, in the order they came up, covering the whole recording rather than the opening. One bullet per point, attributing the speaker where diarization named one. Cite each with [H:MM:SS].',
    outputType: 'list',
    required: true,
  },
  {
    key: 'pain-points',
    heading: 'Pain points and needs',
    instruction:
      'Problems, blockers, frustrations, and unmet needs that participants voiced. Use their framing, not a rephrasing that softens it. Cite each with [H:MM:SS].',
    outputType: 'list',
  },
  {
    key: 'options',
    heading: 'Ideas and options considered',
    instruction:
      'Approaches that were floated, including the ones rejected and why. An option nobody chose is still worth recording. Cite each with [H:MM:SS].',
    outputType: 'list',
  },
  {
    key: 'decisions',
    heading: 'Decisions',
    instruction:
      'What was actually decided, and by whom. Only decisions stated in the recording: if the group leaned toward something without settling it, put it under ideas and options instead. Cite each with [H:MM:SS].',
    outputType: 'list',
    required: true,
  },
  {
    key: 'action-items',
    heading: 'Action items and next steps',
    instruction:
      'Each committed action, with its owner and any due date that was said aloud. Leave the owner unresolved rather than guessing. Cite the moment the commitment was made as [H:MM:SS].',
    outputType: 'list',
    required: true,
  },
  {
    key: 'quotes',
    heading: 'Notable quotes',
    instruction:
      'A few verbatim lines worth preserving, in the language they were spoken. Quote exactly, never translate or clean them up. Cite each with [H:MM:SS].',
    outputType: 'list',
  },
]

function sectionsToBlocks(sections: Section[]): Block[] {
  const blocks: Block[] = []
  sections.forEach((s, i) => {
    blocks.push({ kind: 'heading', id: `starter-meeting-${i}-h`, level: 2, text: s.heading })
    blocks.push({
      kind: 'extraction_slot',
      id: `starter-meeting-${i}-s`,
      instruction: s.instruction,
      outputType: s.outputType,
      fieldKey: s.key,
      fieldType: 'markdown',
      ...(s.required ? { required: true } : {}),
    })
  })
  return blocks
}

export const MEETING_NOTES_STARTER: StarterBlueprint = {
  id: 'meeting-notes',
  name: 'Meeting notes',
  description:
    'Summary, decisions, and action items from a recording, each citing the moment it came from.',
  blocks: sectionsToBlocks(MEETING_SECTIONS),
  // Action items become real tasks and attendees become contacts, back-edged to
  // the recording's episode — the brief is a view, the brain rows are the durable
  // half.
  capture: ['task', 'contact'],
}

export const STARTER_BLUEPRINTS: StarterBlueprint[] = [MEETING_NOTES_STARTER]

export function findStarterBlueprint(id: string): StarterBlueprint | null {
  return STARTER_BLUEPRINTS.find((s) => s.id === id) ?? null
}

/**
 * The spec a starter installs as — derived through the SAME function the editor
 * uses, never hand-written. If a starter could produce a spec `blocksToExtractionSpec`
 * would not, it could not be edited after install.
 */
export function starterExtractionSpec(starter: StarterBlueprint): ExtractionSpec | null {
  return blocksToExtractionSpec(starter.blocks, starter.capture)
}
