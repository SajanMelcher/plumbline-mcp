/**
 * OPTIONAL pay-per-call in USDC on Sui, using an x402-style 402 flow. It is OFF by default, so
 * Plumbline stays free unless PLUMBLINE_PAYMENTS=1. The server is receive-only and holds no keys.
 *
 * Scheme "sui-challenge" (v2):
 *   1. Each client gets N free calls per UTC day.
 *   2. After that, a paid tool call returns an x402-style PaymentRequired (x402Version 2) with a fresh
 *      challenge: a secret bearer `payment_token` and a UNIQUE exact amount, e.g. 0.010437 USDC.
 *      No other open challenge has that amount.
 *   3. The client sends EXACTLY that amount of Circle USDC on Sui to payTo, in one transaction, from any
 *      wallet (self-custody, zkLogin, multisig or an exchange withdrawal all work).
 *   4. The client retries with payment_token + payment_tx (the digest). The server reads the
 *      transaction through Sui GraphQL and checks: SUCCESS, the pinned coin type, net credit to payTo
 *      EQUAL to the challenge amount, a timestamp inside the challenge window, and that neither the
 *      digest nor the challenge was used before. The token then holds prepaid calls.
 *
 * Front-running: a transaction is public, but the token is not. Someone who copies a victim's digest
 * must present it with THEIR OWN challenge, whose amount differs, so it is rejected. Amounts are not
 * reissued until well after the challenge window ends, and the tx must be newer than the challenge.
 * This binds the payment to the challenge (and so to the client) without signatures or server keys.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const SUI_USDC: Record<SuiNet, string> = {
  // Circle native USDC. Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
  mainnet: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  testnet: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
};
const GRAPHQL: Record<SuiNet, string> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};
/** Genesis checkpoint digests (GraphQL `chainIdentifier`). Used to refuse a GraphQL endpoint on the wrong chain. */
export const CHAIN_ID: Record<SuiNet, string> = {
  mainnet: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  testnet: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD",
};
export const PAYTO_PLACEHOLDER = "0xPAYTO_SUI_ADDRESS_PLACEHOLDER";
export const SCHEME = "sui-challenge";
const USDC_DECIMALS = 6;
/** Mainnet floor for one payment (the Coinbase USDC-on-Sui deposit minimum is 0.01). */
export const MAINNET_MIN_PAYMENT_ATOMIC = 10_000n;

export type SuiNet = "testnet" | "mainnet";

export interface PaymentConfig {
  net: SuiNet;
  network: `sui:${SuiNet}`;
  payTo: string; // normalized 0x + 64 hex
  asset: string; // normalized coin type
  assetDecimals: number;
  priceAtomic: bigint; // per call
  minPaymentAtomic: bigint; // base amount of a challenge; the unique tag is added on top
  amountTagRange: number; // challenge amount = min + k, k in 1..range (atomic units)
  freeCallsPerDay: number;
  freeCallsGlobalPerDay: number; // 0 = unlimited
  challengeTtlSec: number; // the client must pay within this window
  skewSec: number; // tolerated difference between the chain clock and the server clock
  redeemGraceSec: number; // extra time after the window to submit the digest (indexing delay)
  maxOpenChallengesPerClient: number;
  maxConcurrentVerifications: number;
  creditTtlDays: number;
  graphqlUrl: string;
  trustProxy: boolean;
  clientIpHeader?: string;
  stateFile?: string;
  timeoutMs: number;
}

const truthy = (v?: string) => /^(1|true|yes|on)$/i.test(v ?? "");

/** "0x2::sui::SUI" -> "0x000…002::sui::SUI"; addresses lower-cased and padded to 64 hex. */
export function normalizeAddress(a: string): string {
  const h = a.trim().toLowerCase().replace(/^0x/, "");
  return "0x" + h.padStart(64, "0");
}
export function normalizeCoinType(t: string): string {
  const [addr, ...rest] = t.trim().split("::");
  return [normalizeAddress(addr!), ...rest].join("::");
}
/** For logs: 0x1234…abcd. Full addresses are never logged. */
export function maskAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : "0x…";
}

