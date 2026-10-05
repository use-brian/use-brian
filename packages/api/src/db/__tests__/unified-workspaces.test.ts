import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../../../migrations/664_unified_workspaces.sql', import.meta.url), 'utf8')
const namingMigration = readFileSync(new URL('../../../migrations/665_workspace_primary_names.sql', import.meta.url), 'utf8')
const owner = '00000000-0000-4000-8000-000000000001'
const recipient = '00000000-0000-4000-8000-000000000002'
const first = '00000000-0000-4000-8000-000000000003'
const second = '00000000-0000-4000-8000-000000000004'

describe('[COMP:api/workspace-store] unified workspace migration', () => {
  it('preserves both signup workspaces, transfers between their owners, and permits deletion of the last workspace', async () => {
    const db = new PGlite()
    try {
      await db.exec(`
        CREATE TABLE users(id uuid PRIMARY KEY);
        CREATE TABLE workspaces(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name text, is_personal boolean NOT NULL DEFAULT false);
        CREATE UNIQUE INDEX workspaces_owner_personal_unique ON workspaces(owner_user_id) WHERE is_personal;
        CREATE TABLE assistants(id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
          owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE, kind text);
        CREATE TABLE assistant_members(assistant_id uuid REFERENCES assistants(id) ON DELETE CASCADE, user_id uuid REFERENCES users(id) ON DELETE CASCADE);
        INSERT INTO users VALUES('${owner}'),('${recipient}');
        INSERT INTO workspaces VALUES('${first}','${owner}','First',true),('${second}','${recipient}','Second',true);
        INSERT INTO assistants VALUES('${first}','${first}','${owner}','primary');
        INSERT INTO assistant_members VALUES('${first}','${owner}');
      `)
      await db.exec(migration)
      expect((await db.query('SELECT default_workspace_id FROM users ORDER BY id')).rows).toEqual([
        { default_workspace_id: first }, { default_workspace_id: second },
      ])
      expect((await db.query('SELECT * FROM assistant_members')).rows).toEqual([])
      // Previously the recipient's own signup workspace made this violate the unique index.
      await db.query('UPDATE workspaces SET owner_user_id=$1 WHERE id=$2', [recipient, first])
      expect((await db.query('SELECT default_workspace_id FROM users ORDER BY id')).rows).toEqual([
        { default_workspace_id: null }, { default_workspace_id: second },
      ])
      // Deleting the former owner's account must not cascade into the transferred primary.
      await db.query('DELETE FROM users WHERE id=$1', [owner])
      expect((await db.query('SELECT workspace_id,owner_user_id FROM assistants')).rows).toEqual([
        { workspace_id: first, owner_user_id: null },
      ])
      expect((await db.query('SELECT name FROM workspaces ORDER BY name')).rows).toEqual([{ name: 'First' }, { name: 'Second' }])
      await db.query('DELETE FROM workspaces WHERE owner_user_id=$1', [recipient])
      expect((await db.query('SELECT default_workspace_id FROM users')).rows).toEqual([{ default_workspace_id: null }])
      expect((await db.query('SELECT * FROM assistants')).rows).toEqual([])
      // Creating another workspace after an empty account seeds routing without a new type.
      await db.query('INSERT INTO workspaces(id,owner_user_id,name) VALUES($1,$2,$3)', [first,recipient,'New'])
      expect((await db.query('SELECT default_workspace_id FROM users')).rows).toEqual([{ default_workspace_id: first }])
    } finally { await db.close() }
  }, 30_000)
  it('names generated primaries after their workspace, follows renames and preserves custom names', async () => {
    const db = new PGlite()
    try {
      await db.exec(`
        CREATE TABLE workspaces(id uuid PRIMARY KEY, name text);
        CREATE TABLE assistants(id uuid PRIMARY KEY, workspace_id uuid, name text, kind text, updated_at timestamptz);
        INSERT INTO workspaces VALUES('${first}', 'Acme'),('${second}', 'Other');
        INSERT INTO assistants VALUES('${first}','${first}','Acme','primary',now()),
          ('${second}','${second}','Custom helper','primary',now());
      `)
      await db.exec(namingMigration)
      for (const [input,expected] of [["Sam's workspace","Sam Brian"],["Sam’s workspace","Sam Brian"],['Acme workspace','Acme Brian'],['workspace','Brian'],['Acme Brian','Acme Brian'],['  Acme  ','Acme Brian']]) {
        expect((await db.query<{name:string}>('SELECT workspace_primary_name($1) AS name',[input])).rows[0].name).toBe(expected)
      }
      expect((await db.query('SELECT name FROM assistants ORDER BY id')).rows).toEqual([{name:'Acme Brian'},{name:'Custom helper'}])
      await db.query('UPDATE workspaces SET name=$1 WHERE id=$2',['Renamed workspace',first])
      await db.query('UPDATE workspaces SET name=$1 WHERE id=$2',['Other renamed',second])
      expect((await db.query('SELECT name FROM assistants ORDER BY id')).rows).toEqual([{name:'Renamed Brian'},{name:'Custom helper'}])
    } finally { await db.close() }
  }, 30_000)

})
