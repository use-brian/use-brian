import { pathToFileURL } from 'node:url';

/** Hosted deployment integration; self-hosted forks never call this hook. */
export async function triggerHostedWebRelease({ env = process.env, request = fetch } = {}) {
  if (env.GITHUB_REPOSITORY !== 'use-brian/use-brian' || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Hosted web releases require the canonical repository main branch.');
  }
  const secret = env.HOSTED_APP_WEB_DEPLOY_HOOK?.trim();
  if (!secret) throw new Error('HOSTED_APP_WEB_DEPLOY_HOOK is not configured.');
  let url;
  try {
    url = new URL(secret);
  } catch {
    throw new Error('HOSTED_APP_WEB_DEPLOY_HOOK must be a Vercel Deploy Hook URL.');
  }
  if (url.origin !== 'https://api.vercel.com' || url.username || url.password ||
      url.search || url.hash || !/^\/v1\/integrations\/deploy\/prj_[a-zA-Z0-9]+\/[a-zA-Z0-9]+$/.test(url.pathname)) {
    throw new Error('HOSTED_APP_WEB_DEPLOY_HOOK must be a Vercel Deploy Hook URL.');
  }
  let response;
  try {
    response = await request(url.href, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Fetch errors can contain the credential-bearing URL. Never print them.
    throw new Error('Deploy hook request failed or timed out. Check Vercel before retrying.');
  }
  if (!response.ok) throw new Error(`Deploy hook returned HTTP ${response.status}. Check Vercel before retrying.`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Deploy hook returned an invalid acknowledgement. Check Vercel before retrying.');
  }
  const job = body?.job;
  if (!job || typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(job.id) ||
      !['PENDING', 'RUNNING', 'SUCCESS'].includes(job.state)) {
    throw new Error('Deploy hook did not acknowledge an accepted job. Check Vercel before retrying.');
  }
  return { id: job.id, state: job.state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const job = await triggerHostedWebRelease();
    console.log(`Vercel accepted app-web production build job ${job.id} (${job.state}). Verify deployment readiness in Vercel.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