export function decimalToAtomic(v: string, decimals: number, label: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${label} must be a decimal number like 0.002`);
  const [i, f = ""] = v.split(".");
  if (f.length > decimals) throw new Error(`${label} has more than ${decimals} decimals`);
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}
export function atomicToDecimal(atomic: bigint, decimals: number): string {
  const s = atomic.toString().padStart(decimals + 1, "0");
  const f = s.slice(-decimals).replace(/0+$/, "");
  return f ? `${s.slice(0, -decimals)}.${f}` : s.slice(0, -decimals);
}

function intEnv(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  const n = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer ${min}..${max}.`);
  return n;
}

/** Returns null when payments are disabled (the default). Throws a clear error on unsafe or invalid config. */
export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig | null {
  if (!truthy(env.PLUMBLINE_PAYMENTS) && !truthy(env.PLUMBLINE_X402)) return null;

  const raw = (env.PAYTO_ADDRESS ?? "").trim();
  if (!raw || raw === PAYTO_PLACEHOLDER) {
    throw new Error("Payments are on but PAYTO_ADDRESS is not set. Set it to the owner's RECEIVE-ONLY Sui address (0x + 64 hex).");
  }
  if (/^suiprivkey/i.test(raw) || /\s/.test(raw)) {
    throw new Error("PAYTO_ADDRESS looks like a private key or mnemonic. Never give keys to this server; use a receive address.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw) || /^0x0+$/.test(raw)) {
    // Do not echo the value: a mistaken paste could be a secret.
    throw new Error("PAYTO_ADDRESS is not a valid non-zero Sui address (0x + 64 hex).");
  }

  const net = (env.PLUMBLINE_SUI_NETWORK ?? "testnet").trim() as SuiNet;
  if (net !== "testnet" && net !== "mainnet") throw new Error("PLUMBLINE_SUI_NETWORK must be testnet (default) or mainnet.");
  const mainnet = net === "mainnet";
  if (mainnet && !truthy(env.PLUMBLINE_PAYMENTS_ALLOW_MAINNET)) {
    throw new Error("Sui mainnet payments need an explicit second opt-in: PLUMBLINE_PAYMENTS_ALLOW_MAINNET=1 (owner approval required).");
  }

  // Coin type is pinned to Circle native USDC. The override exists only for testnet experiments.
  let asset = SUI_USDC[net];
  let assetDecimals = USDC_DECIMALS;
  if (env.PLUMBLINE_TEST_ASSET) {
    if (mainnet) throw new Error("PLUMBLINE_TEST_ASSET is only allowed on testnet (mainnet is pinned to Circle USDC).");
    asset = env.PLUMBLINE_TEST_ASSET.trim();
    if (!/^0x[0-9a-fA-F]{1,64}::\w+::\w+$/.test(asset)) throw new Error("PLUMBLINE_TEST_ASSET must look like 0x…::module::TYPE.");
    assetDecimals = intEnv(env, "PLUMBLINE_TEST_ASSET_DECIMALS", 9, 0, 18);
  }

  const priceAtomic = decimalToAtomic((env.PLUMBLINE_PRICE_USDC ?? "0.002").trim(), assetDecimals, "PLUMBLINE_PRICE_USDC");
  const minPaymentAtomic = decimalToAtomic((env.PLUMBLINE_MIN_PAYMENT_USDC ?? "0.01").trim(), assetDecimals, "PLUMBLINE_MIN_PAYMENT_USDC");
  if (priceAtomic <= 0n || priceAtomic > 10n ** BigInt(assetDecimals)) throw new Error("PLUMBLINE_PRICE_USDC must be > 0 and <= 1.");
  if (minPaymentAtomic < priceAtomic) throw new Error("PLUMBLINE_MIN_PAYMENT_USDC must be >= PLUMBLINE_PRICE_USDC.");
  if (mainnet && minPaymentAtomic < MAINNET_MIN_PAYMENT_ATOMIC) {
    throw new Error("PLUMBLINE_MIN_PAYMENT_USDC must be >= 0.01 on mainnet (exchange deposit minimum; smaller deposits may never be credited).");
  }
  if (minPaymentAtomic > 100n * 10n ** BigInt(assetDecimals)) throw new Error("PLUMBLINE_MIN_PAYMENT_USDC must be <= 100.");

  const amountTagRange = intEnv(env, "PLUMBLINE_AMOUNT_TAG_RANGE", 999, 10, 999_999);
  const challengeTtlSec = intEnv(env, "PLUMBLINE_PAYMENT_MAX_AGE_SEC", 900, 60, 3600);
  const skewSec = intEnv(env, "PLUMBLINE_CLOCK_SKEW_SEC", 60, 0, 300);

  const graphqlUrl = (env.PLUMBLINE_SUI_GRAPHQL_URL ?? GRAPHQL[net]).trim();
  if (!/^https:\/\//.test(graphqlUrl) && !(net === "testnet" && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(graphqlUrl))) {
    throw new Error("PLUMBLINE_SUI_GRAPHQL_URL must be https://");
  }

  const stateFile = (env.PLUMBLINE_STATE_FILE ?? env.PLUMBLINE_REDEEMED_FILE ?? "").trim() || undefined;
  if (mainnet && !stateFile) {
    throw new Error("Mainnet payments need PLUMBLINE_STATE_FILE (on a persistent disk) so used payments and prepaid calls survive restarts.");
  }

  const ipHeader = (env.PLUMBLINE_CLIENT_IP_HEADER ?? "").trim().toLowerCase() || undefined;
  if (ipHeader && !/^[a-z0-9-]{1,64}$/.test(ipHeader)) throw new Error("PLUMBLINE_CLIENT_IP_HEADER must be a header name like fly-client-ip.");

  return {
    net,
    network: `sui:${net}`,
    payTo: normalizeAddress(raw),
    asset: normalizeCoinType(asset),
    assetDecimals,
    priceAtomic,
    minPaymentAtomic,
    amountTagRange,
    freeCallsPerDay: intEnv(env, "PLUMBLINE_FREE_CALLS_PER_DAY", 100, 0, 1_000_000),
    freeCallsGlobalPerDay: intEnv(env, "PLUMBLINE_FREE_CALLS_GLOBAL_PER_DAY", 0, 0, 100_000_000),
    challengeTtlSec,
    skewSec,
    redeemGraceSec: intEnv(env, "PLUMBLINE_REDEEM_GRACE_SEC", 600, 0, 3600),
    maxOpenChallengesPerClient: intEnv(env, "PLUMBLINE_MAX_OPEN_CHALLENGES", 3, 1, 100),
    maxConcurrentVerifications: intEnv(env, "PLUMBLINE_MAX_CONCURRENT_VERIFICATIONS", 4, 1, 64),
    creditTtlDays: intEnv(env, "PLUMBLINE_CREDIT_TTL_DAYS", 90, 1, 3650),
    graphqlUrl,
    trustProxy: truthy(env.PLUMBLINE_TRUST_PROXY),
    clientIpHeader: ipHeader,
    stateFile,
    timeoutMs: 8000,
  };
}

export function sha(s: string, n = 32): string {
  return createHash("sha256").update(s).digest("hex").slice(0, n);
}
export function hashClient(id: string): string {
  return sha(`plumbline:client:${id}`, 24);
}
export const hashToken = (t: string) => sha(`plumbline:token:${t}`, 40);

/** Per-client daily free quota, in memory, in UTC-day buckets, with an optional global cap. Fails closed when full. */
export class DailyQuota {
  private day = "";
  private used = new Map<string, number>();
  private total = 0;
  constructor(private readonly limit: number, private readonly globalLimit = 0, private readonly maxClients = 100_000) {}
  private roll() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
      this.total = 0;
    }
  }
  tryConsume(clientId: string): boolean {
    this.roll();
    const key = hashClient(clientId);
    const n = this.used.get(key) ?? 0;
    if (n >= this.limit) return false;
    if (this.globalLimit > 0 && this.total >= this.globalLimit) return false;
    if (!this.used.has(key) && this.used.size >= this.maxClients) return false;
    this.used.set(key, n + 1);
    this.total++;
    return true;
  }
  remaining(clientId: string): number {
    this.roll();
    return Math.max(0, this.limit - (this.used.get(hashClient(clientId)) ?? 0));
  }
}

