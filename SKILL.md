\---  
name: cloudflare-fullstack-framework

description: This skill should be used when scaffolding or building a fullstack web app on Cloudflare Workers with React Router v7 (SSR) + Hono API + D1/KV bindings, or when adding any of four production pillars to such a project: optional dual-mode login (anonymous signed-cookie session + optional Clerk JWT), SEO infrastructure (canonical URLs, legacy 301 redirects, robots.txt, dynamic sitemap.xml, JSON-LD), Cloudflare Workers deployment via wrangler, or payment integration via Creem. Also relevant when migrating an existing app to this stack.  
\---

# Cloudflare Fullstack Framework (React Router + Hono + D1/KV)

## Overview

A reusable skeleton for fullstack apps on Cloudflare Workers that pairs a React Router

v7 SSR frontend with a Hono API layer and D1/KV/AI bindings, and bakes in four

production pillars: optional login, SEO, deployment, and payments. Use it to stand up

a new project quickly, or to add a single pillar to an existing one.

The pattern that makes it work: **one Worker dispatch entry** routes requests to either

the Hono API, the Workers Assets static layer, an SEO 301 redirect, or the React Router

SSR renderer. A shared `shared/` package (aliased `@shared`) holds framework-agnostic

code (session cookie, SEO URL rules, types, zod schemas) imported by both the Worker

and the React Router loaders — so dev and prod never drift.

## When to use

- Scaffolding a new app on Cloudflare Workers: `react-router` (v7) frontend + `hono` API.
- Adding optional login (anonymous signed-cookie session + optional Clerk JWT).
- Adding SEO (canonical URLs, legacy 301 redirects, robots.txt, dynamic sitemap.xml, JSON-LD, OG meta).
- Deploying to Cloudflare with `wrangler` (assets + KV + D1 + AI bindings).
- Integrating payments via Creem (checkout + webhook + pass entitlement).

## Architecture at a glance

The single Worker entry (`src/worker.ts`) dispatches in this order:

1. `/api/*` → Hono app (`backend/src/index.ts`)
2. `/robots.txt`, `/sitemap.xml` → Hono (these read D1, so they need the API path)
3. `/.well-known/*` → 404 (no route, avoid dev noise)
4. paths with a file extension (except `.data` single-fetch suffix) → Workers Assets; 404 if missing
5. SEO 301 redirects (legacy host / trailing slash / old paths) → **before** SSR
6. everything else → React Router SSR via `createRequestHandler`

Bindings flow: `worker.ts` receives `env` (and `ctx`) and passes it to both Hono

(`app.fetch(request, env, ctx)`) and React Router (`loadContext: { cloudflare: { env, ctx } }`).

React Router loaders read `context.cloudflare.env`. Dev mirrors this exactly with a

custom Vite plugin (`devApiDispatch`) so `/api/*` reaches Hono under `react-router dev`.

## Usage workflow

1. **Bootstrap deployment** — copy the config/entry templates from `assets/`

   (`wrangler.jsonc`, `vite.config.ts`, `react-router.config.ts`, `worker.ts`,

   `backend/env.ts`). See `references/deployment.md` for the loadContext contract and

   dev-proxy gotchas.
2. **Add login** — implement dual-mode auth middleware (anonymous signed cookie +

   optional Clerk JWT) and the session claim flow. See `references/auth.md`.
3. **Add SEO** — add the URL-rules layer (`shared/seo/urls.ts`), the redirect resolver,

   robots/sitemap endpoints, canonical `<link>`, and JSON-LD. See `references/seo.md`.
4. **Add payments** — wire Creem checkout + webhook HMAC verification + KV pass

   entitlement. See `references/payment.md`.

## Cross-cutting conventions

- **Fail closed / disabled gracefully.** Any env-secret-gated feature (login, payments,

  SEO host) returns `501` (or `503` for security-unsafe states) when unconfigured, and

  the frontend hides the feature by probing `/api/auth/status`. Never let a missing

  binding crash the whole site.
- **Shared code in `shared/`, aliased `@shared`.** Both the Worker and React Router

  import the same module — no drift between dev and prod.
- **SEO logic is pure functions** in `shared/seo/urls.ts`, reused by both the Worker

  (redirects) and any SSR loader (canonical/sitemap), so behavior is identical everywhere.
- **Timming-safe comparison** (`timingSafeEqual`) for all HMAC signature checks; never

  use `===` on signatures.

## Resources

- `references/deployment.md` — wrangler bindings, Vite dev proxy + API dispatch, Worker

  dispatch entry, `loadContext` contract, deploy/typecheck scripts.
- `references/auth.md` — anonymous signed-cookie session + optional Clerk JWT dual-mode

  middleware, the claim-session flow, frontend Bearer handling.
- `references/seo.md` — URL canonicalization, legacy 301 redirects, robots.txt,

  dynamic sitemap.xml, canonical `<link>`, social/OG meta, JSON-LD.
- `references/payment.md` — Creem checkout creation, webhook HMAC verification, KV pass

  entitlement with TTL, feature-flag wiring.
- `assets/` — copy-ready config + entry templates.
