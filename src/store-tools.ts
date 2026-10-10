// Store + desk tools (Sajan 2026-10-10 2:13 AM PT, heavy mode: "external agents can discover, buy templates, and join the desk").
// The connector only relays the public store API. It never holds keys or funds: the agent pays from its OWN wallet.
// Order tokens pass through in memory for one call and are never logged or stored. Free (not metered).
import { createPublicKey, verify as edVerify } from "node:crypto";
import { z } from "zod";
import { UserInputError, UpstreamError } from "./deepbook.js";

export const STORE_TOOLS = ["list_templates", "create_template_order", "check_template_order", "get_desk_rhythm"] as const;
export const STORE_ORIGIN = "https://thespicemelange.org";
/** Release key pinned in the templates' auto-update skill (ed25519 raw 32 bytes, base64). */
export const RELEASE_KEY_B64 = "aprpUxFvDlUrkz+Mp8WjrTncgKHcNfxQJ/EJVCWaeuc=";
const PREVIEW_RE = /^https:\/\/[a-z0-9-]{1,63}\.spicemelange-site\.pages\.dev$/;

/** Order tokens only ever go to the real store or one of its Cloudflare preview deployments. Anything else fails closed. */
export function storeOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.PLUMBLINE_STORE_URL ?? "").trim();
  if (!raw) return STORE_ORIGIN;
  let o: string;
  try { o = new URL(raw).origin; } catch { throw new Error("PLUMBLINE_STORE_URL is not a URL"); }
  if (o !== STORE_ORIGIN && !PREVIEW_RE.test(o)) throw new Error(`PLUMBLINE_STORE_URL must be ${STORE_ORIGIN} or a spicemelange-site preview; got ${o}`);
  return o;
}

/** In-memory create-order brake on top of the store's own per-IP limit and amount holds. */
export class OrderLimiter {
  private hits = new Map<string, number[]>();
  constructor(private perClientPerHour = 3, private globalPerHour = 60) {}
  take(client: string, now = Date.now()): boolean {
    const cut = now - 3_600_000;
    const all = (this.hits.get("*") ?? []).filter((t) => t > cut);
    const mine = (this.hits.get(client) ?? []).filter((t) => t > cut);
    if (mine.length >= this.perClientPerHour || all.length >= this.globalPerHour) { this.hits.set(client, mine); this.hits.set("*", all); return false; }
    mine.push(now); all.push(now); this.hits.set(client, mine); this.hits.set("*", all);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (k !== "*" && !v.some((t) => t > cut)) this.hits.delete(k);
    return true;
  }
}
export const limiter = new OrderLimiter();

const SKU = z.string().regex(/^[a-z0-9-]{2,40}$/).describe("Template sku from list_templates, e.g. dune-saga-collection or fish-speakers");
const ORDER = z.string().regex(/^SM-[0-9A-HJKMNP-TV-Z]{10}$/).describe("Order id from create_template_order (SM-...)");
const TOKEN = z.string().regex(/^smt_[A-Za-z0-9_-]{43}$/).describe("Private order token from create_template_order (smt_...). Sent only to the store, in a header.");
const DIGEST = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).describe("Sui transaction digest of your exact USDC payment");

type F = typeof fetch;
async function call(f: F, url: string, init: RequestInit = {}, timeoutMs = 15_000) {
  let r: Response;
  try { r = await f(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "plumbline-mcp store-tools", ...(init.headers ?? {}) } }); }
  catch (e) { throw new UpstreamError(`Store unreachable (${(e as Error).message})`); }
  const text = await r.text();
  let j: any = null; try { j = JSON.parse(text); } catch { /* binary or html */ }
  return { status: r.status, ok: r.ok, json: j, text };
}

export function verifyRhythm(body: Buffer, sigB64: string, keyB64 = RELEASE_KEY_B64): boolean {
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(keyB64, "base64")]), format: "der", type: "spki" });
  try { return edVerify(null, body, key, Buffer.from(sigB64.trim(), "base64")); } catch { return false; }
}

type Reg = (name: string, config: any, handler: (...a: any[]) => Promise<any>) => unknown;
type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<any>;
export interface StoreToolOpts { clientId?: string; origin?: string; fetchImpl?: F; lim?: OrderLimiter }

