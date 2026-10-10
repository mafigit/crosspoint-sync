import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from './middleware.js';
import { SESSION_COOKIE } from './session.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cross-site request forgery guard for the cookie-authenticated web surface.
 *
 * SameSite=Lax only stops other *sites*: sibling subdomains (abs.example.org next to
 * sync.example.org) are the same site, and `c.req.json()` parses text/plain bodies that
 * need no CORS preflight. So a state-changing request that carries the session cookie
 * must come from this exact origin. Browsers say so with Sec-Fetch-Site; older ones are
 * checked by Origin. Requests without the cookie (devices, apps using x-auth headers)
 * are never affected, and neither is a request with neither header, since every
 * browser that sends the cookie cross-origin also sends one of them.
 */
export function csrfGuard(trustProxy: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method) || !getCookie(c, SESSION_COOKIE)) return next();
    const site = c.req.header('sec-fetch-site');
    if (site) {
      if (site === 'same-origin' || site === 'none') return next();
      return forbidden(c);
    }
    const origin = c.req.header('origin');
    if (!origin) return next();
    const host = (trustProxy && c.req.header('x-forwarded-host')?.split(',')[0].trim()) || c.req.header('host');
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return forbidden(c);
    }
    return originHost === host ? next() : forbidden(c);
  };
}

function forbidden(c: Parameters<MiddlewareHandler>[0]) {
  return c.json({ code: 2001, message: 'Cross-origin request refused' }, 403);
}
