# Payments — Creem checkout + webhook + KV pass entitlement

Design: payments are **optional**. If `CREEM_API_KEY` / `CREEM_WEBHOOK_SECRET` are unset,  
all payment endpoints return `501` and the frontend hides the paywall (via `/api/auth/status`).  
The webhook must **fail closed** — verify the raw body signature before anything else.

## 1. `backend/lib/creem.ts` — checkout, webhook verify, pass store

```ts
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { keys } from "./store";               // your KV key helpers, e.g. `pass(subjectId)`
import { timingSafeEqual } from "@shared/session";

const DEFAULT_CREEM_API_BASE = "https://api.creem.io";

export function isCreemConfigured(env: AppEnv["Bindings"]): boolean {
  return Boolean(env.CREEM_API_KEY && env.CREEM_WEBHOOK_SECRET);
}
export function passProductId(env: AppEnv["Bindings"], passType: "make" | "pro"): string | undefined {
  return passType === "make" ? env.CREEM_MAKE_PASS_ID : env.CREEM_PRO_PASS_ID;
}

export interface CreemCheckoutResult { checkoutUrl: string; id: string; }

export async function createCreemCheckout(
  env: AppEnv["Bindings"],
  input: { passType: "make" | "pro"; subjectType: "user" | "session"; subjectId: string; successUrl?: string },
): Promise<CreemCheckoutResult> {
  const productId = passProductId(env, input.passType);
  if (!productId) throw new Error(`Missing product id for pass "${input.passType}"`);

  const base = env.CREEM_API_BASE ?? DEFAULT_CREEM_API_BASE;
  const siteUrl = env.SITE_URL ?? "https://my-app.com";
  const successUrl = input.successUrl ?? `${siteUrl}/checkout/success?pass=${input.passType}`;

  const response = await fetch(`${base}/v1/checkouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CREEM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: productId,
      success_url: successUrl,
      // Entitlement follows the metadata back via the webhook.
      metadata: { subjectType: input.subjectType, subjectId: input.subjectId, passType: input.passType },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Creem checkout failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as { checkout_url?: string; id?: string };
  if (!data.checkout_url) throw new Error("Creem checkout response missing checkout_url");
  return { checkoutUrl: data.checkout_url, id: data.id ?? "" };
}

/* ---------------- Webhook HMAC (verify RAW body, never parsed JSON) ---------------- */

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function verifyCreemWebhook(rawBody: string, sigHeader: string | undefined, secret: string): Promise<boolean> {
  if (!sigHeader) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expected.toLowerCase(), sigHeader.toLowerCase());
}

/* ---------------- Pass entitlement (KV, TTL) ---------------- */

const PASS_TTL = 60 * 60 * 24 * 30; // 30d; renewal webhooks extend it

export async function grantPass(
  kv: NonNullable<AppEnv["Bindings"]["APP_KV"]>, subjectId: string, passType: "make" | "pro",
): Promise<void> {
  await kv.put(keys.pass(subjectId), passType, { expirationTtl: PASS_TTL });
}
export async function getPass(
  kv: NonNullable<AppEnv["Bindings"]["APP_KV"]>, subjectId: string,
): Promise<"free" | "make" | "pro"> {
  const v = await kv.get(keys.pass(subjectId));
  return v === "make" || v === "pro" ? v : "free";
}

/* ---------------- Webhook event routing ---------------- */

export interface CreemWebhookEvent { eventType?: string; object?: { metadata?: Record<string, string> }; }