/** Minimal shape of a Sui transaction as returned by GraphQL. */
export interface SuiTxView {
  digest: string;
  sender?: string;
  status: string; // "SUCCESS" | "FAILURE"
  timestampMs: number;
  balanceChanges: { owner?: string; coinType: string; amount: string }[];
}
export type TxFetcher = (digest: string) => Promise<SuiTxView | null>;
export type ChainIdFetcher = () => Promise<string>;

async function gql(url: string, timeoutMs: number, query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Sui GraphQL HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 2_000_000) throw new Error("Sui GraphQL response too large");
    const j = JSON.parse(text);
    if (j.errors?.length) throw new Error(`Sui GraphQL error: ${String(j.errors[0].message).slice(0, 200)}`);
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

export function graphqlTxFetcher(url: string, timeoutMs = 8000): TxFetcher {
  return async (digest) => {
    const data = await gql(
      url,
      timeoutMs,
      "query($d:String!){ transaction(digest:$d){ digest sender{address} effects{ status timestamp balanceChanges(first:50){ nodes{ owner{address} amount coinType{repr} } } } } }",
      { d: digest },
    );
    const tx = data?.transaction;
    if (!tx?.effects) return null;
    return {
      digest: tx.digest,
      sender: tx.sender?.address,
      status: tx.effects.status,
      timestampMs: Date.parse(tx.effects.timestamp),
      balanceChanges: (tx.effects.balanceChanges?.nodes ?? []).map((n: any) => ({ owner: n.owner?.address, coinType: n.coinType?.repr, amount: n.amount })),
    };
  };
}
export function graphqlChainIdFetcher(url: string, timeoutMs = 8000): ChainIdFetcher {
  return async () => String((await gql(url, timeoutMs, "{ chainIdentifier }"))?.chainIdentifier ?? "");
}

