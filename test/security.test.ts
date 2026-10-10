import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '../src/app.js';
import { MAX_FAILURES_PER_IP, MAX_FAILURES_PER_USER } from '../src/auth/middleware.js';
import { resetSessionSecretCache } from '../src/auth/session.js';
import { makeTestApp, md5, registerUser } from './helpers.js';

type App = ReturnType<typeof makeTestApp>['app'];

afterEach(() => resetSessionSecretCache());

/** Request as if from a TCP peer, the way @hono/node-server passes it in. */
function from(app: App, ip: string, path: string, init: RequestInit = {}) {
  return app.request(path, init, { incoming: { socket: { remoteAddress: ip } } });
}

function authAs(username: string, password: string) {
  return { 'x-auth-user': username, 'x-auth-key': md5(password) };
}

describe('brute-force protection on device (x-auth) logins', () => {
  it('cuts off an IP after repeated failures, before checking more guesses', async () => {
    const { app } = makeTestApp();
    const { username } = await registerUser(app, 'right-password');
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      const res = await from(app, '203.0.113.5', '/users/auth', { headers: authAs(username, `guess${i}`) });
      expect(res.status).toBe(401);
    }
    // Even the right password is refused from that IP now: guessing is over.
    const blocked = await from(app, '203.0.113.5', '/users/auth', { headers: authAs(username, 'right-password') });
    expect(blocked.status).toBe(429);
    // Other clients are unaffected.
    const other = await from(app, '198.51.100.7', '/users/auth', { headers: authAs(username, 'right-password') });
    expect(other.status).toBe(200);
  });

  it('counts failures for unknown usernames too', async () => {
    const { app } = makeTestApp();
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await from(app, '203.0.113.6', '/users/auth', { headers: authAs(`nobody${i}`, 'x') });
    }
    const { username } = await registerUser(app, 'pw');
    const res = await from(app, '203.0.113.6', '/users/auth', { headers: authAs(username, 'pw') });
    expect(res.status).toBe(429);
  });

  it('locks a username attacked from many IPs, but keeps already-verified devices syncing', async () => {
    const { app } = makeTestApp();
    const { username } = await registerUser(app, 'device-pw');
    // The owner's device authenticated before the attack.
    expect((await from(app, '192.0.2.10', '/users/auth', { headers: authAs(username, 'device-pw') })).status).toBe(200);
    for (let i = 0; i < MAX_FAILURES_PER_USER; i++) {
      await from(app, `10.9.${Math.floor(i / 200)}.${i % 200}`, '/users/auth', { headers: authAs(username, `g${i}`) });
    }
    // A fresh IP with a fresh guess is refused without a password check...
    expect((await from(app, '10.8.0.1', '/users/auth', { headers: authAs(username, 'another') })).status).toBe(429);
    // ...but the device's known-good key still works.
    expect((await from(app, '192.0.2.10', '/users/auth', { headers: authAs(username, 'device-pw') })).status).toBe(200);
  });

  it('limits web logins with the sync password the same way', async () => {
    const { app } = makeTestApp();
    const { username } = await registerUser(app, 'pw');
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      const res = await from(app, '203.0.113.9', '/auth/login-kosync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: `nope${i}` }),
      });
      expect(res.status).toBe(401);
    }
    const res = await from(app, '203.0.113.9', '/auth/login-kosync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw' }),
    });
    expect(res.status).toBe(429);
  });

  it('limits login-token guessing per account', async () => {
    const { app } = makeTestApp();
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) {
      await from(app, '203.0.113.10', '/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: `xp1_1_${'0'.repeat(31)}${i % 10}` }),
      });
    }
    const res = await from(app, '203.0.113.10', '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: `xp1_1_${'1'.repeat(32)}` }),
    });
    expect(res.status).toBe(429);
  });
});

