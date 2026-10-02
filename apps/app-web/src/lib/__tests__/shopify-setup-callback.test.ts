import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {GET} from '@/app/api/auth/callback/shopify/route';
import {parseShopifySetupState,readSetupCookie,SHOPIFY_SETUP_COOKIE} from '../shopify-setup-state';
const mocks=vi.hoisted(()=>({cookie:vi.fn(),fetch:vi.fn(),deleted:vi.fn()}));
vi.mock('next/headers',()=>({cookies:async()=>({get:mocks.cookie})}));
vi.mock('next/server',()=>({NextResponse:{redirect:(url:URL)=>({url:url.href,cookies:{delete:mocks.deleted}})}}));
vi.mock('@/lib/internal-api-url',()=>({INTERNAL_API_URL:'https://api.test'}));
const id='11111111-1111-4111-8111-111111111111',w='22222222-2222-4222-8222-222222222222',nonce='a'.repeat(43),state=`${id}.${nonce}`;
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',mocks.fetch);mocks.fetch.mockResolvedValue({ok:true});mocks.cookie.mockImplementation((name:string)=>({value:name===SHOPIFY_SETUP_COOKIE?`${w}.${state}`:'auth-cookie'}));});
afterEach(()=>vi.unstubAllGlobals());
describe('[COMP:app-web/shopify-setup] bound callback',()=>{
 it('parses only exact setup state and keeps workspace correlation separate',()=>{expect(parseShopifySetupState(state)?.id).toBe(id);expect(parseShopifySetupState(`${state}.extra`)).toBeNull();expect(readSetupCookie(`${w}.${state}`)?.workspaceId).toBe(w);});
 it('forwards original provider parameters under authenticated bound identity and returns review, not connected',async()=>{const response=await GET(new Request(`https://app.test/api/auth/callback/shopify?state=${state}&code=one-use&shop=shop.myshopify.com&hmac=signature`));expect(mocks.fetch).toHaveBeenCalledTimes(1);const body=JSON.parse(mocks.fetch.mock.calls[0][1].body);expect(body.setupId).toBe(id);expect(body.workspaceId).toBe(w);expect(body.params.code).toBe('one-use');expect(response.url).toContain(`shopifySetup=${id}`);expect(response.url).not.toContain('connected=');expect(mocks.deleted).toHaveBeenCalledWith(SHOPIFY_SETUP_COOKIE);});
 it('rejects cross-setup cookie substitution before exchange',async()=>{mocks.cookie.mockReturnValue({value:`${w}.${id}.${'b'.repeat(43)}`});await GET(new Request(`https://app.test/api/auth/callback/shopify?state=${state}&code=c`));expect(mocks.fetch).not.toHaveBeenCalled();});
 it('keeps the setup ID after an uncertain response and does not repeat the exchange',async()=>{mocks.fetch.mockRejectedValue(new Error('network'));const response=await GET(new Request(`https://app.test/api/auth/callback/shopify?state=${state}&code=c`));expect(response.url).toContain(`shopifySetup=${id}`);expect(response.url).toContain('setupError=');expect(mocks.fetch).toHaveBeenCalledTimes(1);});
});
