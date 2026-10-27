# Deployment — Cloudflare Workers + React Router v7 + Hono

This reference covers the wiring that lets a single Worker serve both a React Router SSR
frontend and a Hono API, with D1/KV/AI bindings, and how to run it identically in dev and prod.

## 1. `wrangler.jsonc` — bindings & assets

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "my-app",
  "main": "./src/worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./build/client",
    "binding": "ASSETS"
  },
  "kv_namespaces": [
    { "binding": "APP_KV", "id": "<<kv-id>>" }
  ],
  "d1_databases": [
    { "binding": "DB", "database_name": "my-app-db", "database_id": "<<d1-id>>" }
  ],
  "ai": { "binding": "AI", "remote": true },
  "vars": {
    "SITE_URL": "https://my-app.com",
    "LEGACY_HOSTS": "",
    "CREEM_MAKE_PASS_ID": "",
    "CREEM_PRO_PASS_ID": ""
  },
  "observability": { "logs": { "enabled": true } }
}
```

- `assets.directory` must point at the React Router client build (`build/client`).
- Secrets (never `vars`): `SESSION_COOKIE_SECRET`, `CLERK_SECRET_KEY`, `CREEM_API_KEY`,
  `CREEM_WEBHOOK_SECRET`, `CF_ACCOUNT_ID`, `CF_AI_GATEWAY_ID`, `OPENAI_API_KEY`. Set with
  `wrangler secret put <NAME>`.
- `LEGACY_HOSTS` is a comma-separated runtime override for extra 301 redirect hosts.

## 2. `vite.config.ts` — dev proxy + API dispatch

`cloudflareDevProxy()` only injects bindings into React Router loaders/actions — it does
NOT run the Worker `fetch` handler, so Hono API routes are unreachable under
`react-router dev`. Add a plugin that imports the Hono app and reuses the same
`getPlatformProxy()` bindings the dev proxy creates:

```ts
import { reactRouter } from "@react-router/dev/vite";
import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

function devApiDispatch(): Plugin {
  return {
    name: "my-app-dev-api-dispatch",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "", "http://localhost");
        const isApi = url.pathname.startsWith("/api/");
        const isSeoFile = url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml";
        if (!isApi && !isSeoFile) return next();
        try {
          const { getPlatformProxy } = await import("wrangler");
          const { dispose, ...cloudflare } = await getPlatformProxy();
          const mod = await server.ssrLoadModule("/backend/src/index.ts");
          const app = mod.default;
          const request = new Request(`http://${req.headers.host}${req.url}`, {
            method: req.method!,
            headers: req.headers as HeadersInit,
            body: ["GET", "HEAD"].includes(req.method!)
              ? undefined
              : (req as unknown as ReadableStream),
            duplex: ["GET", "HEAD"].includes(req.method!) ? undefined : "half",
          } as RequestInit);
          const response = await app.fetch(
            request as never,
            cloudflare.env,
            { waitUntil: async (p: Promise<unknown>) => p.catch(() => {}) } as never,
          );
          res.statusCode = response.status;
          response.headers.forEach((v: string, k: string) => res.setHeader(k, v));
          res.end(await response.text());
          await dispose().catch(() => {});
        } catch (error) {
          next(error as Error);
        }
      });
    },
  };
}

