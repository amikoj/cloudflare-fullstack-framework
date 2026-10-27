# SEO — canonical URLs, legacy 301 redirects, robots, sitemap, JSON-LD

The whole point: **don't let old/duplicate URLs 404 or soft-404.** Centralize every URL
rule as a pure function in `shared/seo/urls.ts` so the Worker (redirects) and React Router
loaders (canonical/sitemap) behave identically.

## 1. `shared/seo/urls.ts` — the URL rules layer

Pure functions: no DB, no Request. This makes them unit-testable and reusable in two
places (Worker redirect + SSR canonical), preventing dev/prod drift.

```ts
export const SITE_URL = "https://my-app.com";
export const CANONICAL_HOST = "my-app.com";

/** Old domains → whole-site 301 to canonical. Do NOT include *.pages.dev (breaks previews). */
export const LEGACY_HOSTS: readonly string[] = [
  "my-old-app.ai", "www.my-old-app.ai", "my-app.vercel.app", "www.my-app.com",
];

/** Old path prefixes (no slug) → redirect to new path. key lowercase, no trailing slash. */
const EXACT_REDIRECTS: Record<string, string> = {
  "/guides": "/gifts", "/blog": "/gifts", "/posts": "/gifts", "/articles": "/gifts",
  "/explore": "/gifts", "/admin": "/",
};

/** Old prefixes carrying a slug → must confirm the new article exists before 301. */
const SLUG_PREFIXES: readonly string[] = ["/blog/", "/guides/", "/articles/", "/posts/", "/gift/"];

const NON_ARTICLE_SEGMENTS = new Set(["page", "category", "tag", "author", "feed", "index"]);

export function normalizePath(pathname: string): string {
  let path = pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

export function absoluteUrl(pathname: string, siteUrl: string = SITE_URL): string {
  const base = siteUrl.replace(/\/$/, "");
  const path = normalizePath(pathname || "/");
  return path === "/" ? `${base}/` : `${base}${path}`;
}

export type LegacyMatch =
  | { kind: "exact"; to: string }
  | { kind: "slug"; slug: string };

/** Detect an old URL. null = not legacy, serve normally (or 404). */
export function matchLegacyPath(rawPathname: string): LegacyMatch | null {
  const path = normalizePath(rawPathname).toLowerCase();
  if (path === "/") return null;
  const exact = EXACT_REDIRECTS[path];
  if (exact) return { kind: "exact", to: exact };

  let matched: string | null = null;
  for (const prefix of SLUG_PREFIXES) {
    if (!path.startsWith(prefix)) continue;
    if (!matched || prefix.length > matched.length) matched = prefix; // longest match wins
  }
  if (!matched) return null;

  const rest = path.slice(matched.length);
  if (!rest) return { kind: "exact", to: "/gifts" };
  const segment = rest.split("/")[0] ?? "";
  if (!segment) return { kind: "exact", to: "/gifts" };
  if (NON_ARTICLE_SEGMENTS.has(segment) || /^\d+$/.test(segment)) return { kind: "exact", to: "/gifts" };

  let slug = segment;
  try { slug = decodeURIComponent(segment); } catch { /* illegal %, pass through */ }
  return { kind: "slug", slug };
}

export function toSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isLegacyHost(host: string, extraHosts?: string | null): boolean {
  const hostname = host.toLowerCase();
  if (hostname === CANONICAL_HOST) return false;
  if (LEGACY_HOSTS.includes(hostname)) return true;
  if (!extraHosts) return false;
  return extraHosts.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean).includes(hostname);
}
```

## 2. `backend/lib/redirects.ts` — the 301 resolver

Three layers so a legacy URL is **never** a 404:
1. legacy/www host → same path on canonical host
2. trailing/duplicate slash → normalized path
3. legacy path → exact match jumps; slug match queries the DB (article exists → `/gifts/<slug>`;
   else nearest by keyword; else list page). Without DB, fall back to the list page rather
   than guessing.

```ts
import type { D1Database } from "@cloudflare/workers-types";
import { SITE_URL, absoluteUrl, isLegacyHost, matchLegacyPath, normalizePath, toSlug } from "@shared/seo/urls";
import { findSimilarGuides, getGuide } from "./db";

export interface RedirectEnv { SITE_URL?: string; DB?: D1Database; LEGACY_HOSTS?: string; }

export async function resolveLegacyTarget(db: D1Database | null, pathname: string): Promise<string | null> {
  const match = matchLegacyPath(pathname);
  if (!match) return null;
  if (match.kind === "exact") return match.to;

  const slug = toSlug(match.slug);
  if (!slug) return "/gifts";
  if (!db) return "/gifts"; // no DB → never guess, send to list

  try {
    const guide = await getGuide(db, slug);
    if (guide) return `/gifts/${guide.slug}`;
    const [nearest] = await findSimilarGuides(db, slug.replace(/-/g, " "), 1);
    return nearest ? `/gifts/${nearest.slug}` : "/gifts";
  } catch (error) {
    console.error("[seo] legacy redirect lookup failed", error);
    return "/gifts";
  }
}

export async function resolveSeoRedirect(url: URL, env: RedirectEnv): Promise<string | null> {
  const siteUrl = (env.SITE_URL ?? SITE_URL).replace(/\/$/, "");
  if (isLegacyHost(url.hostname, env.LEGACY_HOSTS)) {
    return absoluteUrl(url.pathname, siteUrl) + url.search;
  }
  const normalized = normalizePath(url.pathname);
  if (normalized !== url.pathname) {
    return (normalized === "/" ? `${siteUrl}/` : `${siteUrl}${normalized}`) + url.search;
  }
  const target = await resolveLegacyTarget(env.DB ?? null, url.pathname);
  return target ? `${siteUrl}${target}` : null;
}
```

