/**
 * OPTIONAL pay-per-call in USDC on Sui, using an x402-style 402 flow. It is OFF by default, so
 * Plumbline stays free unless PLUMBLINE_PAYMENTS=1.
 *
 * Mechanism ("sui-digest" scheme; receive-only, the server has no keys):
 *   1. Each client gets N free calls per UTC day.
 *   2. After that, a tool call returns an x402-style PaymentRequired (x402Version 2) with
 *      network sui:<net>, the USDC coin type, payTo and the minimum amount.
 *   3. The client sends USDC on Sui to PAYTO_ADDRESS from its own wallet, then retries the call with
 *      the transaction digest, either as the `payment_tx` argument or as _meta["x402/payment"].
 *   4. The server checks the digest read-only through Sui GraphQL: success status, USDC coin type,
 *      net credit to payTo of at least the minimum, a fresh timestamp, and that the digest is unused.
 *      Any surplus over one call becomes call credits for that client.
 *
 * Why not the spec's `exact` scheme on Sui: no official x402 SDK package or official facilitator
 * supports Sui yet, and the spec's flow needs a facilitator to submit (and usually sponsor) the payer's
 * transaction. This flow needs no facilitator and no server keys.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const SUI_USDC: Record<SuiNet, string> = {
  // Source: https://developers.circle.com/stablecoins/usdc-contract-addresses
  mainnet: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  testnet: "0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC",
};
const GRAPHQL: Record<SuiNet, string> = {
  mainnet: "https://graphql.mainnet.sui.io/graphql",
  testnet: "https://graphql.testnet.sui.io/graphql",
};
export const PAYTO_PLACEHOLDER = "0xPAYTO_SUI_ADDRESS_PLACEHOLDER";
export const SCHEME = "sui-digest";
const USDC_DECIMALS = 6;

export type SuiNet = "testnet" | "mainnet";

export interface PaymentConfig {
  net: SuiNet;
  network: `sui:${SuiNet}`;
  payTo: string; // normalized 0x + 64 hex
  asset: string; // coin type
  assetDecimals: number;
  priceAtomic: bigint; // per call
  minPaymentAtomic: bigint; // per payment (>= price)
  freeCallsPerDay: number;
  maxAgeSec: number;
  graphqlUrl: string;
  trustProxy: boolean;
  redeemedFile?: string;
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

function usdToAtomic(v: string, decimals: number, label: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`${label} must be a decimal number like 0.002`);
  const [i, f = ""] = v.split(".");
  if (f.length > decimals) throw new Error(`${label} has more than ${decimals} decimals`);
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

/** Returns null when payments are disabled (the default). Throws a clear error on unsafe or invalid config. */
export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig | null {
  if (!truthy(env.PLUMBLINE_PAYMENTS) && !truthy(env.PLUMBLINE_X402)) return null;

  const raw = (env.PAYTO_ADDRESS ?? "").trim();
  if (!raw || raw === PAYTO_PLACEHOLDER) {
    throw new Error("Payments are on but PAYTO_ADDRESS is not set. Set it to the owner's RECEIVE-ONLY Sui address (0x + 64 hex).");
  }
  if (/^suiprivkey/i.test(raw) || /\s/.test(raw) || raw.split(/\s+/).length > 1) {
    throw new Error("PAYTO_ADDRESS looks like a private key or mnemonic. Never give keys to this server; use a receive address.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw) || /^0x0+$/.test(raw)) {
    throw new Error(`PAYTO_ADDRESS "${raw}" is not a valid non-zero Sui address (0x + 64 hex).`);
  }

  const net = (env.PLUMBLINE_SUI_NETWORK ?? "testnet").trim() as SuiNet;
  if (net !== "testnet" && net !== "mainnet") throw new Error("PLUMBLINE_SUI_NETWORK must be testnet (default) or mainnet.");
  if (net === "mainnet" && !truthy(env.PLUMBLINE_PAYMENTS_ALLOW_MAINNET)) {
    throw new Error("Sui mainnet payments need an explicit second opt-in: PLUMBLINE_PAYMENTS_ALLOW_MAINNET=1 (owner approval required).");
  }

  // Test-only asset override (e.g. 0x2::sui::SUI when testnet USDC is unavailable). Refused on mainnet.
  let asset = SUI_USDC[net];
  let assetDecimals = USDC_DECIMALS;
  if (env.PLUMBLINE_TEST_ASSET) {
    if (net !== "testnet") throw new Error("PLUMBLINE_TEST_ASSET is only allowed on testnet.");
    asset = env.PLUMBLINE_TEST_ASSET.trim();
    assetDecimals = Number(env.PLUMBLINE_TEST_ASSET_DECIMALS ?? 9);
  }

  const priceAtomic = usdToAtomic((env.PLUMBLINE_PRICE_USDC ?? "0.002").trim(), assetDecimals, "PLUMBLINE_PRICE_USDC");
  const minPaymentAtomic = usdToAtomic((env.PLUMBLINE_MIN_PAYMENT_USDC ?? "0.01").trim(), assetDecimals, "PLUMBLINE_MIN_PAYMENT_USDC");
  if (priceAtomic <= 0n || priceAtomic > 10n ** BigInt(assetDecimals)) throw new Error("PLUMBLINE_PRICE_USDC must be > 0 and <= 1.");
  if (minPaymentAtomic < priceAtomic) throw new Error("PLUMBLINE_MIN_PAYMENT_USDC must be >= PLUMBLINE_PRICE_USDC.");

  const free = Number(env.PLUMBLINE_FREE_CALLS_PER_DAY ?? 100);
  if (!Number.isInteger(free) || free < 0 || free > 1_000_000) throw new Error("PLUMBLINE_FREE_CALLS_PER_DAY must be an integer 0..1000000.");
  const maxAgeSec = Number(env.PLUMBLINE_PAYMENT_MAX_AGE_SEC ?? 900);
  if (!Number.isInteger(maxAgeSec) || maxAgeSec < 30) throw new Error("PLUMBLINE_PAYMENT_MAX_AGE_SEC must be an integer >= 30.");

  return {
    net,
    network: `sui:${net}`,
    payTo: normalizeAddress(raw),
    asset: normalizeCoinType(asset),
    assetDecimals,
    priceAtomic,
    minPaymentAtomic,
    freeCallsPerDay: free,
    maxAgeSec,
    graphqlUrl: env.PLUMBLINE_SUI_GRAPHQL_URL ?? GRAPHQL[net],
    trustProxy: truthy(env.PLUMBLINE_TRUST_PROXY),
    redeemedFile: env.PLUMBLINE_REDEEMED_FILE || undefined,
    timeoutMs: 8000,
  };
}

/** Per-client daily free quota, in memory, in UTC-day buckets. Client ids are stored hashed. */
export class DailyQuota {
  private day = "";
  private used = new Map<string, number>();
  constructor(private readonly limit: number, private readonly maxClients = 100_000) {}
  private roll() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used.clear();
    }
  }
  tryConsume(clientId: string): boolean {
    this.roll();
    const key = hashClient(clientId);
    const n = this.used.get(key) ?? 0;
    if (n >= this.limit) return false;
    if (!this.used.has(key) && this.used.size >= this.maxClients) return false;
    this.used.set(key, n + 1);
    return true;
  }
  remaining(clientId: string): number {
    this.roll();
    return Math.max(0, this.limit - (this.used.get(hashClient(clientId)) ?? 0));
  }
}

