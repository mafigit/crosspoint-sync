import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { DB } from '../db/db.js';
import type { Config } from '../config.js';
import { md5Hex, verifyKey } from './password.js';
import { SESSION_COOKIE, verifySession } from './session.js';

export interface AuthedUser {
  id: number;
  username: string;
}

export interface AuthedAccount {
  id: number;
  handle: string;
}

export type AppEnv = {
  Bindings: {
    /** Present when served by @hono/node-server; omitted by Hono's in-memory test helper. */
    incoming?: { socket?: { remoteAddress?: string } };
  };
  Variables: {
    /** The kosync sync identity that owns the reading data (device or resolved from web session). */
    user: AuthedUser;
    /** The master ("general login") account, set on web-session routes. */
    account: AuthedAccount;
    /** Per-app client-IP resolution and failed-login tracking (see authGuardMiddleware). */
    guard: AuthGuard;
  };
};

/**
 * Who is calling, for rate limits. Forwarded headers are client-controlled unless a
 * trusted proxy wrote them, so they only count when configured:
 *  - CLIENT_IP_HEADER (e.g. cf-connecting-ip): a header the proxy always overwrites;
 *  - TRUST_PROXY: the right-most X-Forwarded-For hop, the one the proxy appended.
 * Otherwise the TCP peer address.
 */
export function clientIp(c: Context<AppEnv>, config: Pick<Config, 'trustProxy' | 'clientIpHeader'>): string {
  if (config.clientIpHeader) {
    const v = c.req.header(config.clientIpHeader)?.trim();
    if (v) return v;
  }
  if (config.trustProxy) {
    const hops = c.req.header('x-forwarded-for')?.split(',').map((h) => h.trim()).filter(Boolean);
    if (hops?.length) return hops[hops.length - 1];
  }
  return c.env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

const FAILURE_WINDOW_MS = 15 * 60_000;
/** Failed logins allowed per client IP, and per username across all IPs, per window. */
export const MAX_FAILURES_PER_IP = 20;
export const MAX_FAILURES_PER_USER = 50;

/**
 * Counts failed password checks so guessing is cut off before any PBKDF2 work.
 * Keys are `ip:<addr>` and `user:<name>`; fixed windows, bounded memory.
 */
export class FailureTracker {
  private hits = new Map<string, { start: number; count: number }>();

  private count(key: string, now: number): number {
    const e = this.hits.get(key);
    return e && now - e.start < FAILURE_WINDOW_MS ? e.count : 0;
  }

  blocked(ip: string, username: string | null, now = Date.now()): boolean {
    return this.count(`ip:${ip}`, now) >= MAX_FAILURES_PER_IP ||
      (username !== null && this.count(`user:${username}`, now) >= MAX_FAILURES_PER_USER);
  }

  fail(ip: string, username: string | null, now = Date.now()): void {
    if (this.hits.size > 50_000) {
      for (const [k, e] of this.hits) if (now - e.start >= FAILURE_WINDOW_MS) this.hits.delete(k);
      if (this.hits.size > 50_000) this.hits.clear();
    }
    for (const key of username === null ? [`ip:${ip}`] : [`ip:${ip}`, `user:${username}`]) {
      const e = this.hits.get(key);
      if (!e || now - e.start >= FAILURE_WINDOW_MS) this.hits.set(key, { start: now, count: 1 });
      else e.count++;
    }
  }

  succeed(username: string): void {
    this.hits.delete(`user:${username}`);
  }
}

export interface AuthGuard {
  ipOf(c: Context<AppEnv>): string;
  failures: FailureTracker;
}

export function createAuthGuard(config: Pick<Config, 'trustProxy' | 'clientIpHeader'>): AuthGuard {
  return { ipOf: (c) => clientIp(c, config), failures: new FailureTracker() };
}

// Routes mounted outside createApp (unit tests) still get a guard.
const fallbackGuard = createAuthGuard({ trustProxy: false, clientIpHeader: null });

export function guardOf(c: Context<AppEnv>): AuthGuard {
  return c.get('guard') ?? fallbackGuard;
}

export function authGuardMiddleware(guard: AuthGuard): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('guard', guard);
    await next();
  };
}

export function tooManyAttempts(c: Context) {
  return c.json({ code: 2001, message: 'Too many failed attempts, try again later' }, 429);
}

/** kosync-style error bodies; firmware already parses these shapes. */
export function kosyncError(c: Context, status: 401 | 402 | 403, code: number, message: string) {
  return c.json({ code, message }, status);
}

