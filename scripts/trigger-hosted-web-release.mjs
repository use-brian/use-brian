import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

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
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90_000),
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

/** Read the public build stamp independently of the credential-bearing hook. */
export async function verifyServingRevision(sha, {
  request = fetch, now = Date.now, wait = sleep, timeoutMs = 20 * 60_000,
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full OSS commit SHA.');
  const deadline = now() + timeoutMs;
  let last = 'no response';
  while (now() < deadline) {
    const url = new URL('https://app.usebrian.ai/site.webmanifest');
    url.searchParams.set('check', String(now()));
    try {
      const response = await request(url, {
        redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - now()))),
      });
      const revision = response.status === 200 ? (await response.json())?.brian_oss_revision : null;
      if (response.status === 200 && revision === sha) return new Date(now()).toISOString();
      last = response.status === 200 && /^[a-f0-9]{40}$/.test(revision)
        ? `served ${revision}` : `HTTP ${response.status} without a matching build stamp`;
    } catch {
      last = 'production alias unavailable';
    }
    await wait(Math.max(0, Math.min(15_000, deadline - now())));
  }
  throw new Error(`Production did not serve OSS ${sha} within ${timeoutMs / 1000}s (${last}). Check Vercel before retrying.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--verify') {
      const observed = await verifyServingRevision(args[1]);
      console.log(`Production served OSS ${args[1]} at ${observed}.`);
    } else if (args.length === 0) {
      const job = await triggerHostedWebRelease();
      console.log(`Vercel accepted app-web production build job ${job.id} (${job.state}) at ${new Date().toISOString()}.`);
    } else {
      throw new Error('Usage: trigger-hosted-web-release.mjs [--verify <full-oss-sha>]');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
