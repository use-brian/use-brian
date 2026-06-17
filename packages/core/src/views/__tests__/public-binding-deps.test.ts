/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import {
  bindingCtx,
  buildPublicAccessContext,
  PUBLIC_SHARE_PRINCIPAL,
  type BindingDeps,
} from '../bindings.js'
import { neutralizeBlocksForPublic, neutralizePublicPayload } from '../public-sanitize.js'
import type { Block } from '../blocks.js'
import type { ViewPayload } from '../a2ui.js'

describe('[COMP:doc/public-binding-deps] Public share render gating', () => {
  // ── Invariant 1: the public render path MUST run at clearance:'public' ──
  describe('buildPublicAccessContext', () => {
    it('pins clearance to public — the data containment (invariant 1)', () => {
      const ctx = buildPublicAccessContext('ws-1')
      expect(ctx.clearance).toBe('public')
      expect(ctx.systemRead).toBe(true)
      expect(ctx.workspaceId).toBe('ws-1')
      expect(ctx.userId).toBe(PUBLIC_SHARE_PRINCIPAL)
      expect(ctx.compartments).toEqual([])
    })

    it('never leaves clearance undefined (that would expose every tier)', () => {
      expect(buildPublicAccessContext('ws-1').clearance).not.toBeUndefined()
    })
  })

  describe('bindingCtx', () => {
    const baseDeps = (over: Partial<BindingDeps> = {}): BindingDeps => ({
      taskStore: {} as any,
      crmStore: {} as any,
      workflowRunStore: {} as any,
      workspaceDirectory: {} as any,
      userId: 'member-1',
      workspaceId: 'ws-1',
      ...over,
    })

    it('uses the member-derived context (clearance undefined) by default', () => {
      const ctx = bindingCtx(baseDeps())
      expect(ctx.clearance).toBeUndefined()
      expect(ctx.userId).toBe('member-1')
      expect(ctx.assistantKind).toBe('primary')
    })

    it('prefers an explicit accessContext — how the public path pins public', () => {
      const pub = buildPublicAccessContext('ws-1')
      const ctx = bindingCtx(baseDeps({ accessContext: pub }))
      expect(ctx).toBe(pub)
      expect(ctx.clearance).toBe('public')
    })
  })

  // ── Identity / storage-path neutralization ──────────────────────────
  describe('neutralizeBlocksForPublic', () => {
    it('replaces person/page mentions with plaintext (no UUIDs, no avatar)', () => {
      const blocks: Block[] = [
        {
          kind: 'callout',
          id: 'c1',
          icon: '💡',
          richText: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'personMention', attrs: { id: 'user-uuid', name: 'Alice', avatarUrl: 'http://x/a.png' } },
                  { type: 'pageMention', attrs: { id: 'page-uuid', title: 'Secret Plan' } },
                ],
              },
            ],
          },
        } as Block,
      ]
      const json = JSON.stringify(neutralizeBlocksForPublic(blocks))
      expect(json).not.toContain('user-uuid')
      expect(json).not.toContain('page-uuid')
      expect(json).not.toContain('avatarUrl')
      expect(json).not.toContain('a.png')
      expect(json).toContain('@Alice')
      expect(json).toContain('Secret Plan')
    })

    it('blanks media bucket/path, keeps child_page link, drops video URL, preserves order', () => {
      const blocks: Block[] = [
        {
          kind: 'image',
          id: 'i1',
          ref: { bucket: 'workspace_files', path: 'file-uuid', mimeType: 'image/png', sizeBytes: 1, name: 'x.png' },
        },
        { kind: 'child_page', id: 'cp1', childPageId: 'child-uuid' },
        { kind: 'video', id: 'v1', url: 'https://signed-storage-url' },
      ]
      const out = neutralizeBlocksForPublic(blocks)
      const img = out.find((b) => b.id === 'i1') as Extract<Block, { kind: 'image' }>
      expect(img.ref?.bucket).toBe('')
      expect(img.ref?.path).toBe('')
      expect(img.ref?.name).toBe('x.png') // display fields kept
      // child_page is KEPT — its childPageId is the child's universal share URL
      // (`/share/p/<id>`); access is still gated (child public + ancestor published).
      const cp = out.find((b) => b.id === 'cp1') as Extract<Block, { kind: 'child_page' }>
      expect(cp.kind).toBe('child_page')
      expect(cp.childPageId).toBe('child-uuid')
      const json = JSON.stringify(out)
      expect(json).not.toContain('file-uuid')
      expect(json).not.toContain('signed-storage-url')
      // index alignment with the A2UI payload is preserved
      expect(out).toHaveLength(3)
    })

    it('scrubs @mentions inside every table cell', () => {
      const blocks: Block[] = [
        {
          kind: 'table',
          id: 'tb',
          hasHeaderRow: true,
          rows: [
            [
              { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Owner' }] }] },
              { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }] },
            ],
            [
              {
                type: 'doc',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'personMention', attrs: { id: 'user-uuid', name: 'Alice', avatarUrl: 'http://x/a.png' } },
                    ],
                  },
                ],
              },
              { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }] },
            ],
          ],
        } as Block,
      ]
      const json = JSON.stringify(neutralizeBlocksForPublic(blocks))
      expect(json).not.toContain('user-uuid')
      expect(json).not.toContain('a.png')
      expect(json).toContain('@Alice')
      expect(json).toContain('Status')
    })

    it('drops data/chart bindings so filter entity UUIDs never ride along', () => {
      const blocks: Block[] = [
        { kind: 'data', id: 'd1', binding: { entity: 'deals', viewType: 'table', filters: { companyId: 'company-uuid' } } as any },
        { kind: 'chart', id: 'ch1', chartType: 'bar', binding: { entity: 'tasks', op: 'count_by', groupBy: 'status', filters: { assigneeId: 'member-uuid' } } as any },
      ]
      const out = neutralizeBlocksForPublic(blocks)
      const json = JSON.stringify(out)
      expect(json).not.toContain('company-uuid')
      expect(json).not.toContain('member-uuid')
      expect(json).not.toContain('binding')
      expect(out).toHaveLength(2) // slots preserved for payload index-alignment
    })
  })

  describe('neutralizePublicPayload', () => {
    it('anonymizes person + drops relation ids, even nested in table rows', () => {
      const payload: ViewPayload = {
        a2ui: '0.8',
        root: {
          type: 'container',
          direction: 'column',
          children: [
            {
              type: 'table',
              columns: [{ field: 'a', header: 'A' }],
              rows: [
                { id: 'r1', a: { type: 'person', id: 'member-uuid', name: 'Bob', avatarUrl: 'http://a', initials: 'B' } },
                { id: 'r2', a: { type: 'relation', entityType: 'company', id: 'company-uuid', label: 'Acme' } },
              ],
            } as any,
          ],
        },
      }
      const json = JSON.stringify(neutralizePublicPayload(payload))
      expect(json).not.toContain('member-uuid')
      expect(json).not.toContain('company-uuid')
      expect(json).not.toContain('http://a')
      expect(json).not.toContain('Bob') // member name dropped too
      expect(json).toContain('Acme') // public-tier relation label kept
    })

    it('drops files-widget storage refs and blanks image-widget src', () => {
      const payload: ViewPayload = {
        a2ui: '0.8',
        root: {
          type: 'container',
          direction: 'column',
          children: [
            { type: 'files', files: [{ bucket: 'workspace_files', path: 'file-uuid', mimeType: 'application/pdf' }] } as any,
            { type: 'image', src: 'https://signed-gcs/secret-object' } as any,
          ],
        },
      }
      const json = JSON.stringify(neutralizePublicPayload(payload))
      expect(json).not.toContain('workspace_files')
      expect(json).not.toContain('file-uuid')
      expect(json).not.toContain('signed-gcs')
    })
  })
})