const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, 32 bytes
const TOKEN_RE = /^plb_[A-Za-z0-9_-]{43}$/;

interface Challenge {
  amount: string; // atomic, exact
  clientKey: string; // hashed client id (for per-client caps only)
  createdMs: number;
  expiresMs: number; // pay before this
  reservedUntilMs: number; // the amount is not reissued before this
  attempts: number;
  lastAttemptMs: number;
  paidDigest?: string;
}
interface Credit {
  calls: number;
  expiresMs: number;
}
interface StateFileV2 {
  v: 2;
  net: SuiNet;
  payTo: string; // hashed, so the file shows which payee it belongs to without containing the address
  challenges: Record<string, Challenge>; // key: hashed token
  credits: Record<string, Credit>; // key: hashed token
  redeemed: Record<string, number>; // digest -> redeemed-at ms
}

/**
 * Payment state: open challenges, used digests and prepaid credits. Tokens are stored hashed, so a leaked
 * state file cannot be used to spend anyone's credits. Persisted with an atomic write (tmp + fsync + rename).
 */
export class PaymentStore {
  challenges = new Map<string, Challenge>();
  credits = new Map<string, Credit>();
  redeemed = new Map<string, number>();
  private usedAmounts = new Map<string, number>(); // amount -> reservedUntil

  constructor(private readonly cfg: PaymentConfig) {
    if (!cfg.stateFile || !existsSync(cfg.stateFile)) return;
    let s: StateFileV2;
    try {
      s = JSON.parse(readFileSync(cfg.stateFile, "utf8"));
    } catch {
      // Fail closed: silently starting empty would forget used payments and paid credits.
      throw new Error("PLUMBLINE_STATE_FILE exists but is not valid JSON. Fix or move it; refusing to start with lost payment state.");
    }
    if (s?.v !== 2) throw new Error("PLUMBLINE_STATE_FILE has an unknown format (expected v2). Move it aside to start fresh.");
    if (s.net !== cfg.net || s.payTo !== sha(cfg.payTo, 16)) {
      throw new Error("PLUMBLINE_STATE_FILE belongs to a different network or payTo. Use a separate state file per payee/network.");
    }
    for (const [k, c] of Object.entries(s.challenges ?? {})) this.challenges.set(k, c);
    for (const [k, c] of Object.entries(s.credits ?? {})) this.credits.set(k, c);
    for (const [d, t] of Object.entries(s.redeemed ?? {})) this.redeemed.set(d, t);
    for (const c of this.challenges.values()) this.usedAmounts.set(c.amount, Math.max(this.usedAmounts.get(c.amount) ?? 0, c.reservedUntilMs));
  }

