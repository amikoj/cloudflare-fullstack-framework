# Auth — optional dual-mode login (anonymous session + Clerk JWT)

Design goal: **login is optional.** The site works fully for anonymous visitors via a
signed cookie session. If `CLERK_SECRET_KEY` is configured, signed-in users get a Clerk
JWT (`Bearer`) that takes precedence, and on `claim-session` their anonymous history is
moved under their user id.

## 1. `shared/session.ts` — signed cookie (Worker + browser-safe)

Uses Web Crypto HMAC-SHA256 so it runs on both Workers and the browser. The cookie format
is `mg_session=<sessionId>.<hmac>`.

```ts
export const SESSION_COOKIE_NAME = "mg_session";
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 180; // 180 days
export const SESSION_ID_PREFIX = "sess_";
export const DEV_SESSION_COOKIE_SECRET = "dev-only-session-secret";

export interface SessionCookie { sessionId: string; signature: string; }

export function isDevSecret(secret: string | undefined): boolean {
  return !secret || secret === DEV_SESSION_COOKIE_SECRET;
}

async function importKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signSessionId(sessionId: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sessionId));
  return toHex(sig).slice(0, 32);
}

/** Parse without verifying (frontend reads its own cookie). */
export function parseSessionCookie(value: string | undefined | null): SessionCookie | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!sessionId.startsWith(SESSION_ID_PREFIX) || !signature) return null;
  return { sessionId, signature };
}

export async function verifySessionCookie(value: string | undefined | null, secret: string): Promise<string | null> {
  const parsed = parseSessionCookie(value);
  if (!parsed) return null;
  const expected = await signSessionId(parsed.sessionId, secret);
  return timingSafeEqual(expected, parsed.signature) ? parsed.sessionId : null;
}

export function serializeSessionCookie(sessionId: string, signature: string, opts: { secure?: boolean } = {}): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${sessionId}.${signature}`,
    "Path=/", `Max-Age=${SESSION_COOKIE_MAX_AGE}`, "HttpOnly", "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

export function createSessionId(random: () => number = Math.random): string {
  const bytes = new Uint8Array(12);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(random() * 256);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return `${SESSION_ID_PREFIX}${out}`;
}

