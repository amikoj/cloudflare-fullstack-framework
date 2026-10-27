// Cloudflare Worker bindings + secrets for the Hono backend.
import type { KVNamespace, D1Database, Ai, Fetcher } from "@cloudflare/workers-types";

export type AppEnv = {
  Bindings: {
    /** Session storage, game state, result cache, pass entitlements. */
    APP_KV: KVNamespace;
    /** Long-tail SEO content + saved items + analytics events. */
    DB: D1Database;
    /** Workers AI binding (preferred, no token, in-network). */
    AI: Ai;
    CF_ACCOUNT_ID: string;
    CF_AI_GATEWAY_ID: string;
    CLOUDFLARE_API_TOKEN?: string;
    OPENAI_API_KEY?: string;
    // ---- Login (optional) ----
    CLERK_SECRET_KEY?: string;
    /** HMAC secret for the anonymous session cookie. REQUIRED in prod (https) → fail-closed. */
    SESSION_COOKIE_SECRET?: string;
    // ---- Payments (Creem) ----
    CREEM_API_KEY?: string;
    CREEM_WEBHOOK_SECRET?: string;
    CREEM_API_BASE?: string;
    CREEM_MAKE_PASS_ID?: string;
    CREEM_PRO_PASS_ID?: string;
    // ---- Site ----
    SITE_URL?: string;
    /** Extra legacy hosts (comma-separated) → 301 to SITE_URL. */
    LEGACY_HOSTS?: string;
    ASSETS: Fetcher;
  };
  Variables: {
    userId?: string;
    sessionId?: string;
    authKind: "user" | "session";
    subjectId: string;
    pendingSetCookie?: string;
  };
};
