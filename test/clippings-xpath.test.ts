import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const CROSSINK = {
  id: 'c0ffee0011223344',
  spine: 7,
  start_page: 12, end_page: 13, pages: 40,
  start_word: 5, end_word: 22, words: 30,
  para: 96,
  chapter: 'Chapter 8',
  text: 'So we beat on, boats against the current.',
  created_at: 1752300000,
};
const XP = {
  xpath_start: '/body/DocFragment[8]/body/div[2]/p[4]/text()[1].12',
  xpath_end: '/body/DocFragment[8]/body/div[2]/p[4]/text()[1].53',
};

async function put(app: any, headers: any, items: unknown[]) {
  return app.request(`/api/v1/clippings/${DOC}`, { method: 'PUT', headers, body: JSON.stringify({ items }) });
}
async function list(app: any, headers: any, qs = '') {
  return (await app.request(`/api/v1/clippings/${DOC}${qs}`, { headers })).json();
}

describe('clipping xpaths (KOReader anchors)', () => {
  it('advertises the feature on /healthz', async () => {
    const { app } = makeTestApp();
    const body = await (await app.request('/healthz')).json();
    expect(body.features).toContain('clipping_xpath');
  });

  it('round-trips a KOReader-style clipping with only spine + text + xpaths', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await put(app, headers, [{ id: 'k0reader00000001', spine: 7, text: 'hello', created_at: 1, ...XP }]);
    expect(res.status).toBe(200);
    const body = await list(app, headers);
    expect(body.items[0]).toMatchObject({ spine: 7, text: 'hello', ...XP, para: null, start_offset: null });
  });

  it('CrossInk updates that omit xpaths keep the stored pair', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await put(app, headers, [{ ...CROSSINK, ...XP }]);
    await put(app, headers, [{ ...CROSSINK, start_offset: 10, end_offset: 50 }]);
    const body = await list(app, headers);
    expect(body.items[0]).toMatchObject({ ...XP, start_offset: 10, end_offset: 50 });
  });

  it('a KOReader client can attach xpaths to a CrossInk clipping (write-back)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await put(app, headers, [{ ...CROSSINK, start_offset: 10, end_offset: 50 }]);
    await put(app, headers, [{ ...CROSSINK, start_offset: 10, end_offset: 50, ...XP }]);
    const body = await list(app, headers, '?cursor=0&limit=50');
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ ...XP, para: 96, start_offset: 10 });
  });

  it('explicit nulls clear the xpaths', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await put(app, headers, [{ ...CROSSINK, ...XP }]);
    await put(app, headers, [{ ...CROSSINK, xpath_start: null, xpath_end: null }]);
    const body = await list(app, headers);
    expect(body.items[0].xpath_start).toBeNull();
    expect(body.items[0].xpath_end).toBeNull();
  });

  it('format=reader omits xpaths to keep firmware responses small', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await put(app, headers, [{ ...CROSSINK, ...XP }]);
    const body = await list(app, headers, '?cursor=0&limit=1&format=reader');
    expect(body.items[0]).not.toHaveProperty('xpath_start');
    expect(body.items[0]).not.toHaveProperty('xpath_end');
  });

  it('rejects half pairs, non-xpaths and oversized values', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    expect((await put(app, headers, [{ ...CROSSINK, xpath_start: XP.xpath_start }])).status).toBe(403);
    expect((await put(app, headers, [{ ...CROSSINK, xpath_start: 'nope', xpath_end: 'nope' }])).status).toBe(403);
    const big = '/' + 'a'.repeat(600);
    expect((await put(app, headers, [{ ...CROSSINK, xpath_start: big, xpath_end: big }])).status).toBe(403);
  });

  it('the all-books clippings list includes xpaths', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await put(app, headers, [{ ...CROSSINK, ...XP }]);
    const body = await (await app.request('/api/v1/clippings', { headers })).json();
    expect(body.items[0]).toMatchObject(XP);
  });
});
