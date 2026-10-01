import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL('../../../migrations/621_workspace_access_modes.sql', import.meta.url),
  'utf8',
)
const sql = migration.replace(/--[^\n]*/g, '')
const body = (name: string) => {
  const start = sql.indexOf(`CREATE FUNCTION public.${name}()`)
  expect(start).toBeGreaterThan(-1)
  return sql.slice(start, sql.indexOf('$$;', start) + 3)
}

describe('workspace access modes schema foundation (static, not database integration)', () => {
  it('preserves upgrade behavior and leaves provisioning activation explicit', () => {
    expect(sql).toContain("access_mode text NOT NULL DEFAULT 'departments'")
    expect(sql).toContain("setup_state text NOT NULL DEFAULT 'legacy'")
    expect(sql).not.toMatch(/(?:SET|ADD COLUMN)\s+classification_mode/i)
    expect(sql).not.toMatch(/ON public\.workspaces\s+FOR EACH ROW/i)
    expect(sql).not.toMatch(/UPDATE public\.(?:memories|sessions|workspace_members|assistants) SET (?:role|clearance|compartments|project)/i)
  })

  it('requires a workspace-local active Team and a finite ordinary Simple package', () => {
    expect(sql).toContain('FOREIGN KEY(workspace_id,default_department_id)')
    expect(sql).toContain('REFERENCES public.workspace_groups(workspace_id,id)')
    expect(sql).toContain("CHECK(access_mode <> 'simple' OR default_department_id IS NOT NULL)")
    const guard = body('guard_workspace_access_mode')
    expect(guard).toContain("g.kind='team' AND g.status='active'")
    expect(guard).toContain('NOT g.read_all')
    expect(guard).toContain('b.compartment_key<>g.compartment_key')
    expect(guard).toContain('access_policy_delete_forbidden')
    expect(guard).not.toContain('app.system_bypass')
  })

  it('guards reverse mutations after the existing canonical revision trigger', () => {
    expect(sql).toContain('zz_workspace_default_guard BEFORE UPDATE OR DELETE ON public.workspace_groups')
    expect(sql).toContain('zz_workspace_default_guard BEFORE INSERT OR UPDATE ON public.workspace_group_compartment_grants')
    const guard = body('guard_workspace_default_package')
    expect(guard).toContain("TG_OP='DELETE'")
    expect(guard).toContain("NEW.status<>'active'")
    expect(guard).toContain('NEW.read_all')
    expect(guard).toContain('access_mode_default_package_widened')
    expect(guard).not.toContain('app.system_bypass')
  })

  it('reuses policy revision, immutable event storage, and configuration notifications', () => {
    expect(body('guard_workspace_access_mode')).toContain('NEW.revision := OLD.revision+1')
    const audit = body('audit_workspace_access_mode')
    expect(audit).toContain('INSERT INTO public.workspace_access_events')
    expect(audit).toContain("'workspace.access_mode.set'")
    expect(audit).toContain("pg_notify('brain_events'")
  })

  it('allows canonical revision-only UPSERTs without recursion or resetting their increment', () => {
    const canonical = readFileSync(
      new URL('../../../migrations/566_department_read_requests.sql', import.meta.url), 'utf8',
    )
    expect(canonical).toContain('ON CONFLICT(workspace_id) DO UPDATE SET revision=workspace_access_policies.revision+1')
    expect(canonical).toContain('CREATE TRIGGER workspace_access_revision BEFORE INSERT OR UPDATE OR DELETE')
    const guard = body('guard_workspace_access_mode')
    expect(guard).toContain('ROW(NEW.access_mode,NEW.default_department_id,NEW.setup_state)')
    expect(guard).toContain('IS DISTINCT FROM ROW(OLD.access_mode,OLD.default_department_id,OLD.setup_state) THEN')
    expect(guard).not.toMatch(/(?:INSERT INTO|UPDATE) public\.workspace_access_policies/)
    expect(guard).not.toContain('advance_workspace_access_policy(')
    expect(body('audit_workspace_access_mode')).not.toMatch(/(?:INSERT INTO|UPDATE) public\.workspace_access_policies/)
    expect(body('guard_workspace_default_package')).toContain("TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM public.workspaces")
  })

  it('inserts grants after principals exist and before assigned assistant defaults', () => {
    expect(sql).toContain('workspace_simple_member_admission AFTER INSERT ON public.workspace_members')
    expect(sql).toContain('workspace_simple_assistant_admission AFTER INSERT ON public.assistants')
    const admission = body('admit_simple_workspace_principal')
    expect(admission).toContain("access_mode='simple' FOR UPDATE")
    expect(admission).toContain('INSERT INTO public.workspace_group_members')
    expect(admission).toContain("NEW.owner_user_id IS NULL OR NEW.kind IN ('primary','app')")
    expect(admission.indexOf('INSERT INTO public.workspace_group_assistants')).toBeLessThan(admission.indexOf('UPDATE public.assistants'))
    expect(admission).toContain('coalesce(default_workspace_group_id,department)')
    expect(admission).not.toMatch(/SET\s+(?:role|clearance|compartments|sharing_mode|owner_user_id|project_scope_mode|default_project_id)/i)
    expect(admission).not.toContain("team_scope_mode='all'")
    expect(admission).not.toContain('read_all')
  })

  it('stores resumable versioned plans with one active transition including paused/stale plans', () => {
    for (const field of ['actor_user_id', 'source_mode', 'target_mode', 'manifest_revision', 'schema_revision', 'policy_revision', 'inventory_revision', 'generation', 'proposal_hash', 'expires_at', 'idempotency_key', 'version', 'status']) {
      expect(sql).toContain(`${field} `)
    }
    expect(sql).toContain("WHERE status NOT IN ('completed','cancelled')")
    expect(sql).toContain('UNIQUE(workspace_id,actor_user_id,idempotency_key)')
    expect(sql).toContain('UNIQUE(plan_id,idempotency_key)')
    expect(body('guard_workspace_access_migration')).toContain('NEW.version:=OLD.version+1')
  })

  it('keeps plans, saved reviews, and typed subjects workspace-local', () => {
    for (const reference of ['plan_id', 'command_review_id', 'scope_review_id']) {
      expect(sql).toContain(`FOREIGN KEY(workspace_id,${reference})`)
    }
    const guard = body('guard_workspace_access_migration')
    expect(guard).toContain("role IN ('owner','admin')")
    expect(guard).toContain('public.read_scope_source(NEW.workspace_id,NEW.subject_kind,NEW.subject_id)')
    expect(guard).toContain('access_migration_subject_invalid')
    expect(guard).toContain('access_migration_identity_immutable')
  })

  it('restricts raw storage reads to admins and writes to the existing system pattern', () => {
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
    expect(sql).toContain("role IN(''owner'',''admin'')")
    expect(sql).toContain("WITH CHECK(current_setting(''app.system_bypass'',true)=''true'')")
    const names = [...sql.matchAll(/CREATE FUNCTION public\.(\w+)\(\)/g)].map(match => match[1])
    expect(names).toHaveLength(5)
    for (const name of names) {
      expect(body(name)).toContain('SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp')
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${name}() FROM PUBLIC`)
    }
    expect(sql).not.toMatch(/GRANT\s/i)
    expect(sql).not.toMatch(/CREATE TABLE.*connector/i)
  })
})
