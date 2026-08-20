/*
 * Founders gate.
 *
 * The simulator is not public yet, so every request to every path has to prove
 * it knows the shared password before Vercel serves a single byte of the build.
 * This runs at the edge, ahead of the static files, which is the only place
 * that guarantee can be made for a site with no server behind it.
 *
 * The password lives in the FOUNDERS_PASSWORD environment variable. Rotating it
 * signs everyone out, because the cookie is signed with it — see src/gate/token.ts.
 */

import { next } from '@vercel/edge';
// Extensionless, unlike the rest of the project: Vercel bundles this file with
// its own resolver, which rejects an explicit `.ts` in the specifier.
import { passwordMatches, sign, verify } from './src/gate/token';

export const config = { matcher: '/:path*' };

const COOKIE = 'pq_gate';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export default async function middleware(request: Request): Promise<Response> {
  const secret = process.env.FOUNDERS_PASSWORD;

  // No password configured is a misconfigured deploy, not an open one. Failing
  // closed means a missing environment variable can never publish the site.
  if (!secret) {
    return html(page({ error: 'This deployment has no gate password configured.' }), 503);
  }

  const url = new URL(request.url);

  if (request.method === 'POST') {
    const form = await request.formData();
    const submitted = form.get('password');
    if (typeof submitted === 'string' && (await passwordMatches(secret, submitted))) {
      const token = await sign(secret, Date.now() + SESSION_MS);
      return new Response(null, {
        status: 303,
        headers: {
          Location: url.pathname,
          'Set-Cookie': cookie(token, url.protocol === 'https:'),
        },
      });
    }
    return html(page({ error: 'That password is not right.' }), 401);
  }

  if (await verify(secret, readCookie(request, COOKIE), Date.now())) return next();

  return html(page({}), 401);
}

function cookie(token: string, secure: boolean): string {
  const parts = [
    `${COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // A gate that got cached would be served to someone who already passed it.
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * The gate is the first thing a founder sees, so it is the masthead and one
 * field — the same five greys and one blue as the simulator behind it.
 */
function page({ error }: { error?: string }): string {
  const message = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : '<p class="hint">This preview is private while we get it ready.</p>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>PLANE QUEUE</title>
    <style>
      :root {
        --bg: #0d0f12;
        --raised: #191d22;
        --line: #22262c;
        --line-strong: #313740;
        --ink: #e6e8ea;
        --dim: #8b9199;
        --accent: #4a9eff;
        --stop: #ff5f56;
        --ui: -apple-system, BlinkMacSystemFont, 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        background: var(--bg);
        color: var(--ink);
        font: 400 13px/1.5 var(--ui);
      }
      main { width: 100%; max-width: 300px; }
      .brand-name {
        display: block;
        font-size: 20px;
        font-weight: 500;
        letter-spacing: -0.01em;
      }
      .brand-sub {
        display: block;
        margin-top: 2px;
        font-size: 12px;
        color: var(--dim);
      }
      form { margin-top: 28px; display: grid; gap: 10px; }
      label { font-size: 11px; letter-spacing: 0.01em; color: var(--dim); }
      input {
        width: 100%;
        padding: 9px 10px;
        background: var(--raised);
        border: 1px solid var(--line-strong);
        border-radius: 4px;
        color: var(--ink);
        font: inherit;
      }
      input:focus { outline: none; border-color: var(--accent); }
      button {
        padding: 9px 10px;
        background: var(--accent);
        border: none;
        border-radius: 4px;
        color: #08090b;
        font: inherit;
        font-weight: 500;
        cursor: pointer;
      }
      .hint, .error { margin: 14px 0 0; font-size: 12px; }
      .hint { color: var(--dim); }
      .error { color: var(--stop); }
    </style>
  </head>
  <body>
    <main>
      <span class="brand-name">plane queue</span>
      <span class="brand-sub">boarding simulator</span>
      <form method="POST">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autofocus autocomplete="current-password" />
        <button type="submit">Enter</button>
      </form>
      ${message}
    </main>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