  prune(now = Date.now()) {
    for (const [k, c] of this.challenges) if (c.reservedUntilMs < now && (c.paidDigest || c.expiresMs < now)) this.challenges.delete(k);
    for (const [a, t] of this.usedAmounts) if (t < now) this.usedAmounts.delete(a);
    for (const [k, c] of this.credits) if (c.expiresMs < now || c.calls <= 0) this.credits.delete(k);
    // A digest can only ever match a challenge inside its window, so it is safe to forget after the longest window.
    const keep = (this.cfg.challengeTtlSec + this.cfg.redeemGraceSec + this.cfg.skewSec) * 1000 * 4;
    for (const [d, t] of this.redeemed) if (t < now - keep) this.redeemed.delete(d);
  }

  amountTaken(amount: string, now = Date.now()): boolean {
    return (this.usedAmounts.get(amount) ?? 0) >= now;
  }
  reserveAmount(amount: string, until: number) {
    this.usedAmounts.set(amount, until);
  }
  get reservedCount(): number {
    return this.usedAmounts.size;
  }

  save() {
    this.prune();
    if (!this.cfg.stateFile) return;
    const s: StateFileV2 = {
      v: 2,
      net: this.cfg.net,
      payTo: sha(this.cfg.payTo, 16),
      challenges: Object.fromEntries(this.challenges),
      credits: Object.fromEntries(this.credits),
      redeemed: Object.fromEntries(this.redeemed),
    };
    const tmp = `${this.cfg.stateFile}.tmp-${process.pid}`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(s));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.cfg.stateFile);
  }
}

export type VerifyResult = { ok: true; calls: number; sender?: string; digest: string } | { ok: false; reason: string; retryable?: boolean };

type Handler = (args: any, extra?: any) => Promise<CallToolResult>;

export interface PaymentInput {
  token?: string;
  digest?: string;
}
export function extractPayment(args: any, extra: any): PaymentInput {
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const m = extra?._meta?.["x402/payment"];
  return {
    token: s(args?.payment_token) ?? s(m?.token) ?? s(m?.payload?.token),
    digest: s(args?.payment_tx) ?? (typeof m === "string" ? s(m) : undefined) ?? s(m?.digest) ?? s(m?.payload?.digest),
  };
}

/** Live payment runtime: free quota, challenges, verification and prepaid credits. Created once at startup. */
export class PaymentRuntime {
  readonly quota: DailyQuota;
  readonly store: PaymentStore;
  private inflightDigests = new Set<string>();
  private inflightTokens = new Set<string>();
  private activeVerifications = 0;
  private notFound = new Map<string, number>(); // digest -> retry-after ms (negative cache)
  private chainChecked: Promise<void> | null = null;
  now: () => number = Date.now;

  constructor(
    readonly cfg: PaymentConfig,
    private readonly fetchTx: TxFetcher,
    private readonly fetchChainId?: ChainIdFetcher,
  ) {
    this.quota = new DailyQuota(cfg.freeCallsPerDay, cfg.freeCallsGlobalPerDay);
    this.store = new PaymentStore(cfg);
  }

  private fmt(atomic: bigint): string {
    return atomicToDecimal(atomic, this.cfg.assetDecimals);
  }

  describe(): string {
    return (
      `Free: ${this.cfg.freeCallsPerDay} calls/day per client, then ${this.fmt(this.cfg.priceAtomic)} USDC per call on Sui ${this.cfg.net}, ` +
      `prepaid in batches of about ${this.fmt(this.cfg.minPaymentAtomic)} USDC (the payment-required response gives an exact amount and a payment_token).`
    );
  }

  /** Startup summary for logs. Masks payTo and never includes tokens. */
  logLine(): string {
    return `Payments ENABLED (${this.cfg.network}, scheme ${SCHEME}, payTo ${maskAddress(this.cfg.payTo)}, state ${this.cfg.stateFile ? "persistent" : "in-memory"}): ${this.describe()}`;
  }

