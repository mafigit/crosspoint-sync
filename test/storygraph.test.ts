import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { claimReady } from '../src/connectors/queue.js';
import { getAccount } from '../src/connectors/store.js';
import {
  extractCsrf,
  extractPages,
  extractReadInstanceEdit,
  extractStatus,
  parseForm,
  withFinishDate,
  parseSearchResults,
  storygraphConnector,
} from '../src/connectors/storygraph.js';

// Trimmed from live StoryGraph markup (Tailwind classes dropped).
const BROWSE = `
<div class="book-pane" data-book-id="abc-1">
  <div class="book-title-author-and-series">
    <h3><a href="/books/abc-1">Foundryside</a></h3>
    <p><a href="/authors/x1">Robert Jackson Bennett</a></p>
    <p><a href="/series/s1">The Founders Trilogy #1</a></p>
  </div>
</div>
<div class="book-pane" data-book-id="def-2">
  <div class="book-title-author-and-series">
    <h3><a href="/books/def-2?edition=1">The Way of Kings</a></h3>
    <p><a href="/authors/x2">Brandon Sanderson</a></p>
  </div>
</div>
<div class="book-title-author-and-series"><h3><a href="/books/abc-1">Foundryside</a></h3></div>`;

const bookPage = (status: string | null, pages = 400) => `
<html><head><meta name="csrf-token" content="tok&#43;1" /></head><body>
${status === null ? '' : `<span class="read-status-label">${status}</span>`}
<form action="/update-progress">
  <input type="hidden" name="read_status[book_num_of_pages]" class="read-status-book-num-of-pages" value="${pages}" />
</form></body></html>`;

type Call = { url: string; method: string; body?: string; headers?: Record<string, string> };

/** Routes by "METHOD /path" prefix; later registrations win. */
function fakeSite() {
  const calls: Call[] = [];
  const routes: { key: string; status: number; body: string }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    const path = url.replace('https://app.thestorygraph.com', '');
    const full = `${init.method} ${path}`;
    // Exact match, or a prefix match for keys that name a path (not the bare '/').
    const r = [...routes].reverse().find((x) => full === x.key || (!x.key.endsWith('/') && full.startsWith(x.key)));
    const status = r?.status ?? 404;
    const body = r?.body ?? '';
    return { status, text: async () => body, json: async () => JSON.parse(body || '{}') };
  };
  return {
    transport,
    calls,
    on(key: string, status: number, body = '') {
      routes.push({ key, status, body });
    },
    posts: () => calls.filter((c) => c.method === 'POST').map((c) => c.url.replace('https://app.thestorygraph.com', '')),
  };
}

const COOKIES = { session: 'sess', remember: 'rem' };

beforeEach(() => {
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64);
  resetEncryptionKeyCache();
});
afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
});

describe('StoryGraph scraping', () => {
  it('parses browse results, dropping duplicates and query strings', () => {
    expect(parseSearchResults(BROWSE)).toEqual([
      { externalId: 'abc-1', title: 'Foundryside', author: 'Robert Jackson Bennett' },
      { externalId: 'def-2', title: 'The Way of Kings', author: 'Brandon Sanderson' },
    ]);
  });

  it('reads csrf, page count and shelf status off the book page', () => {
    const html = bookPage('currently reading', 321);
    expect(extractCsrf(html)).toBe('tok+1');
    expect(extractPages(html)).toBe(321);
    expect(extractStatus(html)).toBe('currently-reading');
    expect(extractStatus(bookPage('read'))).toBe('read');
    expect(extractStatus(bookPage('to-read'))).toBe('to-read');
    expect(extractStatus(bookPage('did not finish'))).toBe('did-not-finish');
    expect(extractStatus(bookPage(null))).toBeNull();
  });
});

