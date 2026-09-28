import { describe, expect, it, vi } from 'vitest'
import { createMeetingTagsService } from '../meeting-tags-service.js'
import { emptyTagState, type TagState } from '../meeting-tags.js'
import { meetingTagRoutes } from '../../routes/meeting-tags.js'
import express from 'express'
import request from 'supertest'

function harness() {
  const folder = { id: 'folder', workspaceId: 'ws', anchorKey: 'meeting-notes-folder', name: 'Meetings', clearance: 'internal' }
  const note = { id: 'note', workspaceId: 'ws', nestParentId: 'folder', name: 'Roadmap budget', clearance: 'internal' }
  const rows: Record<string, TagState> = { folder: emptyTagState(), note: emptyTagState() }
  const views = { getById: vi.fn(async (_user: string, id: string) => id === 'folder' ? folder : id === 'note' ? note : null), getPage: vi.fn(async () => ({ blocks: [] })) }
  const store = { read: vi.fn(async (_user: string, id: string) => rows[id] ?? emptyTagState()), change: vi.fn(async (_user: string, id: string, fn: (state: TagState) => TagState) => rows[id] = fn(rows[id] ?? emptyTagState())), examples: vi.fn(async () => []) }
  const service = createMeetingTagsService(views as never, store)
  return { service, store, rows, views, folder }
}
describe('[COMP:recordings/meeting-tags] shared service and routes', () => {
  it('does no write with no opted-in rules; explicit rules tag future updates', async () => {
    const h = harness()
    await h.service.apply('user', 'ws', 'note')
    expect(h.store.change).not.toHaveBeenCalled()
    await h.service.command('user', 'ws', 'folder', { kind: 'create-rule', tag: 'Plans', phrases: ['roadmap'] })
    expect(h.rows.note.tags).toEqual([])
    await h.service.apply('user', 'ws', 'note')
    expect(h.rows.note.tags).toEqual([{ name: 'Plans', source: 'rule' }])
    await h.service.command('user', 'ws', 'note', { kind: 'set-tags', tags: [] })
    await h.service.apply('user', 'ws', 'note')
    expect(h.rows.note.tags).toEqual([])
  })
  it('rejects inaccessible and cross-workspace parents without reading tags or examples', async () => {
    const h = harness()
    await expect(h.service.read('user', 'other', 'note')).rejects.toThrow('not found')
    h.folder.workspaceId = 'other'
    expect(await h.service.read('user', 'ws', 'note')).toBeNull()
    expect(h.store.read).not.toHaveBeenCalled()
    expect(h.store.examples).not.toHaveBeenCalled()
  })
  it('does not reveal or apply folder rules across different page clearance', async () => {
    const h = harness()
    h.folder.clearance = 'confidential'
    expect(await h.service.read('user', 'ws', 'note')).toBeNull()
    await h.service.apply('user', 'ws', 'note', 'roadmap')
    expect(h.store.read).not.toHaveBeenCalled()
    expect(h.store.change).not.toHaveBeenCalled()
  })

  it('validates commands before changing state and cannot accept stale suggestions', async () => {
    const h = harness()
    await expect(h.service.command('user', 'ws', 'note', { kind: 'create-rule', tag: '', phrases: [] })).rejects.toThrow()
    expect(h.store.change).not.toHaveBeenCalled()
    await expect(h.service.command('user', 'ws', 'note', { kind: 'accept-rule', id: 'stale' })).rejects.toThrow('no longer supported')
    expect(h.rows.folder.rules).toEqual([])
  })
  it('gates HTTP reads and writes by authenticated workspace membership', async () => {
    const h = harness()
    const role = vi.fn().mockResolvedValue(null)
    const app = express().use(express.json()).use((req, _res, next) => { Object.assign(req, { userId: 'user' }); next() })
      .use(meetingTagRoutes(h.service, role))
    expect((await request(app).get('/meeting-tags/note?workspaceId=ws')).status).toBe(403)
    expect(h.views.getById).not.toHaveBeenCalled()
    role.mockResolvedValue('member')
    expect((await request(app).post('/meeting-tags/note').send({ workspaceId: 'ws', command: { kind: 'set-tags', tags: ['Custom'] } })).status).toBe(200)
    expect(h.rows.note.tags).toEqual([{ name: 'Custom', source: 'manual' }])
  })
})