  private issueChallenge(clientKey: string): { token: string; amount: bigint; expiresMs: number } | null {
    const now = this.now();
    this.store.prune(now);
    let open = 0;
    for (const c of this.store.challenges.values()) if (c.clientKey === clientKey && !c.paidDigest && c.expiresMs > now) open++;
    if (open >= this.cfg.maxOpenChallengesPerClient) return null;
    if (this.store.reservedCount >= this.cfg.amountTagRange) return null;
    let tag = 0;
    for (let i = 0; i < 64 && !tag; i++) {
      const k = randomInt(1, this.cfg.amountTagRange + 1);
      if (!this.store.amountTaken((this.cfg.minPaymentAtomic + BigInt(k)).toString(), now)) tag = k;
    }
    if (!tag) {
      for (let k = 1; k <= this.cfg.amountTagRange && !tag; k++) if (!this.store.amountTaken((this.cfg.minPaymentAtomic + BigInt(k)).toString(), now)) tag = k;
    }
    if (!tag) return null;
    const amount = this.cfg.minPaymentAtomic + BigInt(tag);
    const token = "plb_" + randomBytes(32).toString("base64url");
    const ttl = this.cfg.challengeTtlSec * 1000;
    const expiresMs = now + ttl;
    // The amount stays reserved well past the window so a late payment can never match a newer challenge.
    const reservedUntilMs = expiresMs + (this.cfg.redeemGraceSec + 2 * this.cfg.skewSec) * 1000 + ttl;
    this.store.challenges.set(hashToken(token), { amount: amount.toString(), clientKey, createdMs: now, expiresMs, reservedUntilMs, attempts: 0, lastAttemptMs: 0 });
    this.store.reserveAmount(amount.toString(), reservedUntilMs);
    this.store.save();
    return { token, amount, expiresMs };
  }

