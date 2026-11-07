// Local rendering fixture. No API, account or model access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/lib/i18n/client';
import { en } from '../../src/lib/i18n/dictionaries/en';
import { PresentationEditor } from '../../src/components/office/presentation-editor';
import { presentationFixture, uid } from '../../src/components/office/__tests__/editor-fixtures';
import '../../src/app/globals.css';
const snapshot = presentationFixture();
snapshot.resources = [];
const source = snapshot.slides[0];
snapshot.slides = Array.from({ length: 30 }, (_, index) => ({ ...structuredClone(source), id: uid(1000 + index), title: `Slide ${index + 1}`, objects: source.objects.slice(0, 3) }));
const officeRailRoot = createRoot(document.getElementById('root')!);
officeRailRoot.render(<I18nProvider locale="en" dict={en}><div className="flex h-dvh min-h-0 flex-col"><div className="h-12 shrink-0 border-b">Office rail fixture</div><main className="flex min-h-0 flex-1 overflow-hidden"><PresentationEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={() => {}} /></main></div></I18nProvider>);

// The owned browser fixture also checks the real publication/selection controls.
import { useState } from 'react';
import { OfficeLibrarySelectionBar, useOfficeLibrarySelection } from '../../src/components/office/office-library-selection';
import { PublishedTemplateViewer } from '../../src/components/office/published-template-viewer';
import { CommentAssistantPicker } from '../../src/components/doc/comment-assistant-picker';
import { documentFixture } from '../../src/components/office/__tests__/editor-fixtures';
import { seedSurfaceCache } from '../../src/lib/surface-cache';
import { officePublishedTemplateCacheKey } from '../../src/lib/surface-prefetch';
import { attachOfficeMetadata, officeMetadataRemaining } from '../../src/lib/office/metadata';
function Controls() {
  const [voice, setVoice] = useState('first');
  const selection = useOfficeLibrarySelection('fixture', ['first', 'second'], true, async () => {}, () => {});
  return <div className="space-y-4 p-3" data-preflight-controls="true">
    <OfficeLibrarySelectionBar selection={selection} total={2} />
    <CommentAssistantPicker roster={['first', 'second'].map(id => ({ id, name: id, iconSeed: 1, kind: 'standard', appType: null }))} selectedId={voice} onSelect={setVoice} />
    <PublishedTemplateViewer workspaceId="workspace" viewerId="viewer" templateId="template" versionId="version" />
  </div>;
}
if (new URLSearchParams(location.search).has('controls')) {
  const published = documentFixture(); published.resources = [];
  published.sections.push({ ...structuredClone(published.sections[0]), id: uid(888) });
  const admitted = attachOfficeMetadata(published, 30_000, performance.now(), 'viewer');
  seedSurfaceCache(officePublishedTemplateCacheKey('workspace', 'viewer', 'template', 'version'), admitted, { expiresInMs: value => officeMetadataRemaining(value, 'viewer') });
  officeRailRoot.render(<I18nProvider locale="en" dict={en}><Controls /></I18nProvider>);
}
