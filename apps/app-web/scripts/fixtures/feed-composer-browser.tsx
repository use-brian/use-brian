import { createRoot } from 'react-dom/client';
import { FeedImageFixture } from './feed-image-browser';
import { FeedCommentFixture } from './feed-comment-browser';
import { FeedWorkflowFixture } from './feed-workflow-browser';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { TuningChatPanel } from '@/components/feed/tuning-chat-panel';
import type { DockRecorderApi } from '@/lib/recorder/use-dock-recorder';
import { requests } from './feed-composer-network';
import './feed-composer-browser.css';

const params = new URLSearchParams(location.search);
const locale = (params.get('locale') ?? 'en') as 'en' | 'ja' | 'zh' | 'zh-cn';
const dict = structuredClone({ en, ja, zh, 'zh-cn': zhCN }[locale]);
if (params.has('long')) {
  dict.feedPage.tuningChat.research = 'Extended localized research label';
  dict.feedPage.tuningChat.modelStandard = 'Extended localized standard model label';
}
const noop = () => {};
const recorder: DockRecorderApi = {
  workspaceId: 'fictional-workspace',
  phase: { kind: 'idle' }, active: false, savingCount: 0, elapsedMs: () => 0,
  saveProgress: null,
  notice: null, clearNotices: noop, onPressStart: noop, onPressEnd: noop,
  stop: noop, discard: noop, pause: noop, resume: noop, level: () => 0,
  computerAudioAvailable: false, includeComputerAudio: false, setIncludeComputerAudio: noop,
  interactionAvailable: false, interactionEnabled: false, interactionStatus: "idle", setInteractionEnabled: () => {},
  livePageEnabled: false, setLivePageEnabled: noop, includesSystemAudio: () => false,
  screenCaptureAvailable: false, capturePickerAvailable: false, captureSource: 'mic',
  setCaptureSource: noop, capturesScreen: () => false, recovery: [], saveRecovery: async () => {}, discardRecovery: async () => {},
};
Object.assign(window, { feedComposerFixture: { dict, requests } });
createRoot(document.getElementById('root')!).render(
  <I18nProvider locale={locale === 'zh-cn' ? 'zh-CN' : locale} dict={dict}>
    {params.has('image') ? <FeedImageFixture /> : params.has('workflow') ? <FeedWorkflowFixture /> : params.has('comment') ? <FeedCommentFixture /> : <main data-fixture-rail style={{ width: Number(params.get('width') ?? 320), height: 700, maxWidth: '100vw' }}>
      <TuningChatPanel docked ready sessionId="fictional-draft" workspaceId="fictional-workspace" assistantId="fictional-writer" assistantName="Draft writer" dockRecorder={recorder} />
    </main>}
  </I18nProvider>,
);