export function hashClient(id: string): string {
  return createHash("sha256").update(`plumbline:${id}`).digest("hex").slice(0, 24);
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

export function graphqlTxFetcher(url: string, timeoutMs = 8000): TxFetcher {
  return async (digest) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query:
            "query($d:String!){ transaction(digest:$d){ digest sender{address} effects{ status timestamp balanceChanges(first:50){ nodes{ owner{address} amount coinType{repr} } } } } }",
          variables: { d: digest },
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Sui GraphQL HTTP ${res.status}`);
      const j: any = await res.json();
      if (j.errors?.length) throw new Error(`Sui GraphQL error: ${j.errors[0].message}`);
      const tx = j.data?.transaction;
      if (!tx?.effects) return null;
      return {
        digest: tx.digest,
        sender: tx.sender?.address,
        status: tx.effects.status,
        timestampMs: Date.parse(tx.effects.timestamp),
        balanceChanges: (tx.effects.balanceChanges?.nodes ?? []).map((n: any) => ({
          owner: n.owner?.address,
          coinType: n.coinType?.repr,
          amount: n.amount,
        })),
      };
    } finally {
      clearTimeout(t);
    }
  };
}

const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, 32 bytes

export type VerifyResult = { ok: true; paidAtomic: bigint; sender?: string } | { ok: false; reason: string; retryable?: boolean };

/** Read-only payment verifier with single-use digests. */
export class SuiPaymentVerifier {
  private redeemed = new Map<string, number>(); // digest -> redeemed-at ms
  private pending = new Set<string>();
  constructor(private readonly cfg: PaymentConfig, private readonly fetchTx: TxFetcher) {
    if (cfg.redeemedFile && existsSync(cfg.redeemedFile)) {
      try {
        for (const [d, t] of Object.entries(JSON.parse(readFileSync(cfg.redeemedFile, "utf8")) as Record<string, number>)) this.redeemed.set(d, t);
      } catch {
        /* ignore a corrupt file; the freshness window still bounds replay */
      }
    }
  }

  private persist() {
    const cutoff = Date.now() - this.cfg.maxAgeSec * 2000;
    for (const [d, t] of this.redeemed) if (t < cutoff) this.redeemed.delete(d); // older digests fail the freshness check anyway
    if (this.cfg.redeemedFile) writeFileSync(this.cfg.redeemedFile, JSON.stringify(Object.fromEntries(this.redeemed)), { mode: 0o600 });
  }

  async verifyAndRedeem(digest: string): Promise<VerifyResult> {
    if (!DIGEST_RE.test(digest)) return { ok: false, reason: "invalid_digest_format" };
    if (this.redeemed.has(digest) || this.pending.has(digest)) return { ok: false, reason: "digest_already_used" };
    this.pending.add(digest);
    try {
      let tx: SuiTxView | null;
      try {
        tx = await this.fetchTx(digest);
      } catch (e) {
        return { ok: false, reason: `verification_unavailable: ${(e as Error).message}`, retryable: true };
      }
      if (!tx) return { ok: false, reason: "transaction_not_found (not indexed yet or wrong network; retry in a few seconds)", retryable: true };
      if (tx.status !== "SUCCESS") return { ok: false, reason: `transaction_failed (${tx.status})` };
      const ageSec = (Date.now() - tx.timestampMs) / 1000;
      if (!Number.isFinite(ageSec) || ageSec > this.cfg.maxAgeSec) return { ok: false, reason: `payment_too_old (> ${this.cfg.maxAgeSec}s)` };
      if (ageSec < -120) return { ok: false, reason: "payment_timestamp_in_future" };
      let credited = 0n;
      for (const bc of tx.balanceChanges) {
        if (!bc.owner || !bc.coinType) continue;
        if (normalizeAddress(bc.owner) === this.cfg.payTo && normalizeCoinType(bc.coinType) === this.cfg.asset) credited += BigInt(bc.amount);
      }
      if (credited <= 0n) return { ok: false, reason: "no_payment_to_payTo_in_required_asset" };
      if (credited < this.cfg.minPaymentAtomic) return { ok: false, reason: `insufficient_amount (${credited} < ${this.cfg.minPaymentAtomic} atomic)` };
      this.redeemed.set(digest, Date.now());
      this.persist();
      return { ok: true, paidAtomic: credited, sender: tx.sender };
    } finally {
      this.pending.delete(digest);
    }
  }
}

type Handler = (args: any, extra?: any) => Promise<CallToolResult>;

export function extractDigest(args: any, extra: any): string | undefined {
  const fromArg = typeof args?.payment_tx === "string" ? args.payment_tx.trim() : undefined;
  if (fromArg) return fromArg;
  const m = extra?._meta?.["x402/payment"];
  if (typeof m === "string") return m.trim();
  const d = m?.payload?.digest ?? m?.digest;
  return typeof d === "string" ? d.trim() : undefined;
}

/** Live payment runtime: free quota, paid credits, verifier. Created once at startup. */
export class PaymentRuntime {
  private credits = new Map<string, number>(); // hashed client -> prepaid calls
  readonly quota: DailyQuota;
  constructor(readonly cfg: PaymentConfig, readonly verifier: SuiPaymentVerifier) {
    this.quota = new DailyQuota(cfg.freeCallsPerDay);
  }

  private fmt(atomic: bigint): string {
    const s = atomic.toString().padStart(this.cfg.assetDecimals + 1, "0");
    const i = s.slice(0, -this.cfg.assetDecimals);
    const f = s.slice(-this.cfg.assetDecimals).replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  }
  get callsPerPayment(): number {
    return Number(this.cfg.minPaymentAtomic / this.cfg.priceAtomic);
  }

  describe(): string {
    return (
      `Free: ${this.cfg.freeCallsPerDay} calls/day per client, then ${this.fmt(this.cfg.priceAtomic)} USDC per call on Sui ${this.cfg.net} ` +
      `(pay >= ${this.fmt(this.cfg.minPaymentAtomic)} USDC to payTo, pass the tx digest as payment_tx; surplus becomes credits).`
    );
  }

  paymentRequired(toolName: string, error = "payment_required"): CallToolResult {
    const pr = {
      x402Version: 2,
      error,
      resource: { url: `mcp://tool/${toolName}`, description: `Plumbline ${toolName} (read-only DeepBook market data)`, mimeType: "application/json" },
      accepts: [
        {
          scheme: SCHEME,
          network: this.cfg.network,
          asset: this.cfg.asset,
          amount: this.cfg.minPaymentAtomic.toString(),
          payTo: this.cfg.payTo,
          maxTimeoutSeconds: this.cfg.maxAgeSec,
          extra: {
            decimals: this.cfg.assetDecimals,
            pricePerCall: this.cfg.priceAtomic.toString(),
            callsPerMinPayment: this.callsPerPayment,
            howToPay:
              `Send >= ${this.fmt(this.cfg.minPaymentAtomic)} of ${this.cfg.asset} to ${this.cfg.payTo} on Sui ${this.cfg.net} in one transaction, ` +
              `then retry this exact tool call with argument payment_tx="<transaction digest>" (or _meta["x402/payment"]={"digest":"..."}). ` +
              `The digest must be under ${this.cfg.maxAgeSec}s old and works once; extra value becomes prepaid calls for this client.`,
          },
        },
      ],
    };
    return { content: [{ type: "text", text: JSON.stringify(pr) }], structuredContent: pr, isError: true };
  }

  /** Gate a tool: free quota, then prepaid credits, then verify a fresh payment digest, otherwise return 402. */
  gate(toolName: string, handler: Handler, clientId: string): Handler {
    const key = hashClient(clientId);
    return async (args, extra) => {
      const { payment_tx: _ignored, ...cleanArgs } = args ?? {};
      if (this.quota.tryConsume(clientId)) return handler(cleanArgs, extra);
      const bal = this.credits.get(key) ?? 0;
      if (bal > 0) {
        const res = await handler(cleanArgs, extra);
        if (!res.isError) this.credits.set(key, bal - 1); // failed calls do not use credits
        return res;
      }
      const digest = extractDigest(args, extra);
      if (!digest) return this.paymentRequired(toolName);
      const v = await this.verifier.verifyAndRedeem(digest);
      if (!v.ok) return this.paymentRequired(toolName, v.reason);
      const calls = Number(v.paidAtomic / this.cfg.priceAtomic);
      this.credits.set(key, (this.credits.get(key) ?? 0) + calls);
      const res = await handler(cleanArgs, extra);
      if (!res.isError) this.credits.set(key, (this.credits.get(key) ?? 1) - 1);
      const left = this.credits.get(key) ?? 0;
      return {
        ...res,
        _meta: { ...(res as any)._meta, "x402/payment-response": { success: true, network: this.cfg.network, transaction: digest, payer: v.sender, creditsRemaining: left } },
      };
    };
  }

  creditsFor(clientId: string): number {
    return this.credits.get(hashClient(clientId)) ?? 0;
  }
}

export function createPaymentRuntime(cfg: PaymentConfig, fetchTx?: TxFetcher): PaymentRuntime {
  return new PaymentRuntime(cfg, new SuiPaymentVerifier(cfg, fetchTx ?? graphqlTxFetcher(cfg.graphqlUrl, cfg.timeoutMs)));
}
