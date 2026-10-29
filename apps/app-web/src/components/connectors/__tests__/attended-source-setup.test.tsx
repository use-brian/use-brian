// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendedSourceSetup } from '../attended-source-setup';
import { I18nProvider } from '@/lib/i18n/client';
import { type Dictionary, en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';
import { invalidateSurfaceCache } from '@/lib/surface-cache';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), confirm: vi.fn(), saved: vi.fn(), viewer: { workspaceId: 'workspace-fixture', me: { id: 'viewer-fixture' }, role: 'owner' }, source: null as null | { id:string; connectorInstanceId:string; status:string; attendedProfile:string } }));
vi.mock('@/lib/auth-fetch', () => ({ authFetch: mocks.fetch }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspaceContext: () => mocks.viewer }));
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: mocks.confirm }));
const t = en.attendedSourceSetup;
let host: HTMLDivElement, root: Root;
const overview = () => ({ workspaceId: mocks.viewer.workspaceId, actor: { userId: mocks.viewer.me.id, assistantId: 'assistant-fixture' }, validForMs: 30_000, sources: { state: 'unavailable', items: mocks.source ? [mocks.source] : [] } });
const response = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
const commands = () => mocks.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init.body));
async function render(dict: Dictionary = en, locale: 'en'|'ja'|'zh'|'zh-CN' = 'en', instanceId = 'instance-fixture') { await act(async () => { root.render(<I18nProvider locale={locale} dict={dict}><AttendedSourceSetup instanceId={instanceId} onCredentialsSaved={mocks.saved}/></I18nProvider>); }); }
async function click(label: string) { const button = [...host.querySelectorAll('button')].find(item => item.textContent === label); expect(button).toBeDefined(); await act(async () => button!.click()); }
async function input(label: string, value: string) { const wrapper = [...host.querySelectorAll('label')].find(item => item.firstChild?.textContent === label)!; const field = wrapper.querySelector('input,textarea')!; await act(async () => { Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field,value); field.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function reviewed() {
 await click(t.prepare);
 for (const [label,value] of [[t.tenant,'fictional-tenant'],[t.audience,'https://source.example'],[t.sourceBaseUrl,'https://source.example/authorization'],[t.probeTool,'readRecord'],[t.probeInput,'{"id":"record-1"}']]) await input(label,value);
 await click(t.review);
}
beforeEach(() => {
 mocks.viewer = { workspaceId: 'workspace-fixture', me: { id: 'viewer-fixture' }, role: 'owner' };
 mocks.source = null;
 mocks.confirm.mockReset().mockResolvedValue(true); mocks.saved.mockReset();
 mocks.fetch.mockReset().mockImplementation(async (_url,init) => {
  if (init?.method !== 'POST') return response(overview());
  const body = JSON.parse(init.body);
  if (body.kind === 'connector.identity.prepare') return response({ issuer:'https://brain.example', publicJwks:{keys:[]} });
  if (body.kind === 'connector.source.review') { mocks.source={id:'profile-fixture',connectorInstanceId:'instance-fixture',status:'pending',attendedProfile:'attended_governed_read_v1'}; return response({ profileId:'profile-fixture', reviewId:'review-fixture', expiresAt:new Date(Date.now()+60_000).toISOString(), connectorInstanceId:'instance-fixture', workspaceId:'workspace-fixture', userId:'viewer-fixture', assistantId:'assistant-fixture', state:'pending' }); }
  if(body.kind === 'connector.source.revoke') { if(mocks.source)mocks.source.status='revoked'; return response({revoked:true}); }
  return response({state:'qualified'});
 });
 invalidateSurfaceCache('application-management:'); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); invalidateSurfaceCache('application-management:'); });
describe('[COMP:app-web/attended-source-setup] canonical owner setup', () => {
 for (const [locale,dict] of [['en',en],['ja',ja],['zh',zh],['zh-CN',zhCN]] as const) it(`localizes setup and owner-only status in ${locale}`, async () => {
  await render(dict,locale); expect(host.textContent).toContain(dict.attendedSourceSetup.notConfigured); expect(host.querySelector('select')).toBeNull();
  mocks.viewer.role='admin'; await render(dict,locale); expect(host.textContent).toBe(dict.attendedSourceSetup.ownerOnly); expect(host.querySelector('input')).toBeNull();
 });
 it('writes bearer credentials to the exact workspace instance and clears the secret', async () => {
  await render(); await input(t.bearer,'fictional-secret'); await click(t.saveCredentials);
  expect(commands()).toEqual([{authType:'bearer',bearerToken:'fictional-secret'}]);
  expect(mocks.fetch.mock.calls.some(([url]) => url.endsWith('/workspaces/workspace-fixture/connectors/instance-fixture/credentials'))).toBe(true);
  expect((host.querySelector('input[type=password]') as HTMLInputElement).value).toBe(''); expect(mocks.saved).toHaveBeenCalledOnce(); expect(host.textContent).toContain(t.credentialsSaved);
 });
 it('requires exact human confirmation and applies only the saved review with its assistant', async () => {
  await render(); await reviewed(); expect(commands().map(item=>item.kind)).toEqual(['connector.identity.prepare','connector.source.review']);
  await click(t.apply); const confirmation=renderToStaticMarkup(mocks.confirm.mock.calls[0][0].content);
  expect(confirmation).toContain('fictional-tenant'); expect(confirmation).toContain('record-1'); expect(confirmation).toContain('review-fixture');
  expect(commands().at(-1)).toEqual({kind:'connector.source.apply',assistantId:'assistant-fixture',reviewId:'review-fixture'});
 });
 it('does not apply a declined review', async () => { mocks.confirm.mockResolvedValue(false); await render(); await reviewed(); await click(t.apply); expect(commands()).toHaveLength(2); });
 it('clears secrets and reviews on authority changes and ignores late preparation', async () => {
  await render(); await input(t.bearer,'fictional-secret'); let resolve!:(value:unknown)=>void;
  mocks.fetch.mockImplementation((_url,init)=>init?.method==='POST'?new Promise(done=>{resolve=done;}):Promise.resolve(response(overview())));
  await click(t.prepare); await act(async()=>window.dispatchEvent(new CustomEvent(WORKSPACE_IDENTITY_REFRESH_EVENT,{detail:{workspaceId:'workspace-fixture'}})));
  await act(async()=>resolve(response({issuer:'https://stale.example',publicJwks:{keys:[]}})));
  expect(host.textContent).not.toContain('stale.example'); expect((host.querySelector('input[type=password]') as HTMLInputElement|null)?.value ?? '').toBe('');
 });
 it('blocks further writes after an uncertain apply until status reconciliation', async () => {
  await render(); await reviewed(); mocks.fetch.mockImplementation(async(_url,init)=> { if(init?.method==='POST') throw new Error('network'); return response(overview()); });
  await click(t.apply); expect(host.textContent).toContain(t.uncertain); const count=commands().length; await click(t.prepare); expect(commands()).toHaveLength(count);
  await click(t.refresh); expect(host.textContent).not.toContain(t.uncertain);
 });
 it('revokes an abandoned pending setup before allowing a new review',async()=>{await render();await reviewed();await click(t.revoke);expect(commands().at(-1)).toEqual({kind:'connector.source.revoke',profileId:'profile-fixture'});expect(host.textContent).toContain(t.revoked);});
 it('drops reviews when switching instances',async()=>{await render();await reviewed();await render(en,'en','other-instance');expect(host.textContent).not.toContain('review-fixture');expect([...host.querySelectorAll('button')].some(button=>button.textContent===t.apply)).toBe(false);});
});
