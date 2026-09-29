import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const migration = (name: string) => readFile(
  new URL(`../../../migrations/${name}`, import.meta.url),
  'utf8',
)

describe('[COMP:api/context-scope-store] context scope migration contract', () => {
  it('allows workspace-wide derived conversation scope without accepting partial envelopes', async () => {
    const sql = (await migration('608_session_message_workspace_scope.sql'))
      .replace(/^\s*--[^\n]*$/gm, '').trim()
    expect(sql).toMatch(/^BEGIN;/)
    expect(sql).toMatch(/COMMIT;$/)
    expect(sql).toContain('DROP CONSTRAINT session_messages_scope_complete')
    expect(sql).toContain('ADD CONSTRAINT session_messages_scope_complete CHECK')
    expect(sql).not.toContain('assistant_id IS NOT NULL')
    for (const column of ['workspace_id', 'sensitivity', 'compartments', 'project_ids', 'scope_version', 'scope_held']) {
      expect(sql).toContain(`${column} IS NOT NULL`)
      expect(sql).toContain(`${column} IS NULL`)
    }
    expect(sql).toContain('user_id IS NULL AND assistant_id IS NULL')
  })

  it('wraps the saved-page policy repair in one transaction', async () => {
    const sql = (await migration('537_saved_views_scope_guc_casts.sql'))
      .replace(/^\s*--[^\n]*$/gm, '').trim()
    expect(sql).toMatch(/^BEGIN;\s+ALTER POLICY saved_views_workspace_member/)
    expect(sql).toMatch(/;\s+COMMIT;$/)
    expect(sql.match(/\bBEGIN\s*;/g)).toHaveLength(1)
    expect(sql.match(/\bCOMMIT\s*;/g)).toHaveLength(1)
  })

  it('keeps the four reserved migrations consecutive and append-only', async () => {
    const [primitives, principals, content, surfaces] = await Promise.all([
      migration('472_context_primitives.sql'),
      migration('473_context_principal_bindings.sql'),
      migration('474_project_scope_columns.sql'),
      migration('475_context_surface_bindings.sql'),
    ])
    expect(primitives).toContain('CREATE TABLE public.workspace_projects')
    expect(primitives).toContain('CREATE TABLE public.workspace_group_compartment_grants')
    expect(principals).toContain('CREATE FUNCTION public.effective_member_team_compartments')
    expect(principals).toContain('sessions_context_immutable_after_lock')
    expect(content).toContain('ADD COLUMN project_ids uuid[] NOT NULL DEFAULT')
    expect(content).toContain('CREATE FUNCTION public.validate_context_scope_arrays')
    expect(surfaces).toContain('linked_teamspace_roster_is_derived')
    expect(surfaces).toContain('context_task_project_backfill')
    expect(surfaces).toContain('lower(btrim(substr(tag.value, 9)))')
  })

  it('covers every universal Project root named by the architecture', async () => {
    const content = await migration('474_project_scope_columns.sql')
    for (const table of [
      'memories',
      'tasks',
      'workspace_files',
      'entities',
      'entity_links',
      'episodes',
      'file_cache',
      'knowledge_entries',
      'kb_chunks',
      'file_segments',
      'transcript_segments',
      'recordings',
      'entity_instances',
      'blueprint_records',
      'office_artifacts',
    ]) {
      expect(content, `missing Project schema for ${table}`).toContain(table)
      expect(content, `missing Project GIN for ${table}`).toContain(`${table}_project_ids_gin`)
    }
  })
})
