import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { triggerHostedWebRelease, verifyServingRevision } from '../trigger-hosted-web-release.mjs';

const hook = 'https://api.vercel.com/v1/integrations/deploy/prj_example/secretExample';
const env = { GITHUB_REPOSITORY: 'use-brian/use-brian', GITHUB_REF: 'refs/heads/main', HOSTED_APP_WEB_DEPLOY_HOOK: hook };

describe('[COMP:infra/hosted-web-release] Hosted frontend release trigger', () => {
  const candidate = 'a'.repeat(40);
  const previous = 'b'.repeat(40);

  it('observes the exact build at the public alias after a stale build and a temporary outage', async () => {
    let clock = 0;
    const probes = [];
    const result = await verifyServingRevision(candidate, {
      now: () => clock, wait: async ms => { clock += ms; },
      request: async (url, init) => {
        assert.equal(url.origin + url.pathname, 'https://app.usebrian.ai/site.webmanifest');
        assert.equal(init.method ?? 'GET', 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(init.cache, 'no-store');
        probes.push(url.href);
        if (probes.length === 2) throw new Error('temporary outage');
        return Response.json({ brian_oss_revision: probes.length === 1 ? previous : candidate });
      },
    });
    assert.equal(new Set(probes).size, 3);
    assert.equal(result, new Date(30_000).toISOString());
  });

  it('leaves wrong, partial and unavailable builds unverified at the deadline', async () => {
    for (const [status, stamp] of [[200, previous], [200, candidate.slice(0, 7)], [200, ''], [503, candidate]]) {
      let clock = 0;
      await assert.rejects(verifyServingRevision(candidate, {
        now: () => clock, timeoutMs: 100, wait: async ms => { clock += ms; },
        request: async () => Response.json({ brian_oss_revision: stamp }, { status }),
      }), /Production did not serve OSS/);
      assert.equal(clock, 100);
    }
    await assert.rejects(verifyServingRevision('main'), /full OSS commit SHA/);
  });

  it('enqueues one bounded POST without redirects and reports only the accepted job', async () => {
    const calls = [];
    const result = await triggerHostedWebRelease({ env, request: async (...args) => {
      calls.push(args);
      return Response.json({ job: { id: 'job_example', state: 'PENDING' }, secret: hook });
    } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], hook);
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(calls[0][1].redirect, 'error');
    assert.ok(calls[0][1].signal instanceof AbortSignal);
    assert.deepEqual(result, { id: 'job_example', state: 'PENDING' });
  });

  it('accepts a hook acknowledgement after 50 seconds on the original request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(AbortSignal, 'timeout', ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    let calls = 0;
    const result = triggerHostedWebRelease({ env, request: async (_url, { signal }) => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 50_000));
      signal.throwIfAborted();
      return Response.json({ job: { id: 'slow_job', state: 'RUNNING' } });
    } });
    t.mock.timers.tick(50_000);
    assert.deepEqual(await result, { id: 'slow_job', state: 'RUNNING' });
    assert.equal(calls, 1);
  });

  it('rejects forks, other branches, missing secrets and untrusted destinations before networking', async () => {
    for (const override of [
      { GITHUB_REPOSITORY: 'example/fork' }, { GITHUB_REF: 'refs/heads/develop' },
      { HOSTED_APP_WEB_DEPLOY_HOOK: '' }, { HOSTED_APP_WEB_DEPLOY_HOOK: 'invalid' },
      { HOSTED_APP_WEB_DEPLOY_HOOK: hook.replace('api.vercel.com', 'example.com') },
      { HOSTED_APP_WEB_DEPLOY_HOOK: `${hook}?redirect=example` },
      { HOSTED_APP_WEB_DEPLOY_HOOK: hook.replace('https:', 'http:') },
      { HOSTED_APP_WEB_DEPLOY_HOOK: hook.replace('api.vercel.com', 'user:password@api.vercel.com') },
    ]) {
      let called = false;
      await assert.rejects(triggerHostedWebRelease({ env: { ...env, ...override }, request: () => { called = true; } }));
      assert.equal(called, false);
    }
  });

  it('fails without retrying or leaking credentials on HTTP, transport and acknowledgement failures', async () => {
    for (const response of [
      () => { throw new Error(`request failed: ${hook}`); },
      () => new Response(hook, { status: 503 }),
      () => new Response(hook, { status: 302, headers: { Location: hook } }),
      () => new Response(hook),
      () => Response.json({ job: { id: 'job_example', state: 'ERROR' } }),
      () => Response.json({ job: { id: hook, state: 'PENDING' } }),
      () => Response.json({}),
    ]) {
      let calls = 0;
      await assert.rejects(triggerHostedWebRelease({ env, request: async () => { calls++; return response(); } }), error => {
        assert.ok(!error.message.includes(hook));
        assert.match(error.message, /Check Vercel before retrying/);
        return true;
      });
      assert.equal(calls, 1);
    }
  });
});