describe('client IP for rate limits', () => {
  const create = (app: App, ip: string, headers: Record<string, string>, n: number) =>
    from(app, ip, '/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: `u${n}-${Math.random().toString(36).slice(2, 7)}`, password: md5('x') }),
    });

  it('ignores spoofed forwarding headers by default', async () => {
    const { app } = makeTestApp({ authRateLimitPerMinute: 2 });
    expect((await create(app, '203.0.113.20', { 'cf-connecting-ip': '1.1.1.1' }, 1)).status).toBe(201);
    expect((await create(app, '203.0.113.20', { 'x-forwarded-for': '2.2.2.2' }, 2)).status).toBe(201);
    expect((await create(app, '203.0.113.20', { 'cf-connecting-ip': '3.3.3.3' }, 3)).status).toBe(429);
  });

  it('behind a trusted proxy, uses the hop the proxy appended, not the client-supplied one', async () => {
    const { app } = makeTestApp({ authRateLimitPerMinute: 1, trustProxy: true });
    // The proxy (peer 10.0.0.2) appends the real client after whatever the client sent.
    expect((await create(app, '10.0.0.2', { 'x-forwarded-for': '9.9.9.1, 198.51.100.30' }, 4)).status).toBe(201);
    expect((await create(app, '10.0.0.2', { 'x-forwarded-for': '9.9.9.2, 198.51.100.30' }, 5)).status).toBe(429);
    expect((await create(app, '10.0.0.2', { 'x-forwarded-for': '198.51.100.31' }, 6)).status).toBe(201);
  });

  it('honours CLIENT_IP_HEADER only when configured', async () => {
    const { app } = makeTestApp({ authRateLimitPerMinute: 1, clientIpHeader: 'cf-connecting-ip' });
    expect((await create(app, '10.0.0.3', { 'cf-connecting-ip': '198.51.100.40' }, 7)).status).toBe(201);
    expect((await create(app, '10.0.0.3', { 'cf-connecting-ip': '198.51.100.41' }, 8)).status).toBe(201);
    expect((await create(app, '10.0.0.3', { 'cf-connecting-ip': '198.51.100.40' }, 9)).status).toBe(429);
  });
});

describe('request body limit', () => {
  it('rejects oversized bodies before parsing, without auth', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'big', password: 'x'.repeat(MAX_BODY_BYTES) }),
    });
    expect(res.status).toBe(413);
  });

  it('still accepts a full clipping batch', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: i.toString(16).padStart(16, '0'),
      spine: 1,
      text: 'é'.repeat(2048), // 4096 UTF-8 bytes, the per-clipping maximum
      note: 'n'.repeat(4096),
      created_at: 1752300000 + i,
      layout_signature: 0,
    }));
    const res = await app.request('/api/v1/clippings/a1b2c3d4e5f60718293a4b5c6d7e8f90', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(50);
  });
});

describe('cross-origin request forgery on cookie sessions', () => {
  async function session(app: App) {
    const res = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `h${Math.random().toString(36).slice(2, 8)}` }),
    });
    return res.headers.get('set-cookie')!.split(';')[0];
  }

  const rotate = (app: App, headers: Record<string, string>) =>
    app.request('http://sync.example.org/auth/token/rotate', { method: 'POST', headers });

  it('refuses a text/plain POST from a sibling subdomain', async () => {
    const { app } = makeTestApp();
    const cookie = await session(app);
    const res = await app.request('http://sync.example.org/account/kosync', {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain', 'sec-fetch-site': 'same-site', origin: 'https://abs.example.org' },
      body: JSON.stringify({ username: 'victim', password: 'attacker-knows' }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses a mismatched Origin from browsers without Sec-Fetch-Site', async () => {
    const { app } = makeTestApp();
    const cookie = await session(app);
    const res = await rotate(app, { cookie, origin: 'https://abs.example.org', host: 'sync.example.org' });
    expect(res.status).toBe(403);
  });

  it('allows same-origin requests from the web pages', async () => {
    const { app } = makeTestApp();
    const cookie = await session(app);
    expect((await rotate(app, { cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await rotate(app, { cookie, origin: 'http://sync.example.org', host: 'sync.example.org' })).status).toBe(200);
  });

  it('never affects device or app requests that use x-auth headers', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/syncs/progress', {
      method: 'PUT',
      headers: { ...headers, 'sec-fetch-site': 'cross-site', origin: 'tauri://localhost' },
      body: JSON.stringify({ document: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', progress: '/body/DocFragment[1]', percentage: 0.1, device: 'x', device_id: 'X' }),
    });
    expect(res.status).toBe(200);
  });
});
