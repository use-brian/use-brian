import { readFile, readdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

const migrations = new URL('../../../migrations/', import.meta.url)
const files = ['604_workspace_decision_routing.sql', '605_decision_evaluation_profiles.sql',
  '8259_workspace_decision_shadow_sampling.sql', '8260_workspace_decision_classifier_first.sql']
const user = '00000000-0000-4000-8000-000000000001'
const workspace = '00000000-0000-4000-8000-000000000002'
const otherWorkspace = '00000000-0000-4000-8000-000000000003'

describe('[COMP:decisions/workspace-routing] migration upgrade compatibility', () => {
  it('assigns unique numeric migration IDs to the two new workspace settings changes', async () => {
    const names = await readdir(migrations)
    for (const file of files.slice(2)) {
      const number = Number(file.split('_')[0])
      expect(names.filter(name => Number(name.split('_')[0]) === number)).toEqual([file])
    }
  })

  it('upgrades the real 604/605 schema without losing rows, RLS, grants or target constraints', async () => {
    const db = new PGlite()
    try {
      await db.exec(`
        CREATE TABLE users (id UUID PRIMARY KEY);
        CREATE TABLE workspaces (id UUID PRIMARY KEY);
        CREATE TABLE workspace_members (workspace_id UUID, user_id UUID);
        INSERT INTO users VALUES ('${user}');
        INSERT INTO workspaces VALUES ('${workspace}'), ('${otherWorkspace}');
        INSERT INTO workspace_members VALUES ('${workspace}', '${user}');
      `)
      for (const file of files.slice(0, 2)) await db.exec(await readFile(new URL(file, migrations), 'utf8'))
      await db.exec(`
        INSERT INTO workspace_decision_routing (workspace_id, mode, model_alias, updated_by_user_id)
          VALUES ('${workspace}', 'shadow', 'typesafe-jev-1.13', '${user}'), ('${otherWorkspace}', 'llm_only', NULL, NULL);
        CREATE ROLE decision_migration_member NOLOGIN;
        GRANT USAGE ON SCHEMA public TO decision_migration_member;
        GRANT SELECT ON workspace_members TO decision_migration_member;
        GRANT SELECT, INSERT, UPDATE ON workspace_decision_routing TO decision_migration_member;
      `)
      const before = (await db.query('SELECT workspace_id, mode, model_alias, updated_by_user_id FROM workspace_decision_routing ORDER BY workspace_id')).rows
      const policies = (await db.query("SELECT policyname, qual, with_check FROM pg_policies WHERE tablename='workspace_decision_routing'")).rows
      for (const file of files.slice(2)) await db.exec(await readFile(new URL(file, migrations), 'utf8'))
      expect((await db.query('SELECT workspace_id, mode, model_alias, updated_by_user_id FROM workspace_decision_routing ORDER BY workspace_id')).rows).toEqual(before)
      expect((await db.query('SELECT shadow_sample_rate FROM workspace_decision_routing')).rows).toEqual([{ shadow_sample_rate: 0.1 }, { shadow_sample_rate: 0.1 }])
      expect((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='workspace_decision_routing'::regclass")).rows).toEqual([{ relrowsecurity: true }])
      expect((await db.query("SELECT policyname, qual, with_check FROM pg_policies WHERE tablename='workspace_decision_routing'")).rows).toEqual(policies)
      for (const mode of ['shadow', 'hybrid', 'classifier_first']) {
        await expect(db.query('UPDATE workspace_decision_routing SET mode=$1, model_alias=NULL WHERE workspace_id=$2', [mode, workspace])).rejects.toThrow()
      }
      await expect(db.query("UPDATE workspace_decision_routing SET mode='llm_only' WHERE workspace_id=$1", [workspace])).rejects.toThrow()
      await expect(db.query('UPDATE workspace_decision_routing SET shadow_sample_rate=0.5 WHERE workspace_id=$1', [workspace])).rejects.toThrow()
      await db.query("UPDATE workspace_decision_routing SET mode='classifier_first' WHERE workspace_id=$1", [workspace])
      await db.query("SELECT set_config('app.current_user_id', $1, false)", [user])
      await db.exec('SET ROLE decision_migration_member')
      expect((await db.query('SELECT workspace_id, mode FROM workspace_decision_routing')).rows).toEqual([{ workspace_id: workspace, mode: 'classifier_first' }])
      expect((await db.query('UPDATE workspace_decision_routing SET shadow_sample_rate=1 WHERE workspace_id=$1 RETURNING shadow_sample_rate', [workspace])).rows).toEqual([{ shadow_sample_rate: 1 }])
      expect((await db.query('UPDATE workspace_decision_routing SET shadow_sample_rate=1 WHERE workspace_id=$1 RETURNING workspace_id', [otherWorkspace])).rows).toEqual([])
      await db.exec('RESET ROLE')
    } finally { await db.close() }
  }, 30_000)
})
