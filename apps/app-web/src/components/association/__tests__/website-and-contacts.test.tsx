// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const api=vi.hoisted(()=>({module:vi.fn(),list:vi.fn(),catalogue:vi.fn(),status:vi.fn(),settings:vi.fn(),definitions:vi.fn(),submissions:vi.fn(),records:vi.fn(),segments:vi.fn(),preview:vi.fn(),query:''}));
vi.mock('@/lib/api/association',async original=>({...await original<typeof import('@/lib/api/association')>(),getAssociationModuleSnapshot:api.module,listAssociationPage:api.list,getMembershipCatalogueDraft:api.catalogue,getWebsiteStatus:api.status,getSiteContentDraft:api.settings}));
vi.mock('@/lib/api/crm',async original=>({...await original<typeof import('@/lib/api/crm')>(),listCrmIntakeDefinitions:api.definitions,listCrmSubmissionPage:api.submissions,fetchCrmRecordPage:api.records,listCrmSegments:api.segments,previewCrmSegment:api.preview}));
vi.mock('@/lib/surface-prefetch',()=>({associationModuleCacheKey:(w:string)=>`association-module:${w}:viewer`,associationPageCacheKey:(w:string,r:string,q={})=>`crm:${w}:viewer:${r}:${JSON.stringify(q)}`}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:vi.fn(),push:vi.fn()}),useSearchParams:()=>new URLSearchParams(api.query)}));
import { AssociationPlansPanel } from '../plans-panel';
import { AssociationContactsSection } from '../contacts/contacts-section';
import { WebsitePagesHome } from '../website/website-home';
import { publicationState } from '../website/website-status';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { format } from '@/lib/i18n/format';
import { resetSurfaceCache } from '@/lib/surface-cache';
const u=en.associationPage.ux,c=en.associationPage.content;
let host:HTMLDivElement,root:Root;
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
async function render(node:React.ReactNode){await act(async()=>root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>));}
const hrefs=()=>[...host.querySelectorAll('a')].map(link=>link.getAttribute('href') ?? '');
const plan=(planKey:string,name:string)=>({id:`id-${planKey}`,planKey,name,currency:'USD',feeMinor:'1000',billingPeriod:'annual',benefits:[],eligibilityNote:null,published:true,activeFrom:null,activeTo:null,provider:null,providerPlanId:null});
const summary=(over:Record<string,unknown>={})=>({version:2,publishedRevision:2,publishedAt:'2027-01-01T00:00:00Z',updatedAt:null,observations:{north:{revision:2,observedAt:'x'}},issueCount:0,...over});
beforeEach(()=>{resetSurfaceCache();vi.resetAllMocks();api.query='';api.module.mockResolvedValue({canManage:true,module:{state:'enabled'}});api.list.mockResolvedValue({items:[],nextCursor:null});api.settings.mockResolvedValue({published:{schemaVersion:1,sites:{north:{name:{en:'North Society'}}}}});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();resetSurfaceCache();});

describe('[COMP:app-web/site-content] publication status in staff words',()=>{
  it('puts issues first, then unpublished edits, then websites that have not updated',()=>{
    expect(publicationState(summary({version:0,publishedRevision:0}),['north']).key).toBe('notStarted');
    expect(publicationState(summary({issueCount:1,version:3}),['north']).key).toBe('attention');
    expect(publicationState(summary({version:3}),['north']).key).toBe('changes');
    expect(publicationState(summary(),['north','south'])).toMatchObject({key:'waiting',waitingFor:['south']});
    expect(publicationState(summary(),['north']).key).toBe('published');
  });
  it('lists every page as a card named by the website that reads it, never by a name in code',async()=>{
    api.status.mockResolvedValue({collections:[{collection:'home-oasa',readers:['north'],...summary()},{collection:'partners',readers:['north','south'],...summary({version:3})}],programmes:summary({observations:{}}),membership:summary()});
    await render(<WebsitePagesHome workspaceId="w"/>);
    expect(host.textContent).toContain(format(c.homePageFor,{site:'North Society'}));
    expect(host.textContent).toContain(c.statusChanges);
    expect(host.textContent).toContain(format(c.usedOn,{sites:'North Society, SOUTH'}));
    expect(hrefs()).toContain('/w/w/association?section=website&collection=partners');
    expect(hrefs()).toContain('/w/w/association?section=website&page=membership');
  });
});

