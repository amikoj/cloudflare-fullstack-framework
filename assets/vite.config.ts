import { reactRouter } from "@react-router/dev/vite";
import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * Dev-only middleware that mirrors the production `src/worker.ts` dispatch for
 * `/api/*`. `cloudflareDevProxy` only forwards bindings to React Router
 * loaders/actions — it does NOT run the worker `fetch` handler, so Hono API
 * routes would be unreachable under `react-router dev`. This plugin imports the
 * Hono app directly and reuses the same `getPlatformProxy` bindings, giving the
 * same `/api/* → Hono` behaviour as `wrangler dev` / deploy.
 */
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
