import { createRoot } from 'react-dom/client';
import { ChannelRecordingsPanel } from '@/components/channels/channel-recordings';
import { I18nProvider } from '@/lib/i18n/client';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog';
import { en } from '@/lib/i18n/dictionaries/en';
import { fixture, requests } from './channel-recovery-browser-transport';
import './feed-composer-browser.css';
Object.assign(window, { recoveryFixture: { fixture, requests } });
createRoot(document.getElementById('root')!).render(<I18nProvider locale="en" dict={en}>
  <ConfirmDialogProvider />
  <main className="min-h-dvh bg-background p-4 text-foreground"><div className="mx-auto max-w-2xl"><h1 className="mb-4 text-lg font-semibold">Channel settings</h1><ChannelRecordingsPanel workspaceId="fictional-workspace" channelId="fictional-channel" /></div></main>
</I18nProvider>);
