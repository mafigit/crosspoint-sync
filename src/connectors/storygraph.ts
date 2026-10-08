import { coreTitle, decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import type {
  Connector,
  Credential,
  DocumentMeta,
  ExternalBook,
  HttpTransport,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * StoryGraph connector (Tier 2, beta, write-only). StoryGraph has no public
 * API; this replays the user's browser session (two cookies) against the same
 * web endpoints the site's own JavaScript calls, the way storygraph.koplugin
 * and BookBridge do. No password is ever stored. Carries progress + status.
 *
 * Cookie sessions expire when the user signs out in that browser; a sign-in
 * redirect on a write flips the account to needs_reauth.
 */

export const STORYGRAPH_BASE = 'https://app.thestorygraph.com';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

interface StorygraphCred extends Credential {
  session: string;
  remember: string;
}

function parseCred(cred: Credential): StorygraphCred | null {
  const c = cred as Partial<StorygraphCred>;
  const session = typeof c.session === 'string' ? c.session.trim() : '';
  const remember = typeof c.remember === 'string' ? c.remember.trim() : '';
  if (!session || !remember) return null;
  return { session, remember };
}

function headers(c: StorygraphCred, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'user-agent': UA,
    cookie: `remember_user_token=${c.remember}; cookies_popup_seen=yes; plus_popup_seen=yes; _storygraph_session=${c.session}`,
    accept: 'text/html,application/xhtml+xml',
    origin: STORYGRAPH_BASE,
    referer: STORYGRAPH_BASE,
    ...extra,
  };
}

async function get(http: HttpTransport, c: StorygraphCred, path: string, extra: Record<string, string> = {}) {
  return http(`${STORYGRAPH_BASE}${path}`, { method: 'GET', headers: headers(c, extra), redirect: 'manual' });
}

// The read-date form only comes back as a Turbo Stream; a plain HTML request is
// redirected to "add a new read" instead (verified live, Oct 2026).
const TURBO_ACCEPT = { accept: 'text/vnd.turbo-stream.html, text/html, application/xhtml+xml' };

/** A Rails XHR form post, as the site's own JavaScript sends it. */
async function post(
  http: HttpTransport,
  c: StorygraphCred,
  path: string,
  csrf: string,
  fields: Record<string, string>,
  referer: string
) {
  return http(`${STORYGRAPH_BASE}${path}`, {
    method: 'POST',
    headers: headers(c, {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/javascript, application/javascript, */*; q=0.01',
      'x-csrf-token': csrf,
      'x-requested-with': 'XMLHttpRequest',
      referer: `${STORYGRAPH_BASE}${referer}`,
    }),
    body: new URLSearchParams({ authenticity_token: csrf, ...fields }).toString(),
    redirect: 'manual',
  });
}

// ---- HTML scraping (no DOM: tolerant regexes over the server-rendered page) --

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const text = (html: string) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function extractCsrf(html: string): string | null {
  const m =
    html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i) ??
    html.match(/<meta\s+content=["']([^"']+)["']\s+name=["']csrf-token["']/i) ??
    html.match(/name=["']authenticity_token["']\s+value=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
}

/** The "edit read date" link of the book's latest read, from its book page. */
export function extractReadInstanceEdit(html: string): string | null {
  const m = html.match(/href=["']([^"']*\/edit-read-instance-from-book\?[^"']*read_instance_id=[^"']+)["']/i);
  return m ? decodeEntities(m[1]).replace(STORYGRAPH_BASE, '') : null;
}

export interface HtmlForm {
  action: string;
  fields: Record<string, string>;
}

/**
 * The first form whose action matches, with every field's current value
 * (hidden inputs, text inputs, and each select's selected option). Tolerates
 * fragments delivered as escaped JavaScript (Rails .js / turbo responses).
 */
export function parseForm(html: string, action: RegExp): HtmlForm | null {
  const escaped = /\\u003c|<form\b[^>]*\\"/i.test(html);
  const src = !escaped ? html : html
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0026/gi, '&')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n');
  for (const f of src.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const act = f[1].match(/action=["']([^"']*)["']/i);
    if (!act || !action.test(decodeEntities(act[1]))) continue;
    const attr = (tag: string, name: string) => {
      const a = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
      return a ? decodeEntities(a[1]) : null;
    };
    const fields: Record<string, string> = {};
    for (const i of f[2].matchAll(/<input\b[^>]*>/gi)) {
      const name = attr(i[0], 'name');
      const type = (attr(i[0], 'type') ?? 'text').toLowerCase();
      if (!name || type === 'submit' || type === 'button') continue;
      if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(i[0])) continue;
      fields[name] = attr(i[0], 'value') ?? '';
    }
    for (const sel of f[2].matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(sel[1], 'name');
      if (!name) continue;
      const options = [...sel[2].matchAll(/<option\b([^>]*)>/gi)];
      const chosen = options.find((o) => /\bselected\b/i.test(o[1])) ?? options[0];
      fields[name] = chosen ? (attr(chosen[1], 'value') ?? '') : '';
    }
    return { action: decodeEntities(act[1]).replace(STORYGRAPH_BASE, ''), fields };
  }
  return null;
}

/** Finish-date selects end in [day]/[month]/[year]; start-date ones name "start". */
export function withFinishDate(fields: Record<string, string>, finishedAt: number): Record<string, string> | null {
  const d = new Date(finishedAt * 1000);
  const parts: Record<string, string> = {
    day: String(d.getUTCDate()),
    month: String(d.getUTCMonth() + 1),
    year: String(d.getUTCFullYear()),
  };
  const out = { ...fields };
  let set = 0;
  for (const name of Object.keys(out)) {
    const m = name.match(/\[(day|month|year)\]$/);
    if (!m || /start/i.test(name)) continue;
    out[name] = parts[m[1]];
    set++;
  }
  return set === 3 ? out : null;
}

/** Page count of the edition the user tracks, from the read-status form (0 = unknown). */
export function extractPages(html: string): number {
  const m =
    html.match(/name=["']read_status\[book_num_of_pages\]["'][^>]*value=["'](\d+)["']/i) ??
    html.match(/value=["'](\d+)["'][^>]*name=["']read_status\[book_num_of_pages\]["']/i);
  return m ? Number(m[1]) : 0;
}

export type Status = 'to-read' | 'currently-reading' | 'read' | 'paused' | 'did-not-finish';

/** The user's shelf status for the book on its page; null when not shelved. */
export function extractStatus(html: string): Status | null {
  const m = html.match(/read-status-label[^>]*>([\s\S]*?)<\//i);
  if (!m) return null;
  const t = text(m[1]).toLowerCase();
  if (t.includes('currently reading') || t.includes('rereading')) return 'currently-reading';
  if (t.includes('did not finish')) return 'did-not-finish';
  if (t.includes('paused')) return 'paused';
  if (t === 'to-read' || t === 'to read') return 'to-read';
  if (t === 'read' || t.endsWith(' read')) return 'read';
  return null;
}

/** Book cards on /browse: first /books/ link is the title, first /authors/ link the author. */
export function parseSearchResults(html: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const chunks = html.split(/class=["'][^"']*book-title-author-and-series/i).slice(1);
  for (const chunk of chunks) {
    const t = chunk.match(/<a[^>]*href=["']\/books\/([^"'/?#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!t) continue;
    const id = t[1];
    if (seen.has(id)) continue;
    const title = text(t[2]);
    if (!title) continue;
    seen.add(id);
    const a = chunk.match(/<a[^>]*href=["']\/authors\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
    out.push({ externalId: id, title, author: a ? text(a[1]) : undefined });
  }
  return out;
}

// ---- Connector ---------------------------------------------------------------

/** Signed in iff the sign-in page redirects away (302); signed out renders it (200). */
async function signedIn(http: HttpTransport, c: StorygraphCred): Promise<boolean> {
  const r = await get(http, c, '/users/sign_in');
  return r.status === 302 || r.status === 303;
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'both cookies are required' };
  try {
    if (!(await signedIn(http, c))) return { ok: false, error: 'StoryGraph did not accept these cookies' };
    // Best effort: the signed-in home page links the user's own profile.
    const home = await get(http, c, '/');
    const m = home.status === 200 ? (await home.text()).match(/href=["']\/profile\/([^"'/?#]+)["']/i) : null;
    return { ok: true, accountLabel: m ? decodeEntities(m[1]) : undefined };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function searchCandidates(http: HttpTransport, c: StorygraphCred, query: string): Promise<Candidate[]> {
  const r = await get(http, c, `/browse?search_term=${encodeURIComponent(query)}`);
  if (r.status !== 200) return [];
  return parseSearchResults(await r.text());
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const c = parseCred(cred);
  const ta = extractTitleAuthor(doc);
  if (!c || !ta) return null;
  // Subtitles ("…: Roman (German Edition)") only hurt StoryGraph's search.
  const q = `${coreTitle(ta.title)} ${ta.author}`.trim();
  const hits = await searchCandidates(http, c, q);
  const decision = decideMatch(ta.title, ta.author, hits);
  if (!decision.accepted || !decision.best) return null;
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: q,
    title: decision.best.title,
    author: decision.best.author ?? null,
  };
}

async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  return (await searchCandidates(http, c, query)).map((h) => ({
    externalId: h.externalId,
    title: h.title,
    author: h.author ?? null,
  }));
}

/** Classify a write response; null means it went through. */
async function classify(http: HttpTransport, c: StorygraphCred, status: number, what: string): Promise<PushResult | null> {
  if (status === 200 || status === 204) return null;
  if (status === 401 || status === 403) return reauth();
  if (status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (status >= 500) return { ok: false, retryable: true, error: `server ${status}` };
  // A redirect is either Rails bouncing an expired session to sign-in, or the
  // form sending us back to the book page. The transport exposes no Location,
  // so ask the session itself.
  if (status === 302 || status === 303) return (await signedIn(http, c)) ? null : reauth();
  return { ok: false, retryable: false, error: `${what} failed (${status})` };
}

const reauth = (): PushResult => ({
  ok: false,
  retryable: false,
  needsReauth: true,
  error: 'StoryGraph session expired. Sign in to StoryGraph and link it again with fresh cookies.',
});

/**
 * Date the book's latest read: open its "edit read date" form from the book page
 * and resubmit it with the finish day/month/year replaced. Marking read itself
 * already succeeded, so a page we can't parse is a note, not a failure.
 */
async function setReadDate(http: HttpTransport, c: StorygraphCred, bookId: string, finishedAt: number): Promise<PushResult> {
  const bookPath = `/books/${bookId}`;
  const page = await get(http, c, bookPath);
  const unsupported = { ok: true as const, note: 'Marked read, but the read date could not be set; edit it on StoryGraph.' };
  const bad = await classify(http, c, page.status, 'loading book page');
  if (bad) return bad;
  const edit = page.status === 200 ? extractReadInstanceEdit(await page.text()) : null;
  if (!edit) return unsupported;
  const fragment = await get(http, c, edit, TURBO_ACCEPT);
  const badEdit = await classify(http, c, fragment.status, 'loading read date form');
  if (badEdit) return badEdit;
  if (fragment.status !== 200) return unsupported;
  const form = parseForm(await fragment.text(), /\/read_instances\/\d+/);
  const fields = form && withFinishDate(form.fields, finishedAt);
  const token = form?.fields.authenticity_token;
  if (!form || !fields || !token) return unsupported;
  const r = await post(http, c, form.action, token, fields, bookPath);
  return (await classify(http, c, r.status, 'setting read date')) ?? { ok: true };
}

async function push(cred: Credential, m: Match, ev: OutboundEvent, http: HttpTransport): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return reauth();
  const bookId = m.externalId;
  const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const finished = ev.kind === 'finished' || pct >= 0.98;

  const page = await get(http, c, `/books/${bookId}`);
  if (page.status === 401 || page.status === 403) return reauth();
  if (page.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (page.status >= 500) return { ok: false, retryable: true, error: `server ${page.status}` };
  if (page.status !== 200) return { ok: false, retryable: false, error: `book page ${page.status}` };
  const html = await page.text();
  const csrf = extractCsrf(html);
  if (!csrf) return { ok: false, retryable: true, error: 'no CSRF token on book page' };
  const current = extractStatus(html);
  const bookPath = `/books/${bookId}`;

  // Finished on StoryGraph already: never downgrade or re-open it (the device
  // keeps syncing the last page). A re-read has to be started on StoryGraph.
  // A backdated finish still corrects the read's date.
  if (current === 'read') return ev.finishedAt ? setReadDate(http, c, bookId, ev.finishedAt) : { ok: true };

  if (finished) {
    const r = await post(http, c, `/update-status.js?book_id=${bookId}&status=read`, csrf, {}, bookPath);
    const bad = await classify(http, c, r.status, 'marking read');
    if (bad) return bad;
    return ev.finishedAt ? setReadDate(http, c, bookId, ev.finishedAt) : { ok: true };
  }

  if (current !== 'currently-reading') {
    let r = await post(http, c, `/update-status.js?book_id=${bookId}&status=currently-reading`, csrf, {}, bookPath);
    // 422: the site wants "rereading" for a book with a past read.
    if (r.status === 422) r = await post(http, c, `/update-status.js?book_id=${bookId}&status=rereading`, csrf, {}, bookPath);
    const bad = await classify(http, c, r.status, 'setting status');
    if (bad) return bad;
  }

  // Pages when the tracked edition has a count (what the site shows), else percent.
  const pages = extractPages(html);
  const fields =
    pages > 0
      ? { 'read_status[progress_number]': String(Math.round(pct * pages)), 'read_status[progress_type]': 'pages' }
      : { 'read_status[progress_number]': String(Math.round(pct * 100)), 'read_status[progress_type]': 'percentage' };
  const r = await post(
    http,
    c,
    '/update-progress',
    csrf,
    { ...fields, 'read_status[book_num_of_pages]': String(pages), book_id: bookId, on_book_page: 'true' },
    bookPath
  );
  return (await classify(http, c, r.status, 'progress update')) ?? { ok: true };
}

export const storygraphConnector: Connector = {
  id: 'storygraph',
  displayName: 'StoryGraph',
  tier: 2,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'cookies',
  beta: true,
  validate,
  match,
  push,
  search,
};