/** Constant-time compare to avoid timing attacks on signatures. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

## 2. `backend/middleware/auth.ts` — dual-mode middleware

- **User mode:** `Authorization: Bearer <Clerk JWT>` → `verifyToken`, set `userId`,
  `authKind="user"`, `subjectId=userId`. Also read-only parse the `mg_session` cookie so
  `claim-session` can later move that anonymous history over.
- **Anonymous mode:** verify the `mg_session` cookie. Valid → reuse. Missing → mint a new
  one and stash a `pendingSetCookie` to emit after the handler. Tampered → re-sign a clean
  one and return `401` with `retryable: true` (frontend retries transparently).
- **Security fail-closed:** if the request is `https` AND `SESSION_COOKIE_SECRET` is unset,
  return `503 SESSION_UNAVAILABLE` — never fall back to the public dev secret in prod.
- `requireUser` is the strict variant for endpoints that truly need a login (returns
  `501 LOGIN_DISABLED` if Clerk isn't configured).

```ts
import { verifyToken } from "@clerk/backend";
import type { Context, Next } from "hono";
import type { AppEnv } from "../env";
import {
  createSessionId, parseSessionCookie, serializeSessionCookie,
  signSessionId, verifySessionCookie, DEV_SESSION_COOKIE_SECRET,
} from "@shared/session";

const COOKIE = "mg_session";

function sessionSecret(c: Context<AppEnv>): string {
  return c.env.SESSION_COOKIE_SECRET ?? DEV_SESSION_COOKIE_SECRET;
}
function readCookie(c: Context<AppEnv>): string | undefined {
  return c.req.header("Cookie")?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`))?.[1];
}

/** Strict: only for endpoints that require login. */
export async function requireUser(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return c.json({ error: "Unauthorized" }, 401);
  if (!c.env.CLERK_SECRET_KEY) return c.json({ error: "Login is not configured", code: "LOGIN_DISABLED" }, 501);
  try {
    const payload = await verifyToken(header.slice(7), { secretKey: c.env.CLERK_SECRET_KEY });
    const userId = typeof payload.sub === "string" ? payload.sub : undefined;
    if (!userId) return c.json({ error: "Invalid token" }, 401);
    c.set("userId", userId);
    c.set("authKind", "user");
    c.set("subjectId", userId);
    await next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}

/** Dual-mode: login preferred, anonymous fallback. */
export async function authMiddleware(c: Context<AppEnv>, next: Next) {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ") && c.env.CLERK_SECRET_KEY) {
    try {
      const payload = await verifyToken(header.slice(7), { secretKey: c.env.CLERK_SECRET_KEY });
      const userId = typeof payload.sub === "string" ? payload.sub : undefined;
      if (userId) {
        c.set("userId", userId);
        c.set("authKind", "user");
        c.set("subjectId", userId);
        const anonId = await verifySessionCookie(readCookie(c), sessionSecret(c));
        if (anonId) c.set("sessionId", anonId);
        await next();
        return;
      }
    } catch { /* expired token → fall through to anonymous, don't break the visit */ }
  }

  const secret = sessionSecret(c);
  const https = new URL(c.req.url).protocol === "https:";
  if (https && !c.env.SESSION_COOKIE_SECRET) {
    return c.json({ error: "Session storage is unavailable", code: "SESSION_UNAVAILABLE", retryable: true }, 503);
  }

  const raw = readCookie(c);
  const existing = await verifySessionCookie(raw, secret);
  if (raw && parseSessionCookie(raw) && !existing) {
    // tampered → re-sign a clean session, let the client retry
    const sessionId = createSessionId();
    const signature = await signSessionId(sessionId, secret);
    const res = c.json({ error: "Invalid session cookie", code: "INVALID_SESSION", retryable: true }, 401);
    res.headers.append("Set-Cookie", serializeSessionCookie(sessionId, signature, { secure: https }));
    return res;
  }

  let sessionId = existing;
  if (!sessionId) {
    sessionId = createSessionId();
    c.set("pendingSetCookie", serializeSessionCookie(sessionId, await signSessionId(sessionId, secret), { secure: https }));
  }
  c.set("sessionId", sessionId);
  c.set("authKind", "session");
  c.set("subjectId", sessionId);
  await next();

  const pending = c.get("pendingSetCookie");
  if (pending) {
    c.res.headers.append("Set-Cookie", pending);
    c.res.headers.set("x-session-renewed", "1");
  }
}
```

## 3. `backend/routes/auth.ts` — claim + status

`claim-session` runs after login: it moves the anonymous session's saved items under the
new `userId`, then clears the `mg_session` cookie. `/status` lets the frontend know
whether login and payments are enabled.

```ts
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireUser } from "../middleware/auth";
import { claimSaved } from "../lib/store"; // your KV move fn
import { clearSessionCookie } from "@shared/session";

export const auth = new Hono<AppEnv>();

auth.post("/claim-session", requireUser, async (c) => {
  const anonSessionId = c.get("sessionId");
  const userId = c.get("userId")!;
  let claimed = 0;
  if (anonSessionId) claimed = await claimSaved(c.env.APP_KV, anonSessionId, userId);
  const res = c.json({ claimed });
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
});

auth.get("/status", (c) => c.json({
  loginEnabled: Boolean(c.env.CLERK_SECRET_KEY),
  paymentsEnabled: Boolean(c.env.CREEM_API_KEY && c.env.CREEM_WEBHOOK_SECRET),
}));
```

## 4. Frontend usage

- Anonymous identity rides on the `mg_session` cookie automatically (same-origin Worker + Assets).
- When `siteStatus().loginEnabled`, render the login button; otherwise hide it.
- After a successful Clerk login, immediately `POST /api/auth/claim-session` with the
  `Bearer` token, then the cookie is cleared and future requests are user-scoped.

## 5. Secrets to set

```
wrangler secret put CLERK_SECRET_KEY        # omit entirely to run fully anonymous
wrangler secret put SESSION_COOKIE_SECRET    # REQUIRED in prod (https); 32+ random bytes
```
