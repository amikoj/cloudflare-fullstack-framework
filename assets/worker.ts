import { createRequestHandler } from "react-router";
import type { ServerBuild } from "react-router";
import type { ExportedHandler } from "@cloudflare/workers-types";

import type { AppEnv } from "../backend/env";
import app from "../backend/src/index";
import { resolveSeoRedirect } from "../backend/lib/redirects";

// React Router server build, produced by `react-router build`. Static import
// (not `virtual:react-router/server-build`) so wrangler's esbuild bundles this
// entry directly. `wrangler dev/deploy` requires a prior `react-router build`.
// @ts-expect-error - generated at build time
import * as serverBuild from "../build/server/index.js";

const requestHandler = createRequestHandler(serverBuild as unknown as ServerBuild, "production");

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) API → Hono
    if (url.pathname.startsWith("/api/")) {
      return app.fetch(request as never, env, ctx as never) as unknown as Response;
    }

    // 2) SEO endpoints also go to Hono (robots/sitemap read D1)
    if (url.pathname === "/robots.txt" || url.pathname === "/sitemap.xml") {
      return app.fetch(request as never, env, ctx as never) as unknown as Response;
    }

    // 3) No route for /.well-known/* probes → 404 (avoids dev console noise)
    if (url.pathname.startsWith("/.well-known/")) {
      return new Response("Not Found", { status: 404 });
    }

    // 4) File extension (except React Router's `.data` single-fetch suffix) → Assets
    if (/\.[a-zA-Z0-9]+$/.test(url.pathname) && !url.pathname.endsWith(".data")) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
      return new Response("Not Found", { status: 404 });
    }

    // 5) SEO 301 redirects BEFORE SSR (saves a render, preserves link equity)
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

    // 6) Everything else → React Router SSR
    // loaders read `context.cloudflare.env`. Missing the `cloudflare` wrapper
    // makes env silently undefined (renders with empty data, no error).
    return requestHandler(request as never, {
      cloudflare: { env, ctx, request: request as unknown as Request },
    }) as unknown as Response;
  },
} satisfies ExportedHandler<AppEnv["Bindings"]>;