describe('StoryGraph validate', () => {
  it('accepts cookies the site redirects away from sign-in for', async () => {
    const site = fakeSite();
    site.on('GET /users/sign_in', 302);
    site.on('GET /', 200, '<a href="/profile/julia">Profile</a>');
    const r = await storygraphConnector.validate(COOKIES, site.transport);
    expect(r).toEqual({ ok: true, accountLabel: 'julia' });
  });

  it('rejects cookies that still render the sign-in form', async () => {
    const site = fakeSite();
    site.on('GET /users/sign_in', 200, '<form>');
    const r = await storygraphConnector.validate(COOKIES, site.transport);
    expect(r.ok).toBe(false);
    expect(await storygraphConnector.validate({ session: 'x' }, site.transport)).toMatchObject({ ok: false });
  });
});

describe('StoryGraph fan-out', () => {
  async function linkedApp(site: ReturnType<typeof fakeSite>) {
    site.on('GET /users/sign_in', 302);
    site.on('GET /', 200, '');
    const { app, db } = makeTestApp({}, { connectorTransport: site.transport });
    const { headers } = await registerUser(app);
    const link = await app.request('/api/v1/connectors/storygraph', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: COOKIES }),
    });
    expect(link.status).toBe(200);
    await app.request('/api/v1/documents', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ document: DOC, title: 'Foundryside', author: 'Robert Jackson Bennett' }] }),
    });
    site.on('GET /browse', 200, BROWSE);
    const sync = (percentage: number) =>
      app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: DOC, progress: 'p', percentage, device_id: 'd1' }),
      });
    return { app, db, headers, sync };
  }

  it('is listed as a cookies connector', async () => {
    const site = fakeSite();
    const { app, headers } = await linkedApp(site);
    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    const sg = list.connectors.find((c: { id: string }) => c.id === 'storygraph');
    expect(sg).toMatchObject({ linked: true, credential_kind: 'cookies', beta: true });
  });

  it('shelves an unshelved book as currently reading and posts page progress', async () => {
    const site = fakeSite();
    const { db, sync } = await linkedApp(site);
    site.on('GET /books/abc-1', 200, bookPage(null, 400));
    site.on('POST /update-status.js', 200);
    site.on('POST /update-progress', 200);
    await sync(0.3);
    await drainQueue(db, site.transport, 10);

    expect(claimReady(db, 10)).toHaveLength(0);
    expect(site.posts()).toEqual(['/update-status.js?book_id=abc-1&status=currently-reading', '/update-progress']);
    const progress = site.calls.find((c) => c.url.endsWith('/update-progress'))!;
    const form = new URLSearchParams(progress.body);
    expect(form.get('authenticity_token')).toBe('tok+1');
    expect(form.get('read_status[progress_type]')).toBe('pages');
    expect(form.get('read_status[progress_number]')).toBe('120');
    expect(form.get('read_status[book_num_of_pages]')).toBe('400');
    expect(form.get('book_id')).toBe('abc-1');
    expect(progress.headers?.['x-csrf-token']).toBe('tok+1');
    expect(progress.headers?.cookie).toContain('_storygraph_session=sess');
  });

  it('sends a percentage when the edition has no page count, and skips the status post when already reading', async () => {
    const site = fakeSite();
    const { db, sync } = await linkedApp(site);
    site.on('GET /books/abc-1', 200, bookPage('currently reading', 0));
    site.on('POST /update-progress', 200);
    await sync(0.5);
    await drainQueue(db, site.transport, 10);
    expect(site.posts()).toEqual(['/update-progress']);
    const form = new URLSearchParams(site.calls.at(-1)!.body);
    expect(form.get('read_status[progress_type]')).toBe('percentage');
    expect(form.get('read_status[progress_number]')).toBe('50');
  });

  it('marks the book read on finish and never touches a book already read', async () => {
    const site = fakeSite();
    const { db, sync } = await linkedApp(site);
    site.on('GET /books/abc-1', 200, bookPage('currently reading'));
    site.on('POST /update-status.js', 200);
    await sync(0.99);
    await drainQueue(db, site.transport, 10);
    expect(site.posts()).toEqual(['/update-status.js?book_id=abc-1&status=read']);

    site.calls.length = 0;
    site.on('GET /books/abc-1', 200, bookPage('read'));
    await sync(0.4);
    await drainQueue(db, site.transport, 10);
    expect(site.posts()).toEqual([]);
    expect(claimReady(db, 10)).toHaveLength(0);
  });

  it('falls back to rereading when currently-reading is refused', async () => {
    const site = fakeSite();
    const { db, sync } = await linkedApp(site);
    site.on('GET /books/abc-1', 200, bookPage('to-read'));
    site.on('POST /update-status.js?book_id=abc-1&status=currently-reading', 422);
    site.on('POST /update-status.js?book_id=abc-1&status=rereading', 200);
    site.on('POST /update-progress', 200);
    await sync(0.1);
    await drainQueue(db, site.transport, 10);
    expect(site.posts()).toEqual([
      '/update-status.js?book_id=abc-1&status=currently-reading',
      '/update-status.js?book_id=abc-1&status=rereading',
      '/update-progress',
    ]);
  });

  it('flags the account for reauth when a write bounces to sign-in', async () => {
    const site = fakeSite();
    const { db, sync } = await linkedApp(site);
    site.on('GET /books/abc-1', 200, bookPage('currently reading'));
    site.on('POST /update-progress', 302);
    site.on('GET /users/sign_in', 200, '<form>'); // session gone
    await sync(0.2);
    await drainQueue(db, site.transport, 10);
    const account = getAccount(db, 1, 'storygraph');
    expect(account?.status).toBe('needs_reauth');
    expect(claimReady(db, 10)).toHaveLength(0);
  });

  it('treats a redirect as success while the session is still valid', async () => {
    const site = fakeSite();
    const { db, sync } = await linkedApp(site);
    site.on('GET /books/abc-1', 200, bookPage('currently reading'));
    site.on('POST /update-progress', 302);
    await sync(0.2);
    await drainQueue(db, site.transport, 10);
    expect(getAccount(db, 1, 'storygraph')?.status).toBe('ok');
    expect(claimReady(db, 10)).toHaveLength(0);
  });
});

