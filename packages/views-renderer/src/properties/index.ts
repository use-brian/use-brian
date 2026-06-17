/**
 * Property registry — keyed by `PropertyKind`. The Table widget reads
 * `column.kind` and dispatches through `PROPERTIES[kind]` to render
 * cells, icons, and (Phase 2) editors. Columns without `kind` fall
 * through to legacy `renderRowValue`.
 *
 * Typed as `Partial<Record<PropertyKind, PropertyModule>>` because the
 * doc-v1 PropertyKind union (status, files, created_*, last_edited_*)
 * is being added in batched PRs — the registry surface grows as each
 * batch lands. Consumers (`Table.tsx`, `render.tsx`) already truthy-check
 * the dispatch result, so missing entries fall through to the legacy
 * `renderRowValue` path.
 *
 * [COMP:views/properties]
 */

import type { PropertyKind } from '../types.js'
import type { PropertyModule } from './types.js'
import { TextProperty } from './text.js'
import { SelectProperty } from './select.js'
import { TagsProperty } from './tags.js'
import { PersonProperty } from './person.js'
import { RelationProperty } from './relation.js'
import { DateProperty } from './date.js'
import { NumberProperty } from './number.js'
import { FilesProperty } from './files.js'
import { CheckboxProperty } from './checkbox.js'
import { UrlProperty } from './url.js'
import { EmailProperty } from './email.js'
import { PhoneProperty } from './phone.js'
import { StatusProperty } from './status.js'
import { CreatedTimeProperty } from './created-time.js'
import { LastEditedTimeProperty } from './last-edited-time.js'
import { CreatedByProperty } from './created-by.js'
import { LastEditedByProperty } from './last-edited-by.js'

export const PROPERTIES: Partial<Record<PropertyKind, PropertyModule>> = {
  text: TextProperty,
  select: SelectProperty,
  tags: TagsProperty,
  person: PersonProperty,
  relation: RelationProperty,
  date: DateProperty,
  number: NumberProperty,
  files: FilesProperty,
  status: StatusProperty,
  checkbox: CheckboxProperty,
  url: UrlProperty,
  email: EmailProperty,
  phone: PhoneProperty,
  created_time: CreatedTimeProperty,
  created_by: CreatedByProperty,
  last_edited_time: LastEditedTimeProperty,
  last_edited_by: LastEditedByProperty,
}

export type { PropertyModule } from './types.js'

// Helper consumed by the Gallery view (P3F in Batch 2) to pick a card
// cover image. Co-located with the Files property so the "first image
// wins" policy lives next to the Cell that already applies it.
export { getCoverImageRef } from './files.js'