export function registerStoreTools(reg: Reg, wrap: Wrap, opts: StoreToolOpts = {}) {
  const origin = opts.origin ?? storeOrigin();
  const f = opts.fetchImpl ?? fetch;
  const lim = opts.lim ?? limiter;
  const client = opts.clientId ?? "anonymous";
  const NOTE = "Educational templates, not financial advice; no returns promised. All sales final, except where the law requires otherwise. You pay from your own wallet; this connector never holds keys or funds.";

  reg("list_templates", {
    title: "List desk templates",
    description: `List The Spice Melange Golden Path Grok Bot templates with prices in Sui USDC, versions and the no-checkout agent buying flow (from ${origin}/store/catalog.json). ${NOTE}`,
    inputSchema: {},
    annotations: { title: "List desk templates", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap(async () => {
    const r = await call(f, `${origin}/store/catalog.json`);
    if (!r.ok || !r.json?.products) throw new UpstreamError(`catalog.json HTTP ${r.status}`);
    const c = r.json;
    return { store: origin, currency: c.currency, license: c.license, terms: c.terms, disclaimer: c.disclaimer, payment: c.payment, readOnlyJoin: c.readOnlyJoin, termsPage: c.termsPage,
      products: c.products.map((p: any) => ({ sku: p.sku, name: p.name, priceUsdc: p.priceUsdc, version: p.version, description: p.description, includesFuture: p.includesFuture, addons: p.addons, page: p.page })),
      next: "Call create_template_order with a sku, pay the exact amount from your own wallet, then call check_template_order with the digest." };
  }));

  reg("create_template_order", {
    title: "Create a template order",
    description: `Create a store order for one template. Returns the order id, a PRIVATE order token (shown once; keep it secret), the payee and the EXACT Sui USDC amount to send from your own wallet before the expiry. Nothing is charged by this call. Limited to a few orders per client per hour. ${NOTE}`,
    inputSchema: { sku: SKU, email: z.string().email().max(254).optional().describe("Optional receipt email") },
    annotations: { title: "Create a template order", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap(async ({ sku, email }: { sku: string; email?: string }) => {
    if (!lim.take(client)) throw new UserInputError("Too many new orders from this client in the last hour. Finish or reuse an existing order, or try later.");
    const r = await call(f, `${origin}/api/store/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sku, ...(email ? { email } : {}) }) });
    if (!r.ok || !r.json?.order) throw new UserInputError(`Store refused the order (${r.status}): ${r.json?.reason ?? "unknown"}`);
    const o = r.json.order;
    return { orderId: o.orderId, token: o.token, payTo: o.payTo, coinType: o.coinType, amount: o.amount, amountAtomic: o.amountAtomic, expiresAt: o.expiresAt, howToPay: o.howToPay,
      warning: "Keep the token private: it is the only key to your download and re-downloads. Pay the EXACT amount in one wallet transfer. Then call check_template_order with order_id, token and the transaction digest." };
  }));

  reg("check_template_order", {
    title: "Verify payment / get download",
    description: `With a digest: verify your on-chain payment for an order and get the signed download link (plus add-ons). Without: return the order's status (and a fresh link once paid). The token is sent only to the store, in a header, and is never stored. ${NOTE}`,
    inputSchema: { order_id: ORDER, token: TOKEN, digest: DIGEST.optional() },
    annotations: { title: "Verify payment / get download", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap(async ({ order_id, token, digest }: { order_id: string; token: string; digest?: string }) => {
    const r = digest
      ? await call(f, `${origin}/api/store/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: order_id, token, digest }) }, 30_000)
      : await call(f, `${origin}/api/store/status`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ orderId: order_id }) });
    const j = r.json ?? {};
    if (!r.ok) return { ok: false, httpStatus: r.status, reason: j.reason ?? "unknown", retryable: !!j.retryable };
    const abs = (u?: string) => (u ? new URL(u, origin).href : undefined);
    return { ok: true, status: j.status ?? (j.downloadUrl ? "paid" : undefined), product: j.product, sku: j.sku, upgradedFrom: j.upgradedFrom,
      downloadUrl: abs(j.downloadUrl), linkExpiresInSec: j.linkExpiresInSec,
      addons: (j.addons ?? []).map((a: any) => ({ sku: a.sku, name: a.name, downloadUrl: abs(a.downloadUrl) })),
      verifyFiles: `${origin}/templates/versions.json (ed25519-signed; check each ZIP's SHA-256)` };
  }));

  reg("get_desk_rhythm", {
    title: "Desk rhythm (signed guidance)",
    description: `The desk's weekly rhythm from ${origin}/rhythm.json: focus pools, ladder windows, rung guidance, rebalance ranges, projects and lessons. The ed25519 signature is verified against the pinned release key, and the call fails closed if it doesn't match. Guidance only: no orders, no sizes in money, no promised returns. Not financial advice.`,
    inputSchema: {},
    annotations: { title: "Desk rhythm", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, wrap(async () => {
    let body: Buffer, sig: string;
    try {
      const [a, b] = await Promise.all([f(`${origin}/rhythm.json`, { redirect: "error", signal: AbortSignal.timeout(15_000) }), f(`${origin}/rhythm.json.sig`, { redirect: "error", signal: AbortSignal.timeout(15_000) })]);
      if (!a.ok || !b.ok) throw new Error(`HTTP ${a.status}/${b.status}`);
      body = Buffer.from(await a.arrayBuffer()); sig = await b.text();
    } catch (e) { throw new UpstreamError(`rhythm.json unreachable (${(e as Error).message})`); }
    if (!verifyRhythm(body, sig)) throw new UserInputError("rhythm.json signature does NOT verify with the pinned release key; ignore it (fail closed).");
    const doc = JSON.parse(body.toString("utf8"));
    if (doc.guidanceOnly !== true) throw new UserInputError("rhythm.json is not marked guidanceOnly; ignored.");
    return { verified: true, key: "pinned release key (ed25519)", rhythm: doc };
  }));
}
