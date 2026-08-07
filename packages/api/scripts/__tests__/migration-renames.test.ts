import { describe, expect, it } from 'vitest'
import { findAppliedMigrationRenames } from '../migration-renames.js'

describe('[COMP:api/migration-order] Migration filename compatibility', () => {
  it('aliases applied Office migrations to their collision-free names', () => {
    const aliases = findAppliedMigrationRenames(
      new Set([
        '394_office_artifacts.sql',
        '395_office_templates_resources.sql',
        '3943_office_collaboration.sql',
      ]),
    )

    expect(aliases).toEqual([
      {
        previousName: '394_office_artifacts.sql',
        currentName: '3941_office_artifacts.sql',
      },
      {
        previousName: '395_office_templates_resources.sql',
        currentName: '3942_office_templates_resources.sql',
      },
    ])
  })
})