export default defineConfig({
  build: { emptyOutDir: false },
  plugins: [cloudflareDevProxy(), devApiDispatch(), tailwindcss(), reactRouter()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@backend": fileURLToPath(new URL("./backend", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
```

Register `devApiDispatch()` **before** `reactRouter()` so it intercepts `/api/*` before
React Router swallows every request.

## 3. `react-router.config.ts`

```ts
import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src",
  ssr: true,
} satisfies Config;
```

## 4. `src/worker.ts` — the dispatch entry

```ts
import { createRequestHandler } from "react-router";
import type { ServerBuild } from "react-router";
import type { ExportedHandler } from "@cloudflare/workers-types";

import type { AppEnv } from "../backend/env";
import app from "../backend/src/index";
import { resolveSeoRedirect } from "../backend/lib/redirects";

// Built by `react-router build`. Static import (not virtual:) so wrangler's
// esbuild bundles this entry directly.
// @ts-expect-error - generated at build time
import * as serverBuild from "../build/server/index.js";

const requestHandler = createRequestHandler(serverBuild as unknown as ServerBuild, "production");

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request as never, env, ctx as never) as unknown as Response;
    }

    if (url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml") {
      return app.fetch(request as never, env, ctx as never) as unknown as Response;
    }

    if (url.pathname.startsWith("/.well-known/")) {
      return new Response("Not Found", { status: 404 });
    }

    // File extension (except React Router's `.data` single-fetch suffix) → static asset.
    if (/\.[a-zA-Z0-9]+$/.test(url.pathname) && !url.pathname.endsWith(".data")) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      return new Response("Not Found", { status: 404 });
    }

    // SEO 301 redirects BEFORE SSR — saves a React render and preserves link equity.
    try {
      const target = await resolveSeoRedirect(url, {
        SITE_URL: env.SITE_URL,
        DB: env.DB,
        LEGACY_HOSTS: env.LEGACY_HOSTS,
      });
      if (target) {
        return new Response(null, {
          status: 301,
          headers: { Location: target, "Cache-Control": "public, max-age=3600" },
        });
      }
    } catch (error) {
      console.error("[seo] redirect resolution failed", error);
    }

    return requestHandler(request as never, {
      cloudflare: { env, ctx, request: request as unknown as Request },
    }) as unknown as Response;
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;
```

**Critical detail:** React Router loaders expect `context.cloudflare.env`. If you pass
`env` at the top level, loaders silently get `undefined` and render with empty data.

## 5. `backend/env.ts` — the `AppEnv` type

```ts
import type { KVNamespace, D1Database, Ai, Fetcher } from "@cloudflare/workers-types";

export type AppEnv = {
  Bindings: {
    APP_KV: KVNamespace;
    DB: D1Database;
    AI: Ai;
    CF_ACCOUNT_ID: string;
    CF_AI_GATEWAY_ID: string;
    CLOUDFLARE_API_TOKEN?: string;
    OPENAI_API_KEY?: string;
    CLERK_SECRET_KEY?: string;
    SESSION_COOKIE_SECRET?: string;
    CREEM_API_KEY?: string;
    CREEM_WEBHOOK_SECRET?: string;
    CREEM_API_BASE?: string;
    CREEM_MAKE_PASS_ID?: string;
    CREEM_PRO_PASS_ID?: string;
    SITE_URL?: string;
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
```

## 6. Scripts (`package.json`)

```json
{
  "scripts": {
    "dev": "react-router dev",
    "build": "react-router build",
    "preview": "wrangler dev",
    "deploy": "react-router build && wrangler deploy",
    "typecheck": "react-router typegen && tsc --noEmit",
    "d1:local": "wrangler d1 execute my-app-db --local --file=./migrations/0001_init.sql",
    "d1:remote": "wrangler d1 execute my-app-db --remote --file=./migrations/0001_init.sql"
  }
}
```

- `deploy` **must** build first: `worker.ts` static-imports `../build/server/index.js`.
- `build.client` assets feed `wrangler.jsonc` `assets.directory`.

## 7. `backend/src/index.ts` — Hono app surface

```ts
import { Hono } from "hono";
import type { AppEnv } from "../env";

const app = new Hono<AppEnv>();

app.get("/api/health", (c) =>
  c.json({ ok: true, ai: Boolean(c.env.CF_AI_GATEWAY_ID), db: Boolean(c.env.DB), kv: Boolean(c.env.APP_KV) }),
);

app.route("/api/game", gameRoutes);
app.route("/api/gift", giftRoutes);
app.route("/api/guides", guides);
app.route("/api/auth", auth);
app.route("/api/analytics", analytics);
app.route("/api/payments", payments);

// SEO endpoints (read D1):
app.get("/robots.txt", ...);
app.get("/sitemap.xml", ...);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  console.error("[api] unhandled error", error);
  return c.json({ error: "Internal error", retryable: true }, 500);
});

export default app;
```

Bindings are accessed as `c.env.DB`, `c.env.APP_KV`. Request `ctx.waitUntil` is
available via `c.executionCtx.waitUntil` if needed for background work.