  private result(obj: Record<string, unknown>): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(obj) }], structuredContent: obj, isError: true };
  }

  /** x402-style PaymentRequired with a fresh challenge (or the caller's still-open one). */
  paymentRequired(toolName: string, clientKey: string, error = "payment_required", existing?: { token: string; c: Challenge }): CallToolResult {
    let ch: { token: string; amount: bigint; expiresMs: number } | null = existing
      ? { token: existing.token, amount: BigInt(existing.c.amount), expiresMs: existing.c.expiresMs }
      : this.issueChallenge(clientKey);
    if (!ch) {
      return this.result({
        x402Version: 2,
        error: "payment_busy: too many open payment challenges; pay or let an open challenge expire (15 min) and retry",
        accepts: [],
      });
    }
    const amount = this.fmt(ch.amount);
    const pr = {
      x402Version: 2,
      error,
      resource: { url: `mcp://tool/${toolName}`, description: `The Spice Melange Trading Desk ${toolName} (read-only DeepBook market data)`, mimeType: "application/json" },
      accepts: [
        {
          scheme: SCHEME,
          network: this.cfg.network,
          asset: this.cfg.asset,
          amount: ch.amount.toString(),
          payTo: this.cfg.payTo,
          maxTimeoutSeconds: Math.max(0, Math.floor((ch.expiresMs - this.now()) / 1000)),
          extra: {
            decimals: this.cfg.assetDecimals,
            amountDecimal: amount,
            exactAmount: true,
            paymentToken: ch.token,
            expiresAt: new Date(ch.expiresMs).toISOString(),
            pricePerCall: this.cfg.priceAtomic.toString(),
            callsForThisPayment: Number(ch.amount / this.cfg.priceAtomic),
            howToPay:
              `Send EXACTLY ${amount} USDC (${ch.amount} atomic units of ${this.cfg.asset}) to ${this.cfg.payTo} on Sui ${this.cfg.net} in one transaction ` +
              `before ${new Date(ch.expiresMs).toISOString()}. Then retry this tool call with payment_token="${ch.token}" and payment_tx="<transaction digest>". ` +
              `Any other amount will not match. Keep payment_token private: it holds your prepaid calls; pass it (without payment_tx) on later calls.`,
          },
        },
      ],
    };
    return this.result(pr);
  }

  private async ensureChain(): Promise<void> {
    if (!this.fetchChainId) return;
    this.chainChecked ??= this.fetchChainId().then(
      (id) => {
        if (id !== CHAIN_ID[this.cfg.net]) throw new Error(`GraphQL endpoint is not Sui ${this.cfg.net}`);
      },
      (e) => {
        this.chainChecked = null; // network error: check again next time
        throw e;
      },
    );
    return this.chainChecked;
  }

  /** Verify a digest against one challenge. Read-only; the server holds no keys. */
  async verify(token: string, digest: string): Promise<VerifyResult> {
    if (!TOKEN_RE.test(token)) return { ok: false, reason: "invalid_payment_token" };
    if (!DIGEST_RE.test(digest)) return { ok: false, reason: "invalid_digest_format" };
    const key = hashToken(token);
    const c = this.store.challenges.get(key);
    const now = this.now();
    if (!c) return { ok: false, reason: "unknown_or_expired_payment_token" };
    if (c.paidDigest) return { ok: false, reason: "payment_token_already_paid" };
    if (now > c.expiresMs + this.cfg.redeemGraceSec * 1000) return { ok: false, reason: "payment_window_closed" };
    if (this.store.redeemed.has(digest)) return { ok: false, reason: "digest_already_used" };
    if (this.inflightDigests.has(digest) || this.inflightTokens.has(key)) return { ok: false, reason: "verification_in_progress", retryable: true };
    if (now - c.lastAttemptMs < 2000) return { ok: false, reason: "too_many_attempts: wait 2s", retryable: true };
    if (c.attempts >= 20) return { ok: false, reason: "too_many_attempts_for_this_token" };
    const nf = this.notFound.get(digest);
    if (nf && nf > now) return { ok: false, reason: "transaction_not_found (retry in a few seconds)", retryable: true };
    if (this.activeVerifications >= this.cfg.maxConcurrentVerifications) return { ok: false, reason: "verifier_busy (retry shortly)", retryable: true };

    c.attempts++;
    c.lastAttemptMs = now;
    this.inflightDigests.add(digest);
    this.inflightTokens.add(key);
    this.activeVerifications++;
    try {
      let tx: SuiTxView | null;
      try {
        await this.ensureChain();
        tx = await this.fetchTx(digest);
      } catch (e) {
        return { ok: false, reason: `verification_unavailable: ${(e as Error).message.slice(0, 200)}`, retryable: true };
      }
      if (!tx) {
        if (this.notFound.size > 10_000) this.notFound.clear();
        this.notFound.set(digest, now + 3000);
        return { ok: false, reason: "transaction_not_found (not indexed yet or wrong network; retry in a few seconds)", retryable: true };
      }
      if (tx.digest && tx.digest !== digest) return { ok: false, reason: "digest_mismatch" };
      if (tx.status !== "SUCCESS") return { ok: false, reason: `transaction_failed (${String(tx.status).slice(0, 20)})` };
      const skew = this.cfg.skewSec * 1000;
      if (!Number.isFinite(tx.timestampMs)) return { ok: false, reason: "transaction_timestamp_missing" };
      if (tx.timestampMs < c.createdMs - skew) return { ok: false, reason: "payment_predates_challenge (pay after receiving the payment_token)" };
      if (tx.timestampMs > c.expiresMs + skew) return { ok: false, reason: "payment_after_challenge_expiry" };
      if (tx.timestampMs > now + skew) return { ok: false, reason: "payment_timestamp_in_future (clock skew)" };
      let credited = 0n;
      for (const bc of tx.balanceChanges) {
        if (!bc.owner || !bc.coinType || !/^-?\d{1,40}$/.test(String(bc.amount))) continue;
        if (normalizeAddress(bc.owner) === this.cfg.payTo && normalizeCoinType(bc.coinType) === this.cfg.asset) credited += BigInt(bc.amount);
      }
      if (credited <= 0n) return { ok: false, reason: "no_payment_to_payTo_in_required_asset" };
      if (credited !== BigInt(c.amount)) {
        return { ok: false, reason: `amount_mismatch (received ${this.fmt(credited)}, this payment_token needs exactly ${this.fmt(BigInt(c.amount))} USDC)` };
      }
      // Re-check after the await: another request may have used this digest or token meanwhile.
      if (this.store.redeemed.has(digest) || c.paidDigest) return { ok: false, reason: "digest_already_used" };
      const calls = Number(credited / this.cfg.priceAtomic);
      c.paidDigest = digest;
      this.store.redeemed.set(digest, now);
      const prev = this.store.credits.get(key)?.calls ?? 0;
      this.store.credits.set(key, { calls: prev + calls, expiresMs: now + this.cfg.creditTtlDays * 86_400_000 });
      this.store.save();
      return { ok: true, calls, sender: tx.sender, digest };
    } finally {
      this.activeVerifications--;
      this.inflightDigests.delete(digest);
      this.inflightTokens.delete(key);
    }
  }

  creditsForToken(token: string): number {
    return TOKEN_RE.test(token) ? (this.store.credits.get(hashToken(token))?.calls ?? 0) : 0;
  }

  private async spend(token: string, run: () => Promise<CallToolResult>): Promise<CallToolResult | null> {
    const key = hashToken(token);
    const cr = this.store.credits.get(key);
    if (!cr || cr.calls <= 0 || cr.expiresMs < this.now()) return null;
    cr.calls--; // reserve first so concurrent calls cannot overspend
    const res = await run();
    if (res.isError) cr.calls++; // failed calls are refunded
    this.store.save();
    return { ...res, _meta: { ...(res as any)._meta, "x402/payment-response": { success: true, network: this.cfg.network, creditsRemaining: cr.calls } } };
  }

  /** Gate a tool: free quota, then prepaid credits (by token), then verify a payment, otherwise return 402. */
  gate(toolName: string, handler: Handler, clientId: string): Handler {
    const clientKey = hashClient(clientId);
    return async (args, extra) => {
      const { payment_tx: _d, payment_token: _t, ...cleanArgs } = args ?? {};
      const run = () => handler(cleanArgs, extra);
      const p = extractPayment(args, extra);

      const c = p.token && TOKEN_RE.test(p.token) ? this.store.challenges.get(hashToken(p.token)) : undefined;
      if (!(p.token && p.digest)) {
        if (p.token && TOKEN_RE.test(p.token)) {
          const spent = await this.spend(p.token, run);
          if (spent) return spent;
        }
        if (this.quota.tryConsume(clientId)) return run();
        if (!p.token) return this.paymentRequired(toolName, clientKey);
        if (!TOKEN_RE.test(p.token)) return this.paymentRequired(toolName, clientKey, "invalid_payment_token");
        if (c && !c.paidDigest && c.expiresMs > this.now()) {
          return this.paymentRequired(toolName, clientKey, "payment_required: pay this token's exact amount, then send payment_tx", { token: p.token, c });
        }
        return this.paymentRequired(toolName, clientKey, c?.paidDigest ? "no_credits_left" : "payment_required");
      }
      const v = await this.verify(p.token, p.digest);
      if (!v.ok) {
        // Keep the caller on the same challenge while it can still be paid, so their exact amount stays valid.
        const keep = c && !c.paidDigest && this.now() <= c.expiresMs + this.cfg.redeemGraceSec * 1000 ? { token: p.token, c } : undefined;
        return this.paymentRequired(toolName, clientKey, v.reason, keep);
      }
      const spent = await this.spend(p.token, run);
      if (!spent) return this.paymentRequired(toolName, clientKey, "no_credits_left");
      return { ...spent, _meta: { ...(spent as any)._meta, "x402/payment-response": { ...(spent as any)._meta["x402/payment-response"], transaction: v.digest, payer: v.sender } } };
    };
  }
}

export function createPaymentRuntime(cfg: PaymentConfig, fetchTx?: TxFetcher, fetchChainId?: ChainIdFetcher | null): PaymentRuntime {
  return new PaymentRuntime(
    cfg,
    fetchTx ?? graphqlTxFetcher(cfg.graphqlUrl, cfg.timeoutMs),
    fetchChainId === null ? undefined : (fetchChainId ?? graphqlChainIdFetcher(cfg.graphqlUrl, cfg.timeoutMs)),
  );
}
