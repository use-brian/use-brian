"use client";
/** Application-only native consent, using the canonical signed review. [COMP:app-web/application-consent] */
import {Suspense,useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {Button} from '@/components/ui/button';
import {useT} from '@/lib/i18n/client';
import {fetchApplicationConsent,decideApplicationConsent,applicationConsentSignInUrl,type ApplicationConsentReview} from '@/lib/api/application-consent';
type State={kind:'loading'}|{kind:'error'}|{kind:'ready'|'submitting';review:ApplicationConsentReview};
export function ApplicationConsent(){
 const t=useT().applicationConsent,params=useSearchParams(),appId=params?.get('application')??'',req=params?.get('req')??'';
 const [state,setState]=useState<State>({kind:'loading'}),generation=useRef(0);
 useEffect(()=>{
  let controller:AbortController|undefined;const clear=()=>{generation.current++;controller?.abort();setState({kind:'loading'});};
  const load=()=>{clear();if(document.hidden)return;controller=new AbortController();const version=generation.current;fetchApplicationConsent(appId,req,controller.signal).then(review=>{if(version===generation.current&&!controller?.signal.aborted)setState({kind:'ready',review});},error=>{if(version===generation.current&&!controller?.signal.aborted){if(error instanceof Error&&error.message==='application_signin_required'){try{window.location.assign(applicationConsentSignInUrl(appId,req));return;}catch{}}setState({kind:'error'});}});};
  const visibility=()=>{if(document.hidden)clear();else load();};load();document.addEventListener('visibilitychange',visibility);
  return()=>{generation.current++;controller?.abort();document.removeEventListener('visibilitychange',visibility);};
 },[appId,req]);
 async function decide(decision:'allow'|'deny'){
  if(state.kind!=='ready')return;const version=generation.current,review=state.review;setState({kind:'submitting',review});
  try{const redirect=await decideApplicationConsent(appId,req,review,decision);if(version===generation.current)window.location.assign(redirect);}catch{if(version===generation.current)setState({kind:'error'});}
 }
 return <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-8"><section className="w-full max-w-lg min-w-0 rounded-xl border border-border bg-card p-6 space-y-5"><h1 className="text-lg font-semibold">{t.title}</h1>
 {state.kind==='loading'&&<p role="status">{t.loading}</p>}{state.kind==='error'&&<p role="alert">{t.unavailable}</p>}
 {(state.kind==='ready'||state.kind==='submitting')&&<><p className="break-all font-medium">{state.review.clientName??t.unnamed}</p><p>{t.explanation}</p><dl className="space-y-2"><dt className="font-medium">{t.workspace}</dt><dd className="break-all">{state.review.workspaces[0].name}</dd><dt className="font-medium">{t.scope}</dt><dd>{state.review.scope==='read'?t.read:t.readWrite}</dd></dl><h2 className="font-medium">{t.resources}</h2><ul className="divide-y divide-border">{state.review.application.resources.map((resource,index)=><li key={index} className="break-all py-3"><p>{resource.typeKey}</p><p>{t.selection}: {resource.selector.kind==='self'?t.self:resource.selector.ids.join(', ')}</p><p>{t.actions}: {resource.actions.join(', ')}</p><p>{t.readFields}: {resource.readFields.join(', ')}</p><p>{t.writeFields}: {resource.writeFields.join(', ')}</p></li>)}</ul><div className="flex gap-3"><Button className="flex-1" disabled={state.kind==='submitting'} onClick={()=>void decide('allow')}>{state.kind==='submitting'?t.submitting:t.allow}</Button><Button className="flex-1" variant="outline" disabled={state.kind==='submitting'} onClick={()=>void decide('deny')}>{t.deny}</Button></div></>}
 </section></main>;
}
export default function Page(){return <Suspense><ApplicationConsent/></Suspense>;}