describe('[COMP:app-web/association] membership plans with a published membership page',()=>{
  it('keeps every plan listed and sends catalogue plans to the membership page editor',async()=>{
    api.list.mockImplementation(async(_w:string,resource:string)=>({items:resource==='plans'?[plan('annual','Annual'),plan('legacy','Legacy')]:[],nextCursor:null}));
    api.catalogue.mockResolvedValue({version:1,publishedRevision:1,document:{},published:{plans:[{key:'annual'}]},observations:{},issues:[]});
    await render(<AssociationPlansPanel workspaceId="w"/>);
    expect(host.querySelectorAll('[data-plan-card]')).toHaveLength(2);
    expect(host.textContent).toContain(u.onMembershipPage);
    expect(hrefs()).toContain('/w/w/association?section=website&page=membership&plan=annual');
    expect([...host.querySelectorAll('button')].filter(button=>button.textContent===en.associationPage.manage.edit)).toHaveLength(1);
  });
  it('shows members the plans read-only, without edit or create actions',async()=>{
    api.module.mockResolvedValue({canManage:false,module:{state:'enabled'}});
    api.list.mockImplementation(async(_w:string,resource:string)=>({items:resource==='plans'?[plan('annual','Annual')]:[],nextCursor:null}));
    await render(<AssociationPlansPanel workspaceId="w"/>);
    expect(host.textContent).toContain(u.readOnly);
    expect([...host.querySelectorAll('button')].some(button=>button.textContent===en.associationPage.manage.edit||button.textContent===en.associationPage.manage.newPlan)).toBe(false);
    expect(api.catalogue).not.toHaveBeenCalled();
  });
});

describe('[COMP:app-web/association] Contacts & forms',()=>{
  it('groups submissions by the form definitions the workspace has and opens each row in the CRM',async()=>{
    api.query='view=forms';
    api.definitions.mockResolvedValue([{definitionKey:'general-enquiry',label:'General enquiry',active:true},{definitionKey:'old-form',label:'Retired form',active:false}]);
    api.submissions.mockResolvedValue({submissions:[{id:'sub-1',contactId:'c1',contactName:'Fictional Person',definitionLabel:'General enquiry',status:'new',submittedAt:'2027-01-01T00:00:00Z'}],nextCursor:'more'});
    await render(<AssociationContactsSection workspaceId="w"/>);
    expect(host.textContent).toContain('General enquiry');expect(host.textContent).not.toContain('Retired form');
    expect(api.submissions).toHaveBeenCalledWith('w',expect.objectContaining({status:'new',cursor:null}));
    expect(hrefs()).toContain('/w/w/crm?review=submissions&submission=sub-1');
    expect([...host.querySelectorAll('button')].find(button=>button.textContent===en.associationPage.next)?.disabled).toBe(false);
  });
  it('lists saved audiences with a live count and links to the CRM segment',async()=>{
    api.query='view=newsletter';
    api.segments.mockResolvedValue({segments:[{id:'seg-1',name:'Newsletter subscribers',description:'Marketing consent granted',archivedAt:null}],catalog:[]});
    api.preview.mockResolvedValue({rows:[{id:'c1',name:'Fictional Person',kind:'person'}],snapshotIds:['c1','c2','c3']});
    await render(<AssociationContactsSection workspaceId="w"/>);
    expect(host.textContent).toContain('Newsletter subscribers');expect(host.textContent).toContain(format(u.peopleCount,{count:3}));
    expect(host.textContent).toContain(format(u.showingFirst,{count:1}));
    expect(hrefs()).toContain('/w/w/crm?review=segments&segment=seg-1');
  });
  it('shows contacts one page at a time with CRM links',async()=>{
    api.records.mockResolvedValue({items:[{kind:'contact',id:'c1',name:'Fictional Person',email:null,phone:null,companyId:null,tags:[]}],nextCursor:null,hasMore:false});
    await render(<AssociationContactsSection workspaceId="w"/>);
    expect(api.records).toHaveBeenCalledWith('w',expect.objectContaining({kind:'contact',limit:25}));
    expect(host.textContent).toContain(u.noEmail);expect(hrefs()).toContain('/w/w/crm/contact/c1');
  });
});
