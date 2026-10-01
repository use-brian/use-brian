/** Only opaque correlation/CSRF state in a short-lived same-origin cookie. Never credentials. */
export const SHOPIFY_SETUP_COOKIE='shopify_pending_setup';
const uuid='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export function parseShopifySetupState(state:string){const match=new RegExp(`^(${uuid})\\.([A-Za-z0-9_-]{43})$`).exec(state);return match?{id:match[1],nonce:match[2]}:null;}
export function setupCookie(workspaceId:string,state:string){if(!new RegExp(`^${uuid}$`).test(workspaceId)||!parseShopifySetupState(state))throw new Error('connector_setup_binding_mismatch');return `${SHOPIFY_SETUP_COOKIE}=${workspaceId}.${state}; Path=/; Max-Age=600; SameSite=Lax${typeof location!=='undefined'&&location.protocol==='https:'?'; Secure':''}`;}
export function readSetupCookie(value:string){const match=new RegExp(`^(${uuid})\\.(.+)$`).exec(value);if(!match)return null;const state=parseShopifySetupState(match[2]);return state?{workspaceId:match[1],...state}:null;}
