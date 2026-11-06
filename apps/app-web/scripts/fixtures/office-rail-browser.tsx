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
createRoot(document.getElementById('root')!).render(<I18nProvider locale="en" dict={en}><div className="flex h-dvh min-h-0 flex-col"><div className="h-12 shrink-0 border-b">Office rail fixture</div><main className="flex min-h-0 flex-1 overflow-hidden"><PresentationEditor snapshot={snapshot} baseVersion={1} role="edit" suggestMode={false} onCommand={() => {}} /></main></div></I18nProvider>);