export async function handleCreemEvent(c: Context<AppEnv>, event: CreemWebhookEvent): Promise<string> {
  const metadata = event.object?.metadata ?? {};
  const subjectId = metadata.subjectId;
  if (!subjectId) return "ignored: no subjectId in metadata";
  const passType = metadata.passType === "pro" ? "pro" : "make";

  const paid = ["checkout.completed", "subscription.paid", "subscription.active"].includes(event.eventType ?? "");
  if (paid) {
    await grantPass(c.env.APP_KV, subjectId, passType);
    try {
      const { recordEvents } = await import("./db");
      await recordEvents(c.env.DB, [{ userId: metadata.subjectType === "user" ? subjectId : null,
        sessionId: metadata.subjectType === "session" ? subjectId : undefined,
        name: "checkout_complete", params: { passType } }]);
    } catch { /* analytics loss must not block entitlement */ }
    return `granted ${passType} to ${subjectId}`;
  }
  return `ignored event: ${event.eventType ?? "unknown"}`;
}
```

## 2. `backend/routes/payments.ts` — routes

```ts
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { authMiddleware } from "../middleware/auth";
import { recordEvents } from "../lib/db";
import { createCreemCheckout, handleCreemEvent, isCreemConfigured, verifyCreemWebhook } from "../lib/creem";
import { checkoutSchema } from "@shared/schemas/api"; // zod: { subjectId, subjectType, passType, successUrl? }

export const payments = new Hono<AppEnv>();

payments.use("/checkout", authMiddleware);

payments.post("/checkout", async (c) => {
  if (!isCreemConfigured(c.env)) return c.json({ error: "Payments are not configured", code: "PAYMENTS_DISABLED" }, 501);
  const parsed = checkoutSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid request" }, 400);

  // Entitlement must match the current identity — no buying a pass for someone else.
  const currentSubject = c.get("subjectId");
  if (parsed.data.subjectId !== currentSubject) return c.json({ error: "Subject mismatch" }, 403);

  try {
    const checkout = await createCreemCheckout(c.env, {
      passType: parsed.data.passType, subjectType: parsed.data.subjectType,
      subjectId: parsed.data.subjectId, successUrl: parsed.data.successUrl,
    });
    await recordEvents(c.env.DB, [{ sessionId: c.get("authKind") === "session" ? currentSubject : undefined,
      userId: c.get("authKind") === "user" ? currentSubject : null,
      name: "checkout_start", params: { passType: parsed.data.passType, checkoutId: checkout.id } }]);
    return c.json({ checkoutUrl: checkout.checkoutUrl, checkoutId: checkout.id });
  } catch (error) {
    console.error("[creem] checkout failed", error);
    return c.json({ error: "Checkout failed", retryable: true }, 502);
  }
});

payments.post("/webhooks/creem", async (c) => {
  if (!c.env.CREEM_WEBHOOK_SECRET) return c.json({ error: "Not configured" }, 501);
  const rawBody = await c.req.text();                       // MUST read raw text first
  const signature = c.req.header("creem-signature");
  if (!(await verifyCreemWebhook(rawBody, signature, c.env.CREEM_WEBHOOK_SECRET))) {
    return c.json({ error: "Invalid signature" }, 401);
  }
  let event: Parameters<typeof handleCreemEvent>[1];
  try { event = JSON.parse(rawBody); } catch { return c.json({ error: "Invalid JSON" }, 400); }
  const outcome = await handleCreemEvent(c, event);
  return c.json({ received: true, outcome });
});
```

## 3. Frontend flow

1. `GET /api/auth/status` → `paymentsEnabled`. If false, hide the upgrade/paywall UI.
2. On upgrade click: `POST /api/payments/checkout` with the current `subjectId` (from     
   `c.get("subjectId")` on the backend, mirrored client-side from the session/user) and     
   `passType`. Redirect the browser to `checkoutUrl`.
3. After Creem redirects to `successUrl`, the pass is already granted in KV by the webhook     
   (idempotent). Re-fetch the entitlement to unlock features.

## 4. Secrets to set

```
wrangler secret put CREEM_API_KEY
wrangler secret put CREEM_WEBHOOK_SECRET
```

`CREEM_MAKE_PASS_ID` / `CREEM_PRO_PASS_ID` go in `vars` (product ids per pass tier);  
`CREEM_API_BASE` only if using a non-default region (e.g. `https://api.creem.io`).
