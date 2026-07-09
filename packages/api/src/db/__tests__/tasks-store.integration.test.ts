import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'

/**
 * Integration test for createDbTaskStore + the tasks RLS / trigger surface
 * defined in migration 113. Requires a local PostgreSQL database named
 * `sidanclaw` with that migration applied. Skips silently when the DB is
 * unavailable.
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT 1 FROM tasks LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'tasks-' || gen_random_uuid())
     RETURNING id`,
  )
  return r.rows[0].id
}

async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  // is_personal=false: tests can create N workspaces per owner without
  // colliding with the workspaces_owner_personal_unique partial index.
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'tasks-test-ws', 'test', $1, false)
     RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}

async function addMember(client: pg.PoolClient, workspaceId: string, userId: string, role = 'owner'): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, $3)
     RETURNING id`,
    [workspaceId, userId, role],
  )
  return r.rows[0].id
}

describeIf('[COMP:api/tasks-store] tasks store + RLS (integration)', () => {
  let store: typeof import('../tasks-store.js') extends { createDbTaskStore: infer T }
    ? T extends () => infer R ? R : never
    : never

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const mod = await import('../tasks-store.js')
    store = mod.createDbTaskStore()
  })

  describe('CRUD round-trip', () => {
    let userId: string
    let workspaceId: string
    let memberId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        memberId = await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('create + getById round trip', async () => {
      const task = await store.create({
        userId, workspaceId,
        title: 'Ship migration 113',
        assigneeId: memberId,
        tags: ['q1', 'tasks'],
        externalRef: { provider: 'linear', id: 'ENG-1' },
      })
      expect(task.title).toBe('Ship migration 113')
      expect(task.status).toBe('todo')
      expect(task.assigneeId).toBe(memberId)
      expect(task.externalRef).toEqual({ provider: 'linear', id: 'ENG-1' })

      const fetched = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, task.id)
      expect(fetched).not.toBeNull()
      expect(fetched!.id).toBe(task.id)
      expect(fetched!.workspaceId).toBe(workspaceId)
    })

    it('list filters by status and tag, excludes archived by default', async () => {
      await store.create({ userId, workspaceId, title: 'open', status: 'todo', tags: ['eng'] })
      await store.create({ userId, workspaceId, title: 'in_progress', status: 'in_progress', tags: ['eng'] })
      await store.create({ userId, workspaceId, title: 'archived', status: 'archived', tags: ['eng'] })

      const active = await store.list({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { tag: 'eng' })
      expect(active.map((r) => r.title).sort()).toEqual(['in_progress', 'open'])

      const all = await store.list({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { includeArchived: true, tag: 'eng' })
      expect(all).toHaveLength(3)
    })

    it('update patches and bumps updated_at', async () => {
      const task = await store.create({ userId, workspaceId, title: 'Original' })
      const original = task.updatedAt.getTime()
      await new Promise((resolve) => setTimeout(resolve, 10))
      const updated = await store.update(userId, task.id, { title: 'Renamed' })
      expect(updated).not.toBeNull()
      expect(updated!.title).toBe('Renamed')
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(original)
    })

    it('update returns null for a non-existent id', async () => {
      const result = await store.update(userId, '00000000-0000-0000-0000-000000000000', { title: 'X' })
      expect(result).toBeNull()
    })

    it('sub-task creation preserves parent_id', async () => {
      const parent = await store.create({ userId, workspaceId, title: 'Parent' })
      const child = await store.create({
        userId, workspaceId,
        title: 'Sub-task',
        parentId: parent.id,
      })
      expect(child.parentId).toBe(parent.id)
    })

    it('cross-workspace parent_id is rejected by the trigger', async () => {
      const client = await pool!.connect()
      let otherWorkspaceId: string
      try {
        otherWorkspaceId = await makeWorkspace(client, userId)
        await addMember(client, otherWorkspaceId, userId)
      } finally {
        client.release()
      }
      // Create a parent task in the OTHER workspace via system-bypass.
      const parent = await store.create({ userId, workspaceId: otherWorkspaceId, title: 'Other parent' })
      // Attempt to create a child in the FIRST workspace pointing at it.
      await expect(
        store.create({ userId, workspaceId, title: 'Child', parentId: parent.id }),
      ).rejects.toThrow(/parent_id must reference a task in the same workspace/i)
    })

    it('CASCADE: deleting the workspace removes its tasks', async () => {
      const task = await store.create({ userId, workspaceId, title: 'Will die with workspace' })
      const client = await pool!.connect()
      try {
        await client.query('DELETE FROM workspaces WHERE id = $1', [workspaceId])
      } finally {
        client.release()
      }
      const fetched = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, task.id)
      expect(fetched).toBeNull()
    })

    it('CASCADE on parent: deleting a parent removes its sub-tasks', async () => {
      const parent = await store.create({ userId, workspaceId, title: 'Parent' })
      const child = await store.create({ userId, workspaceId, title: 'Child', parentId: parent.id })
      const client = await pool!.connect()
      try {
        await client.query('DELETE FROM tasks WHERE id = $1', [parent.id])
      } finally {
        client.release()
      }
      const fetched = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, child.id)
      expect(fetched).toBeNull()
    })

    it('SET NULL on assignee: removing the workspace_members row clears assignee_id', async () => {
      const task = await store.create({ userId, workspaceId, title: 'With assignee', assigneeId: memberId })
      expect(task.assigneeId).toBe(memberId)
      const client = await pool!.connect()
      try {
        await client.query('DELETE FROM workspace_members WHERE id = $1', [memberId])
      } finally {
        client.release()
      }
      // `userId` is no longer a member of `workspaceId`, so RLS hides the
      // task. Re-query as system bypass via a different client to verify
      // the SET NULL semantics independently of the RLS view.
      const c = await pool!.connect()
      try {
        const r = await c.query<{ assignee_id: string | null }>(
          `SELECT assignee_id FROM tasks WHERE id = $1`,
          [task.id],
        )
        expect(r.rows[0].assignee_id).toBeNull()
      } finally {
        c.release()
      }
    })
  })

  // Create idempotency — a retry / double-fire of the same logical create
  // returns the existing task instead of a duplicate. Root cause of the prod
  // "duplicated tasks" incident (identical rows seconds apart, no dedupe).
  // See docs/architecture/features/tasks.md → "Create idempotency".
  describe('create idempotency', () => {
    let userId: string
    let workspaceId: string

    beforeEach(async () => {
      const client = await pool!.connect()
      try {
        userId = await makeUser(client)
        workspaceId = await makeWorkspace(client, userId)
        await addMember(client, workspaceId, userId)
      } finally {
        client.release()
      }
    })

    it('a second identical create within the window returns the same task (no duplicate row)', async () => {
      const first = await store.create({ userId, workspaceId, title: 'Clarify CLA requirements' })
      const second = await store.create({ userId, workspaceId, title: 'Clarify CLA requirements' })
      expect(second.id).toBe(first.id)

      const c = await pool!.connect()
      try {
        const r = await c.query<{ n: string }>(
          `SELECT count(*) AS n FROM tasks WHERE workspace_id = $1 AND title = $2 AND valid_to IS NULL`,
          [workspaceId, 'Clarify CLA requirements'],
        )
        expect(Number(r.rows[0].n)).toBe(1)
      } finally {
        c.release()
      }
    })

    it('deduped create does not fire onTaskCreate a second time (no duplicate draft goal)', async () => {
      const mod = await import('../tasks-store.js')
      const created: string[] = []
      const spyStore = mod.createDbTaskStore({ onTaskCreate: (t) => created.push(t.id) })
      const first = await spyStore.create({ userId, workspaceId, title: 'Add setup to task sidanclaw' })
      const second = await spyStore.create({ userId, workspaceId, title: 'Add setup to task sidanclaw' })
      expect(second.id).toBe(first.id)
      expect(created).toEqual([first.id]) // fired exactly once
    })

    it('placeholder blank-row title is exempt — two "Untitled task" rows are allowed', async () => {
      const a = await store.create({ userId, workspaceId, title: 'Untitled task' })
      const b = await store.create({ userId, workspaceId, title: 'Untitled task' })
      expect(b.id).not.toBe(a.id)
    })

    it('a different status is not treated as a duplicate', async () => {
      const todo = await store.create({ userId, workspaceId, title: 'Same title', status: 'todo' })
      const inprog = await store.create({ userId, workspaceId, title: 'Same title', status: 'in_progress' })
      expect(inprog.id).not.toBe(todo.id)
    })

    it('same title under different parents are distinct (parent is part of the key)', async () => {
      const p1 = await store.create({ userId, workspaceId, title: 'Parent 1' })
      const p2 = await store.create({ userId, workspaceId, title: 'Parent 2' })
      const c1 = await store.create({ userId, workspaceId, title: 'Sub', parentId: p1.id })
      const c2 = await store.create({ userId, workspaceId, title: 'Sub', parentId: p2.id })
      expect(c2.id).not.toBe(c1.id)
    })
  })

  describe('RLS isolation', () => {
    // RLS isolation cannot be exercised when the test connects as a Postgres
    // SUPERUSER (the typical local-dev role). Superusers bypass RLS even with
    // FORCE ROW LEVEL SECURITY enabled. Production runs as a non-superuser, so
    // the policy does enforce — verified manually with `SET ROLE` in psql. The
    // crm-store integration suite has the same limitation. To run these tests
    // against a real RLS gate, connect as a role without rolsuper or
    // rolbypassrls.
    it.skip('user A in workspace W1 cannot see tasks in workspace W2 (skipped under superuser)', async () => {
      const client = await pool!.connect()
      let userA: string, userB: string, w1: string, w2: string
      try {
        userA = await makeUser(client)
        userB = await makeUser(client)
        w1 = await makeWorkspace(client, userA)
        w2 = await makeWorkspace(client, userB)
        await addMember(client, w1, userA)
        await addMember(client, w2, userB)
      } finally {
        client.release()
      }

      const tA = await store.create({ userId: userA, workspaceId: w1, title: 'A in W1' })
      const tB = await store.create({ userId: userB, workspaceId: w2, title: 'B in W2' })

      // userA should see W1's task and NOT W2's.
      const aList = await store.list({ workspaceId: w1, userId: userA, assistantId: userA, assistantKind: 'standard' }, {})
      expect(aList.map((r) => r.id)).toContain(tA.id)
      const aListW2 = await store.list({ workspaceId: w2, userId: userA, assistantId: userA, assistantKind: 'standard' }, {})
      expect(aListW2.map((r) => r.id)).not.toContain(tB.id)
      expect(aListW2).toHaveLength(0)

      // RLS hides W2's task from userA's getById too.
      const aGetW2 = await store.getById({ workspaceId: w2, userId: userA, assistantId: userA, assistantKind: 'standard' }, tB.id)
      expect(aGetW2).toBeNull()
    })

    it.skip('user in BOTH workspaces sees tasks from each (skipped under superuser)', async () => {
      const client = await pool!.connect()
      let userBoth: string, w1: string, w2: string
      try {
        userBoth = await makeUser(client)
        w1 = await makeWorkspace(client, userBoth)
        w2 = await makeWorkspace(client, userBoth)
        await addMember(client, w1, userBoth)
        await addMember(client, w2, userBoth)
      } finally {
        client.release()
      }
      await store.create({ userId: userBoth, workspaceId: w1, title: 'in W1' })
      await store.create({ userId: userBoth, workspaceId: w2, title: 'in W2' })
      const w1List = await store.list({ workspaceId: w1, userId: userBoth, assistantId: userBoth, assistantKind: 'standard' }, {})
      const w2List = await store.list({ workspaceId: w2, userId: userBoth, assistantId: userBoth, assistantKind: 'standard' }, {})
      expect(w1List.map((r) => r.title)).toContain('in W1')
      expect(w2List.map((r) => r.title)).toContain('in W2')
    })
  })
})

describeIf('[COMP:tasks/supersession] tasks bi-temporal supersession (integration)', () => {
  let store: typeof import('../tasks-store.js') extends { createDbTaskStore: infer T }
    ? T extends () => infer R ? R : never
    : never
  let history: typeof import('../tasks.js') extends { getTaskHistory: infer T } ? T : never

  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    const storeMod = await import('../tasks-store.js')
    const dbMod = await import('../tasks.js')
    store = storeMod.createDbTaskStore()
    history = dbMod.getTaskHistory
  })

  let userId: string
  let workspaceId: string
  let memberId: string

  beforeEach(async () => {
    const client = await pool!.connect()
    try {
      userId = await makeUser(client)
      workspaceId = await makeWorkspace(client, userId)
      memberId = await addMember(client, workspaceId, userId)
    } finally {
      client.release()
    }
  })

  type RawRow = {
    id: string
    title: string
    status: string
    assignee_id: string | null
    sensitivity: string
    user_id: string | null
    assistant_id: string | null
    source: string
    source_episode_id: string | null
    created_by_user_id: string | null
    valid_from: Date
    valid_to: Date | null
    superseded_by: string | null
  }

  async function rawRow(id: string): Promise<RawRow | null> {
    const c = await pool!.connect()
    try {
      const r = await c.query<RawRow>(
        `SELECT id, title, status, assignee_id, sensitivity, user_id, assistant_id,
                source, source_episode_id, created_by_user_id, valid_from, valid_to, superseded_by
         FROM tasks WHERE id = $1`,
        [id],
      )
      return r.rows[0] ?? null
    } finally {
      c.release()
    }
  }

  it('updateTask closes the old row and inserts a new one with a new id', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'Original' })
    const t2 = await store.update(userId, t1.id, { title: 'Renamed' })
    expect(t2).not.toBeNull()
    expect(t2!.id).not.toBe(t1.id)
    expect(t2!.title).toBe('Renamed')

    const oldRaw = await rawRow(t1.id)
    const newRaw = await rawRow(t2!.id)
    expect(oldRaw).not.toBeNull()
    expect(oldRaw!.valid_to).not.toBeNull()
    expect(oldRaw!.superseded_by).toBe(t2!.id)
    expect(newRaw!.valid_from).toBeInstanceOf(Date)
    expect(newRaw!.valid_to).toBeNull()
    expect(newRaw!.superseded_by).toBeNull()
  })

  it('new row carries forward universal columns; created_by_user_id is the editor', async () => {
    // Seed an editor distinct from the original author.
    const editorClient = await pool!.connect()
    let editorUserId: string
    try {
      editorUserId = await makeUser(editorClient)
      await addMember(editorClient, workspaceId, editorUserId)
      // Stamp universal cols on the original row directly so we can verify
      // they survive the supersession copy-forward.
      const c = editorClient
      await c.query(
        `UPDATE tasks SET sensitivity = 'restricted', source = 'extracted',
                          user_id = NULL, assistant_id = NULL,
                          source_episode_id = $1
         WHERE workspace_id = $2`,
        ['11111111-1111-1111-1111-111111111111', workspaceId],
      )
    } finally {
      editorClient.release()
    }

    const t1 = await store.create({ userId, workspaceId, title: 'Seed' })
    // Re-stamp cols on this just-created row before updating.
    const stamp = await pool!.connect()
    try {
      await stamp.query(
        `UPDATE tasks SET sensitivity = 'restricted', source = 'extracted',
                          source_episode_id = $1
         WHERE id = $2`,
        ['11111111-1111-1111-1111-111111111111', t1.id],
      )
    } finally {
      stamp.release()
    }

    const t2 = await store.update(editorUserId, t1.id, { title: 'Edited' })
    expect(t2).not.toBeNull()
    const newRaw = await rawRow(t2!.id)
    expect(newRaw!.sensitivity).toBe('restricted')
    expect(newRaw!.source).toBe('extracted')
    expect(newRaw!.source_episode_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(newRaw!.created_by_user_id).toBe(editorUserId)
  })

  it('field merge: omitted fields carry forward; provided fields override', async () => {
    const t1 = await store.create({
      userId, workspaceId,
      title: 'Original',
      tags: ['a', 'b'],
      assigneeId: memberId,
      externalRef: { provider: 'linear', id: 'L-1' },
    })
    const t2 = await store.update(userId, t1.id, { title: 'Updated' })
    expect(t2!.title).toBe('Updated')
    expect(t2!.tags).toEqual(['a', 'b'])
    expect(t2!.assigneeId).toBe(memberId)
    expect(t2!.externalRef).toEqual({ provider: 'linear', id: 'L-1' })
  })

  it('field merge: explicit null clears nullable fields', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'With assignee', assigneeId: memberId })
    expect(t1.assigneeId).toBe(memberId)
    const t2 = await store.update(userId, t1.id, { assigneeId: null, due: null })
    expect(t2!.assigneeId).toBeNull()
    expect(t2!.due).toBeNull()
  })

  it('listTasks hides superseded rows; only the active version surfaces', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'v1', tags: ['x'] })
    const t2 = await store.update(userId, t1.id, { title: 'v2' })
    const list = await store.list({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { tag: 'x' })
    expect(list.map((r) => r.id)).toEqual([t2!.id])
    expect(list.map((r) => r.title)).toEqual(['v2'])
  })

  it('getById on a superseded id returns null; the new id resolves', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'v1' })
    const t2 = await store.update(userId, t1.id, { title: 'v2' })
    expect(await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, t1.id)).toBeNull()
    const fetched = await store.getById({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, t2!.id)
    expect(fetched).not.toBeNull()
    expect(fetched!.title).toBe('v2')
  })

  it('updating status (e.g. closeTask path) supersedes too', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'work item' })
    const t2 = await store.update(userId, t1.id, { status: 'done' })
    expect(t2!.id).not.toBe(t1.id)
    expect(t2!.status).toBe('done')
    const oldRaw = await rawRow(t1.id)
    expect(oldRaw!.valid_to).not.toBeNull()
    expect(oldRaw!.superseded_by).toBe(t2!.id)
  })

  it('empty fields = no-op: returns the current row without superseding', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'same' })
    const result = await store.update(userId, t1.id, {})
    expect(result).not.toBeNull()
    expect(result!.id).toBe(t1.id)
    const oldRaw = await rawRow(t1.id)
    expect(oldRaw!.valid_to).toBeNull()
    expect(oldRaw!.superseded_by).toBeNull()
  })

  it('update forward-resolves an already-superseded id to its live head', async () => {
    // Regression: an LLM working from a stale `listTasks` snapshot re-uses the
    // pre-supersession id on its next edit. That id must resolve forward to the
    // current row rather than 404 (which previously tripped the retry breaker
    // after the model assigned a task and then touched the same id again).
    const t1 = await store.create({ userId, workspaceId, title: 'v1' })
    const t2 = await store.update(userId, t1.id, { title: 'v2' })
    // Update t1 AGAIN (the stale id) — resolves forward to v2's live row.
    const t3 = await store.update(userId, t1.id, { title: 'v3' })
    expect(t3).not.toBeNull()
    expect(t3!.title).toBe('v3')
    expect(t3!.id).not.toBe(t2!.id)
    // The chain is coherent: v2 is now superseded by v3, and only v3 is live.
    const v2Raw = await rawRow(t2!.id)
    expect(v2Raw!.valid_to).not.toBeNull()
    expect(v2Raw!.superseded_by).toBe(t3!.id)
    const list = await store.list({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, {})
    expect(list.map((r) => r.id)).toEqual([t3!.id])
  })

  it('update returns null for a genuinely non-existent id', async () => {
    const ghost = await store.update(userId, '00000000-0000-0000-0000-0000000000ff', { title: 'nope' })
    expect(ghost).toBeNull()
  })

  it('active children are repointed to the new parent atomically', async () => {
    const p1 = await store.create({ userId, workspaceId, title: 'parent v1' })
    const c1 = await store.create({ userId, workspaceId, title: 'child', parentId: p1.id })
    const p2 = await store.update(userId, p1.id, { title: 'parent v2' })
    expect(p2!.id).not.toBe(p1.id)

    const childRaw = await pool!.connect().then(async (c) => {
      try {
        const r = await c.query<{ parent_id: string | null }>(
          `SELECT parent_id FROM tasks WHERE id = $1`, [c1.id],
        )
        return r.rows[0]
      } finally { c.release() }
    })
    expect(childRaw.parent_id).toBe(p2!.id)

    const subTasks = await store.list({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { parentId: p2!.id })
    expect(subTasks.map((r) => r.id)).toEqual([c1.id])

    const orphanLookup = await store.list({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, { parentId: p1.id })
    expect(orphanLookup).toHaveLength(0)
  })

  it('getTaskHistory returns the chain ordered by valid_from from any id', async () => {
    const t1 = await store.create({ userId, workspaceId, title: 'v1' })
    // Stagger inserts to keep valid_from ordering deterministic on fast hosts.
    await new Promise((r) => setTimeout(r, 5))
    const t2 = await store.update(userId, t1.id, { title: 'v2' })
    await new Promise((r) => setTimeout(r, 5))
    const t3 = await store.update(userId, t2!.id, { title: 'v3' })

    const fromMiddle = await history({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, t2!.id)
    expect(fromMiddle.map((r) => r.id)).toEqual([t1.id, t2!.id, t3!.id])
    expect(fromMiddle.map((r) => r.title)).toEqual(['v1', 'v2', 'v3'])

    // Same chain regardless of which id you start from.
    expect((await history({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, t1.id)).map((r) => r.id)).toEqual([t1.id, t2!.id, t3!.id])
    expect((await history({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, t3!.id)).map((r) => r.id)).toEqual([t1.id, t2!.id, t3!.id])
  })

  it('getTaskHistory returns [] for an unknown id', async () => {
    const chain = await history({ workspaceId, userId, assistantId: userId, assistantKind: 'standard' }, '00000000-0000-0000-0000-000000000000')
    expect(chain).toEqual([])
  })
})
