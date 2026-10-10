// Store + desk tools (Sajan 2026-10-10 2:13 AM PT, heavy mode: "external agents can discover, buy templates, and join the desk").
// The connector only relays the public store API. It never holds keys or funds: the agent pays from its OWN wallet.
// Order tokens pass through in memory for one call and are never logged or stored. Free (not metered).
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { z } from "zod";
import { UserInputError, UpstreamError } from "./deepbook.js";

export const STORE_TOOLS = ["list_templates", "create_template_order", "check_template_order", "get_desk_rhythm"] as const;
export const STORE_ORIGIN = "https://thespicemelange.org";
/** Release key pinned in the templates' auto-update skill (ed25519 raw 32 bytes, base64). */
export const RELEASE_KEY_B64 = "aprpUxFvDlUrkz+Mp8WjrTncgKHcNfxQJ/EJVCWaeuc=";
const PREVIEW_RE = /^https:\/\/[a-z0-9-]{1,63}\.spicemelange-site\.pages\.dev$/;

/** Order tokens only ever go to the real store. A Cloudflare preview origin is accepted ONLY when the operator also sets
 * PLUMBLINE_ALLOW_PREVIEW_STORE=1 (dev/testing; Siona S7). Anything else fails closed. */
export function storeOrigin(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.PLUMBLINE_STORE_URL ?? "").trim();
  if (!raw) return STORE_ORIGIN;
  let o: string;
  try { o = new URL(raw).origin; } catch { throw new Error("PLUMBLINE_STORE_URL is not a URL"); }
  if (o === STORE_ORIGIN) return o;
  if (PREVIEW_RE.test(o) && env.PLUMBLINE_ALLOW_PREVIEW_STORE === "1") return o;
  throw new Error(`PLUMBLINE_STORE_URL must be ${STORE_ORIGIN}` + (PREVIEW_RE.test(o) ? " (preview origins need PLUMBLINE_ALLOW_PREVIEW_STORE=1)" : `; got ${o}`));
}

/** Payee pin (Siona S2). Set to the production Sui payee ONLY after Sajan confirms it; until then the pin comes from the
 * signed versions.json alone (field `store.payTo`), and orders are marked unverified if that field is absent. */
export const PINNED_PAYEE: string | null = null;
const norm = (a: unknown) => (typeof a === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(a) ? "0x" + a.slice(2).toLowerCase().padStart(64, "0") : null);

/** Reads the signed versions.json (ed25519, pinned release key) and returns its published payee, if any. Throws if the signature fails. */
export async function signedPayee(f: typeof fetch, origin: string): Promise<string | null> {
  let a: Response, b: Response;
  try {
    [a, b] = await Promise.all([f(`${origin}/templates/versions.json`, { redirect: "error", signal: AbortSignal.timeout(15_000) }), f(`${origin}/templates/versions.json.sig`, { redirect: "error", signal: AbortSignal.timeout(15_000) })]);
  } catch (e) { throw new UpstreamError(`versions.json unreachable (${(e as Error).message})`); }
  if (!a.ok || !b.ok) throw new UpstreamError(`versions.json unreachable (HTTP ${a.status}/${b.status})`);
  const body = Buffer.from(await a.arrayBuffer());
  if (!verifyRhythm(body, await b.text())) throw new UserInputError("versions.json signature does NOT verify with the pinned release key; refusing to trust the store's payee.");
  const doc = JSON.parse(body.toString("utf8"));
  return norm(doc?.store?.payTo);
}

/** Decide whether an order's payTo may be shown as payable. Mismatch with any pin = refuse. */
export function checkPayee(orderPayTo: unknown, signed: string | null, pinned: string | null = PINNED_PAYEE) {
  const got = norm(orderPayTo);
  if (!got) return { ok: false as const, reason: "order has no valid payTo" };
  const p = norm(pinned);
  if (p && got !== p) return { ok: false as const, reason: "payTo differs from the connector's pinned payee" };
  if (signed && got !== signed) return { ok: false as const, reason: "payTo differs from the payee in the signed versions.json" };
  return { ok: true as const, verified: Boolean(p || signed), payTo: got };
}

/** In-memory create-order brake on top of the store's own per-IP limit and amount holds (Siona S5):
 *  - rate: perClientPerHour new orders per client, globalPerHour for the whole hosted server;
 *  - holds: at most maxOpenPerClient (2) unpaid orders per client and maxOpenGlobal (15) overall still inside their payment window,
 *    so one client can't pin the store's unique amounts (each unpaid order holds one until it expires). */
