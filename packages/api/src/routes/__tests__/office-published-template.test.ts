import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { officeTemplateRoutes, type OfficeTemplatesRouteDeps } from '../office-templates.js';
import { documentFixture } from '../../../../office-model/src/__tests__/fixtures.js';
import { createPublishedOfficeTemplateReader } from '../../office/published-template.js';
import type { OfficeOutputScope } from '../../office/file-binding.js';
import type { OfficeTemplateBundle } from '@use-brian/office-model';
import { inferOfficeTemplateRouting } from '@use-brian/core';
vi.mock('../../db/office-read-projection.js', async original => ({ ...await original<typeof import('../../db/office-read-projection.js')>(), readOfficeProjection: async (_user: string, read: () => Promise<unknown>) => ({ ...await read() as object, validForMs: 30_000 }) }));

function setup() {
  const snapshot = documentFixture();
  const routing = inferOfficeTemplateRouting(snapshot, 'upload');
  const source = { revision: 'revision-a', scope: { sensitivity: 'confidential' as const, compartments: ['team:fictional'], projectIds: [] }, bundle: { workspaceId: snapshot.workspaceId, family: 'document', capabilityVersion: 1, snapshot, description: 'Published instructions', fields: routing.fields, slideRecipes: [] } };
  const deps = { readPublished: vi.fn(async () => source), createTemplateShell: vi.fn(async () => ({ id: 'new-artifact' })), createDraft: vi.fn(async () => ({ id: 'new-template' })), initializeDraft: vi.fn(async () => true), saveDraftRouting: vi.fn(async () => true), deleteEmptyDraft: vi.fn(async () => true), deleteEmptyShell: vi.fn(async () => true) };
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as { userId: string }).userId = 'viewer'; next(); });
  app.use('/office', officeTemplateRoutes(deps as unknown as OfficeTemplatesRouteDeps));
  return { app, deps, source };
}
describe('[COMP:app-web/office-published-template] Immutable template routes', () => {
  const path = '/office/templates/registry/versions/published-version';
  it('returns the published snapshot through bounded no-store transport', async () => {
    const { app, deps, source } = setup(); const reply = await request(app).get(path).expect(200);
    expect(reply.body.snapshot).toEqual(source.bundle.snapshot); expect(reply.headers['cache-control']).toBe('private, no-store');
    expect(deps.readPublished).toHaveBeenCalledWith('viewer', 'registry', 'published-version');
  });
  it('creates an independent draft with published fields and inherited classification', async () => {
    const { app, deps, source } = setup(); const original = structuredClone(source);
    await request(app).post(`${path}/copy`).send({ name: 'New template' }).expect(201);
    expect(deps.createTemplateShell).toHaveBeenCalledWith(expect.objectContaining({ templateVersionId: 'published-version', mode: 'template', sensitivity: 'confidential', requiredCompartments: ['team:fictional'] }));
    expect(deps.initializeDraft).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'new-artifact', snapshot: { ...source.bundle.snapshot, artifactId: 'new-artifact', templateVersionId: 'published-version', title: 'New template', accessibility: { ...source.bundle.snapshot.accessibility, title: 'New template' } } }));
    expect(deps.saveDraftRouting).toHaveBeenCalledWith(expect.objectContaining({ templateId: 'new-template', routing: { source: 'promote', fields: source.bundle.fields, slideRecipes: [] } }));
    expect(source).toEqual(original); expect(deps.readPublished).toHaveBeenCalledTimes(3);
  });
  it('withholds unavailable versions and refuses invalid copy names before creating anything', async () => {
    const { app, deps } = setup(); deps.readPublished.mockResolvedValue(null as never);
    await request(app).get(path).expect(404); await request(app).post(`${path}/copy`).send({ name: 'Copy' }).expect(404);
    await request(app).post(`${path}/copy`).send({ name: ' ' }).expect(400);
    expect(deps.createTemplateShell).not.toHaveBeenCalled();
  });
  it('cleans up a copy if the source is revoked during creation', async () => {
    const { app, deps, source } = setup(); deps.readPublished.mockResolvedValueOnce(source).mockResolvedValueOnce(null as never);
    await request(app).post(`${path}/copy`).send({ name: 'Copy' }).expect(409);
    expect(deps.initializeDraft).not.toHaveBeenCalled(); expect(deps.deleteEmptyDraft).toHaveBeenCalledWith('viewer', 'new-template'); expect(deps.deleteEmptyShell).toHaveBeenCalledWith('viewer', 'new-artifact');
  });
});

describe('[COMP:app-web/office-published-template] Published source binding', () => {
  it.each(['missing-template', 'deprecated', 'missing-version', 'wrong-template', 'wrong-workspace', 'draft-version'])('withholds %s without reading bundle bytes', async state => {
    const readBundle = vi.fn();
    const read = createPublishedOfficeTemplateReader({
      getTemplate: async () => state === 'missing-template' ? null : { workspaceId: 'workspace', lifecycleState: state === 'deprecated' ? 'deprecated' : 'admitted' },
      getVersion: async () => state === 'missing-version' ? null : { workspaceId: state === 'wrong-workspace' ? 'other' : 'workspace', templateId: state === 'wrong-template' ? 'other' : 'template', status: state === 'draft-version' ? 'draft' : 'admitted' }, readBundle,
    });
    expect(await read('viewer', 'template', 'version')).toBeNull(); expect(readBundle).not.toHaveBeenCalled();
  });
  it('requires a source classification receipt and preserves its scope', async () => {
    const { source } = setup();
    const readBundle = vi.fn(async (_user: string, _workspace: string, _version: string, receipt: (scope: OfficeOutputScope, revision: string) => void) => { receipt(source.scope, source.revision); return source.bundle as unknown as OfficeTemplateBundle; });
    const read = createPublishedOfficeTemplateReader({ getTemplate: async () => ({ workspaceId: 'workspace', lifecycleState: 'admitted' }), getVersion: async () => ({ workspaceId: 'workspace', templateId: 'template', status: 'admitted' }), readBundle });
    expect(await read('viewer', 'template', 'version')).toEqual(source);
    readBundle.mockImplementation(async () => source.bundle as unknown as OfficeTemplateBundle);
    expect(await read('viewer', 'template', 'version')).toBeNull();
  });
});