// The "edit read date" link and the fragment it opens (trimmed live shapes).
const readBookPage = `
<html><head><meta name="csrf-token" content="tok&#43;1" /></head><body>
<span class="read-status-label">read</span>
<a href="/edit-read-instance-from-book?read_instance_id=987&amp;book_id=abc-1">Click to edit read date</a>
</body></html>`;
const EDIT_FORM = `
<form action="/read_instances/987" method="post">
  <input type="hidden" name="_method" value="patch" />
  <input type="hidden" name="authenticity_token" value="form-tok" />
  <input type="hidden" name="book_id" value="abc-1" />
  <select name="read_instance[start_day]"><option value="">Day</option><option value="2" selected>2</option></select>
  <select name="read_instance[start_month]"><option value="">Month</option><option value="1" selected>1</option></select>
  <select name="read_instance[start_year]"><option value="">Year</option><option value="2023" selected>2023</option></select>
  <select name="read_instance[day]"><option value="">Day</option><option value="8" selected>8</option></select>
  <select name="read_instance[month]"><option value="">Month</option><option value="10" selected>10</option></select>
  <select name="read_instance[year]"><option value="">Year</option><option value="2026" selected>2026</option></select>
  <input type="submit" name="commit" value="Update" />
</form>`;

describe('StoryGraph read dates', () => {
  // 2023-06-02 12:00 UTC
  const FINISHED_AT = 1_685_707_200;

  it('finds the read-date link and parses the edit form, escaped or not', () => {
    expect(extractReadInstanceEdit(readBookPage)).toBe('/edit-read-instance-from-book?read_instance_id=987&book_id=abc-1');
    const form = parseForm(EDIT_FORM, /\/read_instances\/\d+/)!;
    expect(form.action).toBe('/read_instances/987');
    expect(form.fields).toMatchObject({ _method: 'patch', authenticity_token: 'form-tok', 'read_instance[day]': '8' });
    expect(form.fields.commit).toBeUndefined();
    const js = `$("#modal").html("${EDIT_FORM.replace(/"/g, '\\"').replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\//g, '\\/').replace(/\n/g, '\\n')}");`;
    expect(parseForm(js, /\/read_instances\/\d+/)).toEqual(form);
  });

  it('replaces only the finish date', () => {
    const f = withFinishDate(parseForm(EDIT_FORM, /\/read_instances\/\d+/)!.fields, FINISHED_AT)!;
    expect(f).toMatchObject({
      'read_instance[day]': '2', 'read_instance[month]': '6', 'read_instance[year]': '2023',
      'read_instance[start_day]': '2', 'read_instance[start_month]': '1', 'read_instance[start_year]': '2023',
    });
    expect(withFinishDate({ authenticity_token: 'x' }, FINISHED_AT)).toBeNull();
  });

  const push = (site: ReturnType<typeof fakeSite>, finishedAt?: number) =>
    storygraphConnector.push(
      COOKIES,
      { externalId: 'abc-1', confidence: 1 },
      { kind: 'finished', document: DOC, percentage: 1, timestamp: 1_791_460_000, ...(finishedAt ? { finishedAt } : {}) },
      site.transport
    );

  it('marks read, then dates the read with the backdated finish', async () => {
    const site = fakeSite();
    site.on('GET /books/abc-1', 200, bookPage('currently reading'));
    site.on('POST /update-status.js', 200);
    site.on('GET /edit-read-instance-from-book', 200, EDIT_FORM);
    site.on('POST /read_instances/987', 200);
    // After the status post the book page shows the read and its date link.
    const transport = site.transport;
    let marked = false;
    site.transport = async (url, init) => {
      if (init.method === 'POST' && url.includes('status=read')) marked = true;
      if (marked && init.method === 'GET' && url.endsWith('/books/abc-1')) site.on('GET /books/abc-1', 200, readBookPage);
      return transport(url, init);
    };
    expect(await push(site, FINISHED_AT)).toEqual({ ok: true });
    expect(site.posts()).toEqual(['/update-status.js?book_id=abc-1&status=read', '/read_instances/987']);
    const call = site.calls.at(-1)!;
    const form = new URLSearchParams(call.body);
    expect(form.get('_method')).toBe('patch');
    expect(form.get('authenticity_token')).toBe('form-tok');
    expect(call.headers?.['x-csrf-token']).toBe('form-tok');
    expect([form.get('read_instance[day]'), form.get('read_instance[month]'), form.get('read_instance[year]')]).toEqual(['2', '6', '2023']);
    expect(form.get('read_instance[start_year]')).toBe('2023');
  });

  it('corrects the date of a book already read, and leaves it alone without a date', async () => {
    const site = fakeSite();
    site.on('GET /books/abc-1', 200, readBookPage);
    site.on('GET /edit-read-instance-from-book', 200, EDIT_FORM);
    site.on('POST /read_instances/987', 200);
    expect(await push(site)).toEqual({ ok: true });
    expect(site.posts()).toEqual([]);
    expect(await push(site, FINISHED_AT)).toEqual({ ok: true });
    expect(site.posts()).toEqual(['/read_instances/987']);
  });

  it('keeps the finish and notes it when there is no read-date form', async () => {
    const site = fakeSite();
    site.on('GET /books/abc-1', 200, bookPage('read'));
    const r = await push(site, FINISHED_AT);
    expect(r.ok).toBe(true);
    expect(r.ok && r.note).toMatch(/read date could not be set/);
    expect(site.posts()).toEqual([]);
  });
});