export class OrderLimiter {
  private hits = new Map<string, number[]>();
  private open = new Map<string, number[]>(); // client -> expiry ms of orders created through this server
  constructor(private perClientPerHour = 3, private globalPerHour = 60, private maxOpenPerClient = 2, private maxOpenGlobal = 15) {}
  private live(k: string, now: number) { const v = (this.open.get(k) ?? []).filter((e) => e > now); this.open.set(k, v); return v; }
  /** Returns null if allowed (and counts it), else a reason. */
  check(client: string, now = Date.now()): string | null {
    const cut = now - 3_600_000;
    const all = (this.hits.get("*") ?? []).filter((t) => t > cut);
    const mine = (this.hits.get(client) ?? []).filter((t) => t > cut);
    this.hits.set(client, mine); this.hits.set("*", all);
    if (this.live(client, now).length >= this.maxOpenPerClient) return "This client already has unpaid orders waiting. Pay or let them expire before creating another.";
    if (this.live("*", now).length >= this.maxOpenGlobal) return "Too many unpaid orders are open through this connector right now. Try again later, or run the connector locally (npx plumbline-mcp).";
    if (mine.length >= this.perClientPerHour || all.length >= this.globalPerHour) return "Too many new orders from this client in the last hour. Finish or reuse an existing order, or try later.";
    mine.push(now); all.push(now);
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (k !== "*" && !v.some((t) => t > cut)) this.hits.delete(k);
    return null;
  }
  take(client: string, now = Date.now()): boolean { return this.check(client, now) === null; }
  /** Record an order's payment-window end so it counts as an open hold until then. */
  hold(client: string, expiresMs: number, now = Date.now()) {
    const e = Number.isFinite(expiresMs) && expiresMs > now ? Math.min(expiresMs, now + 3 * 3_600_000) : now + 1_800_000;
    this.live(client, now).push(e); this.live("*", now).push(e);
    if (this.open.size > 10_000) for (const [k, v] of this.open) if (k !== "*" && !v.some((x) => x > now)) this.open.delete(k);
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

/** S5: store caps group IPv6 by /48 (one site or subscriber often holds a whole /48); IPv4 and other ids unchanged.
 *  Takes the free-tier id (`ip:<v4>` or `ip:xxxx:xxxx:xxxx:xxxx::/64`). */
export function storeBucket(clientId: string): string {
  const m = /^ip:([0-9a-f]{4}:[0-9a-f]{4}:[0-9a-f]{4}):[0-9a-f]{4}::\/64$/.exec(clientId);
  return m ? `ip:${m[1]}::/48` : clientId;
}
/** Hashed client id forwarded to the store (never the raw IP). */
export const forwardedClient = (bucket: string) => createHash("sha256").update(`plumbline:store-client:${bucket}`).digest("hex").slice(0, 24);
/** S5: the store key (shared secret) the store verifies before trusting x-connector-client. Unset = no forwarding. */
export function connectorKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = (env.PLUMBLINE_STORE_CONNECTOR_KEY ?? "").trim();
  return k.length >= 32 ? k : null;
}

type Reg = (name: string, config: any, handler: (...a: any[]) => Promise<any>) => unknown;
type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<any>;
export interface StoreToolOpts { clientId?: string; origin?: string; fetchImpl?: F; lim?: OrderLimiter; pinnedPayee?: string | null; connectorKey?: string | null }

export function registerStoreTools(reg: Reg, wrap: Wrap, opts: StoreToolOpts = {}) {
  const origin = opts.origin ?? storeOrigin();
  const f = opts.fetchImpl ?? fetch;
  const lim = opts.lim ?? limiter;
  const client = storeBucket(opts.clientId ?? "anonymous");
  const ckey = opts.connectorKey === undefined ? connectorKey() : opts.connectorKey;
  const fwd: Record<string, string> = ckey ? { "x-connector-key": ckey, "x-connector-client": forwardedClient(client) } : {};
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
    const why = lim.check(client);
    if (why) throw new UserInputError(why);
    const r = await call(f, `${origin}/api/store/order`, { method: "POST", headers: { "content-type": "application/json", ...fwd }, body: JSON.stringify({ sku, ...(email ? { email } : {}) }) });
    if (!r.ok || !r.json?.order) throw new UserInputError(`Store refused the order (${r.status}): ${r.json?.reason ?? "unknown"}`);
    const o = r.json.order;
    lim.hold(client, Date.parse(o.expiresAt));
    const pc = checkPayee(o.payTo, await signedPayee(f, origin), opts.pinnedPayee === undefined ? PINNED_PAYEE : opts.pinnedPayee);
    if (!pc.ok) throw new UserInputError(`REFUSED: ${pc.reason}. Do not pay this order; tell your owner.`);
    return { payeeVerified: pc.verified, payeeNote: pc.verified ? "payTo matches the signed payee pin." : "The payee is not yet published in the signed versions.json. Show the FULL payTo address to your owner and get an explicit yes before paying.",
      orderId: o.orderId, token: o.token, payTo: o.payTo, coinType: o.coinType, amount: o.amount, amountAtomic: o.amountAtomic, expiresAt: o.expiresAt, howToPay: o.howToPay,
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
