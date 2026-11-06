import { createRoot } from 'react-dom/client';
import WorkflowDetailPage from '@/app/w/[workspaceId]/workflow/[id]/page';
import { I18nProvider } from '@/lib/i18n/client';
import { WorkspaceContextProvider } from '@/lib/workspace-context';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { en } from '@/lib/i18n/dictionaries/en';
import { requestWorkflowRefresh } from '@/lib/workflow-events';
import { fixture, requests } from './workflow-page-browser-transport';
import './feed-composer-browser.css';

const value = { workspaceId: 'fictional-workspace', id: 'fictional-workflow' };
const params = Object.assign(Promise.resolve(value), { status: 'fulfilled', value });
Object.assign(window, { workflowFixture: { fixture, requests, refresh: () => requestWorkflowRefresh(value.workspaceId) } });
createRoot(document.getElementById('root')!).render(
  <I18nProvider locale="en" dict={en}>
    <WorkspaceContextProvider value={{ workspaceId: value.workspaceId, name: 'Fixture workspace', role: 'owner', clearance: 'internal', me: { id: 'fictional-user' } }}>
      <ConfirmDialogProvider />
      <main className="h-dvh bg-background text-foreground"><WorkflowDetailPage params={params} /></main>
    </WorkspaceContextProvider>
  </I18nProvider>,
);
