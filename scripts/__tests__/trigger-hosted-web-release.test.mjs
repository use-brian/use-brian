import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureServingReleaseLeadTime, triggerHostedWebRelease, verifyServingRevision } from '../trigger-hosted-web-release.mjs';

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

  it('measures first edit through the response serving exactly the requested OSS commit', async () => {
    let clock = Date.parse('2026-11-21T04:15:00Z');
    let probes = 0;
    const result = await measureServingReleaseLeadTime(candidate, '2026-11-21T04:00:00Z', {
      now: () => clock,
      wait: async ms => { clock += ms; },
      request: async () => {
        clock += 125;
        return Response.json({ brian_oss_revision: ++probes === 1 ? previous : candidate });
      },
    });
    assert.deepEqual(result, {
      ossSha: candidate,
      firstEditAt: '2026-11-21T04:00:00.000Z',
      verifiedAt: '2026-11-21T04:15:15.250Z',
      elapsedMs: 915_250,
    });
  });

  it('rejects missing, malformed, impossible, offset and future timestamps before polling', async () => {
    let probes = 0;
    const options = {
      now: () => Date.parse('2026-11-21T04:15:00Z'),
      request: async () => { probes++; },
    };
    for (const value of [undefined, null, '', '2026-11-21', '2026-11-21T04:00:00+00:00',
      '2026-02-30T04:00:00Z', '2026-11-21T04:00:00.1001Z', '2026-11-21T04:00:00Z\n']) {
      await assert.rejects(measureServingReleaseLeadTime(candidate, value, options), /must be a UTC timestamp/);
    }
    await assert.rejects(measureServingReleaseLeadTime(candidate, '2026-11-21T04:15:00.001Z', options), /cannot be in the future/);
    assert.equal(probes, 0);
  });

  it('fails without a receipt if the release remains stale or the observation clock predates the edit', async () => {
    const firstEditAt = '2026-11-21T04:00:00.123Z';
    const start = Date.parse(firstEditAt);
    let clock = start;
    const options = {
      now: () => clock,
      timeoutMs: 100,
      wait: async ms => { clock += ms; },
    };
    await assert.rejects(measureServingReleaseLeadTime(candidate, firstEditAt, {
      ...options,
      request: async () => Response.json({ brian_oss_revision: previous }),
    }), /Production did not serve OSS/);
    await assert.rejects(measureServingReleaseLeadTime(candidate, firstEditAt, {
      ...options,
      request: async () => {
        clock = start - 1;
        return Response.json({ brian_oss_revision: candidate });
      },
    }), /verification clock was earlier than the first edit/);
  });

  it('prints a machine-readable receipt only when lead-time measurement is requested', () => {
    const script = fileURLToPath(new URL('../trigger-hosted-web-release.mjs', import.meta.url));
    const fixture = `
      Date.now = () => Date.parse('2026-11-21T04:15:00Z');
      globalThis.fetch = async (url, options) => {
        if (url.origin + url.pathname !== 'https://app.usebrian.ai/site.webmanifest' || options.method) {
          throw new Error('Expected a read of the public manifest');
        }
        return Response.json({ brian_oss_revision: '${candidate}' });
      };`;
    const run = (...args) => spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(fixture)}`, script, '--verify', candidate, ...args,
    ], { encoding: 'utf8', timeout: 5_000 });
    const existing = run();
    assert.equal(existing.status, 0, existing.stderr);
    assert.equal(existing.stdout.trim(), `Production served OSS ${candidate} at 2026-11-21T04:15:00.000Z.`);

    const measured = run('--first-edit-at', '2026-11-21T04:00:00.125Z');
    assert.equal(measured.status, 0, measured.stderr);
    assert.deepEqual(JSON.parse(measured.stdout), {
      ossSha: candidate,
      firstEditAt: '2026-11-21T04:00:00.125Z',
      verifiedAt: '2026-11-21T04:15:00.000Z',
      elapsedMs: 899_875,
    });

    const invalid = run('--first-edit-at', '2026-11-22T04:00:00Z');
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /cannot be in the future/);
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