// Verifying PBKDF2 on every request is wasteful; cache successful (user, key) pairs.
const verifiedCache = new Map<string, string>(); // username -> md5Key
const VERIFIED_CACHE_MAX = 10_000;

export function invalidateAuthCache(username: string): void {
  verifiedCache.delete(username);
}

export function authMiddleware(db: DB): MiddlewareHandler<AppEnv> {
  const getUser = db.prepare('SELECT id, username, key_hash FROM users WHERE username = ?');
  return async (c, next) => {
    const username = c.req.header('x-auth-user');
    const key = c.req.header('x-auth-key');
    if (!username || !key) {
      return kosyncError(c, 401, 2001, 'Unauthorized');
    }
    const row = getUser.get(username) as
      | { id: number; username: string; key_hash: string }
      | undefined;
    const guard = guardOf(c);
    const ip = guard.ipOf(c);
    if (!row) {
      guard.failures.fail(ip, null);
      return kosyncError(c, 401, 2001, 'Unauthorized');
    }
    // A key already verified since startup keeps working even while the account is
    // under attack, so guessing can't lock the owner's devices out.
    if (verifiedCache.get(username) !== key) {
      if (guard.failures.blocked(ip, username)) return tooManyAttempts(c);
      // Stock kosync clients send x-auth-key as MD5(password); some third-party
      // clients (e.g. BookOrbit) send the raw password. Stored hashes are always
      // PBKDF2 of the MD5 form, so fall back to hashing the key before rejecting.
      if (!verifyKey(key, row.key_hash) && !verifyKey(md5Hex(key), row.key_hash)) {
        guard.failures.fail(ip, username);
        return kosyncError(c, 401, 2001, 'Unauthorized');
      }
      guard.failures.succeed(username);
      if (verifiedCache.size >= VERIFIED_CACHE_MAX) {
        verifiedCache.clear();
      }
      verifiedCache.set(username, key);
    }
    c.set('user', { id: row.id, username: row.username });
    await next();
  };
}

/**
 * Require a valid master ("general login") session cookie. Sets `account`.
 * Used for the /account management surface (kosync link, master token rotate).
 */
export function masterAuth(db: DB): MiddlewareHandler<AppEnv> {
  const getAccount = db.prepare('SELECT id, handle FROM accounts WHERE id = ?');
  return async (c, next) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (!session) return kosyncError(c, 401, 2001, 'Not signed in');
    const row = getAccount.get(session.uid) as { id: number; handle: string } | undefined;
    if (!row) return kosyncError(c, 401, 2001, 'Not signed in');
    c.set('account', { id: row.id, handle: row.handle });
    await next();
  };
}

/**
 * Accept EITHER a web session cookie OR the device x-auth headers, resolving to
 * the kosync sync identity that owns the reading data. Used for the /api/v1
 * surface so both the browser and the firmware reach the same endpoints:
 *  - device: x-auth headers -> the kosync user directly.
 *  - web: master session cookie -> the account's linked native kosync user.
 * A signed-in master account with no kosync account linked yet gets 409 (the
 * web UI prompts to create/link one before showing data).
 */
export function sessionOrKeyAuth(db: DB): MiddlewareHandler<AppEnv> {
  const headerAuth = authMiddleware(db);
  const getAccount = db.prepare('SELECT id, handle FROM accounts WHERE id = ?');
  const getKosyncForAccount = db.prepare(
    'SELECT id, username FROM users WHERE account_id = ?'
  );
  return async (c, next) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (session) {
      const account = getAccount.get(session.uid) as { id: number; handle: string } | undefined;
      if (account) {
        c.set('account', account);
        const kosync = getKosyncForAccount.get(account.id) as
          | { id: number; username: string }
          | undefined;
        if (!kosync) {
          return c.json({ code: 2005, message: 'No sync account linked' }, 409);
        }
        c.set('user', kosync);
        return next();
      }
    }
    return headerAuth(c, next);
  };
}

/** Minimal in-memory per-IP fixed-window rate limiter. */
export function rateLimiter(limitPerMinute: number): MiddlewareHandler<AppEnv> {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return async (c, next) => {
    if (limitPerMinute <= 0) return next();
    const ip = guardOf(c).ipOf(c);
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      if (hits.size > 50_000) hits.clear();
      hits.set(ip, { windowStart: now, count: 1 });
    } else {
      entry.count++;
      if (entry.count > limitPerMinute) {
        return c.json({ code: 2001, message: 'Too many requests' }, 429);
      }
    }
    await next();
  };
}
