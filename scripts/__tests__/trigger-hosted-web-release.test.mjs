import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { triggerHostedWebRelease } from '../trigger-hosted-web-release.mjs';

const hook = 'https://api.vercel.com/v1/integrations/deploy/prj_example/secretExample';
const env = { GITHUB_REPOSITORY: 'use-brian/use-brian', GITHUB_REF: 'refs/heads/main', HOSTED_APP_WEB_DEPLOY_HOOK: hook };

describe('[COMP:infra/hosted-web-release] Hosted frontend release trigger', () => {
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