Wire `resolveSeoRedirect` into `src/worker.ts` **before** the SSR branch (see
`references/deployment.md` step 4). Return a `301` with short `Cache-Control` so it's
rollback-safe.

## 3. `robots.txt` (Hono endpoint)

Disallow only the things that waste crawl budget: API, per-user temp pages, and `?utm_`
parameterized copies (canonical already points at the clean URL).

```ts
app.get("/robots.txt", (c) => {
  const siteUrl = (c.env.SITE_URL ?? "https://my-app.com").replace(/\/$/, "");
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /api/",
    "Disallow: /result/",   // one-per-user temp pages, infinite space
    "Disallow: /saved/",
    "Disallow: /*?utm_",
    "Disallow: /*&utm_",
    "",
    `Sitemap: ${siteUrl}/sitemap.xml`,
    "",
  ].join("\n");
  return c.text(body, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});
```

## 4. `sitemap.xml` (Hono endpoint, DB-aware)

Static pages get hand-written `changefreq`/`priority`. Guide pages are pulled from D1
(`listGuides`) with `lastmod` from `updated_at`. Escape every slug (external data). On DB
error, log and ship just the static pages — never 500 the sitemap.

```ts
const SITEMAP_STATIC_PAGES = [
  { path: "/", changefreq: "daily", priority: "1.0" },
  { path: "/gifts", changefreq: "daily", priority: "0.9" },
  { path: "/about", changefreq: "yearly", priority: "0.3" },
  { path: "/privacy", changefreq: "yearly", priority: "0.2" },
  { path: "/terms", changefreq: "yearly", priority: "0.2" },
];

function escapeXml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
function toIsoDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

app.get("/sitemap.xml", async (c) => {
  const siteUrl = (c.env.SITE_URL ?? "https://my-app.com").replace(/\/$/, "");
  const today = new Date().toISOString().slice(0, 10);
  const entries = SITEMAP_STATIC_PAGES.map((p) =>
    `  <url><loc>${escapeXml(p.path === "/" ? `${siteUrl}/` : `${siteUrl}${p.path}`)}</loc>` +
    `<lastmod>${today}</lastmod><changefreq>${p.changefreq}</changefreq><priority>${p.priority}</priority></url>`);
  if (c.env.DB) {
    try {
      const { listGuides } = await import("./db");
      for (const item of await listGuides(c.env.DB, 500)) {
        entries.push(`  <url><loc>${escapeXml(`${siteUrl}/gifts/${item.slug}`)}</loc>` +
          `<lastmod>${toIsoDate(item.updatedAt) ?? today}</lastmod><changefreq>monthly</changefreq><priority>0.7</priority></url>`);
      }
    } catch (e) { console.error("[seo] sitemap guides query failed", e); }
  }
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...entries, "</urlset>", ""].join("\n");
  return c.text(xml, 200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
});
```

## 5. Canonical `<link>` + OG meta (React Router)

React Router's `meta()` is **whole-route replacement**, not merge — so put the canonical
link in the root `Layout` (not in `root`'s `meta()`), guaranteeing exactly one per page and
naturally stripping `?utm_*` query copies:

```tsx
function CanonicalLink() {
  const { pathname } = useLocation();
  const href = pathname === "/" ? `${SITE_URL}/` : `${SITE_URL}${pathname.replace(/\/$/, "")}`;
  return <link rel="canonical" href={href} />;
}
// inside <head>: <CanonicalLink /> <Meta /> <Links />
```

Page-level meta (title, description, OG) lives in each route's `meta()`. Keep OG/social
fields as a reusable `socialMeta(pathname)` helper that leaf routes spread into their
`meta` array (since `meta` replacement would otherwise drop root's OG fields).

## 6. JSON-LD structured data

Build `Article` + `ItemList` + `FAQPage` (as `@graph`) for guide detail pages, and
`CollectionPage` + `ItemList` + `BreadcrumbList` for list pages. FAQPage rarely yields
rich results but is cheap and highly quotable by LLM/AI Overviews. Helpers:
`organizationJsonLd()`, `websiteJsonLd()`, `breadcrumbJsonLd(items)`, `guideJsonLd(guide)`,
`guideCollectionJsonLd(guides)`. Embed via `<script type="application/ld+json">`.

## 7. Self-host fonts & favicons

Self-host fonts (`public/fonts` + `@font-face`) instead of a Google Fonts stylesheet to
avoid render-blocking cross-origin requests. Serve both `favicon.svg` and `favicon.ico`.
