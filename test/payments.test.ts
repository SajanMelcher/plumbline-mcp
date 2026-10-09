/**
 * Sui USDC pay-per-call tests ("sui-challenge" scheme).
 *  - Config, quota, challenges, front-running, persistence and DoS limits use a MOCK transaction fetcher (offline).
 *  - One test verifies a REAL Sui testnet USDC transfer, found live via GraphQL (read-only), to check parsing against chain data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CHAIN_ID,
  DailyQuota,
  SUI_USDC,
  createPaymentRuntime,
  graphqlChainIdFetcher,
  graphqlTxFetcher,
  hashToken,
  loadPaymentConfig,
  maskAddress,
  normalizeCoinType,
  type SuiTxView,
} from "../src/payments.ts";
import { RateLimiter, clientIdFor, ipBucket } from "../src/clientid.ts";
import { createServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const PAYTO = "0x" + "ab".repeat(32); // dummy test address, not a real wallet
const OTHER = "0x" + "cd".repeat(32);
const base = { PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: PAYTO };
const mainnetBase = { ...base, PLUMBLINE_SUI_NETWORK: "mainnet", PLUMBLINE_PAYMENTS_ALLOW_MAINNET: "1" };
const D = (n: number) => "Dig" + String(n).replace(/0/g, "o").padStart(40, "1"); // base58-shaped fake digests
const tmpState = () => join(mkdtempSync(join(tmpdir(), "plumbline-test-")), "state.json");

test("payments are OFF by default", () => {
  assert.equal(loadPaymentConfig({}), null);
  assert.equal(loadPaymentConfig({ PAYTO_ADDRESS: PAYTO }), null);
});

test("config validation: receive-only address, testnet default, mainnet opt-in, pinning, state file, minimums", () => {
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1" }), /PAYTO_ADDRESS is not set/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "0xPAYTO_SUI_ADDRESS_PLACEHOLDER" }), /not set/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "suiprivkey1qexample" }), /private key/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "word ".repeat(12) }), /private key or mnemonic/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "0x1234" }), (e: Error) => /not a valid/.test(e.message) && !e.message.includes("0x1234"));
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_SUI_NETWORK: "mainnet" }), /second opt-in/);
  assert.throws(() => loadPaymentConfig({ ...mainnetBase, PLUMBLINE_STATE_FILE: "/tmp/x", PLUMBLINE_TEST_ASSET: "0x2::sui::SUI" }), /only allowed on testnet/);
  assert.throws(() => loadPaymentConfig(mainnetBase), /PLUMBLINE_STATE_FILE/);
  assert.throws(() => loadPaymentConfig({ ...mainnetBase, PLUMBLINE_STATE_FILE: "/tmp/x", PLUMBLINE_PRICE_USDC: "0.001", PLUMBLINE_MIN_PAYMENT_USDC: "0.005" }), />= 0.01 on mainnet/);
  assert.throws(() => loadPaymentConfig({ ...mainnetBase, PLUMBLINE_STATE_FILE: "/tmp/x", PLUMBLINE_SUI_GRAPHQL_URL: "http://evil.example/graphql" }), /https/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_MIN_PAYMENT_USDC: "0.001" }), />= PLUMBLINE_PRICE_USDC/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_PRICE_USDC: "0.0000001" }), /more than 6 decimals/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_PRICE_USDC: "1e-3" }), /decimal number/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_CLOCK_SKEW_SEC: "9999" }), /PLUMBLINE_CLOCK_SKEW_SEC/);
  const c = loadPaymentConfig(base)!;
  assert.equal(c.network, "sui:testnet");
  assert.equal(c.asset, normalizeCoinType(SUI_USDC.testnet));
  assert.equal(c.priceAtomic, 2000n);
  assert.equal(c.minPaymentAtomic, 10000n);
  assert.equal(c.freeCallsPerDay, 100);
  const m = loadPaymentConfig({ ...mainnetBase, PLUMBLINE_STATE_FILE: "/tmp/x" })!;
  assert.equal(m.asset, normalizeCoinType(SUI_USDC.mainnet));
  assert.equal(m.asset, "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
});

test("daily quota per client, with an optional global cap", () => {
  const q = new DailyQuota(2);
  assert.ok(q.tryConsume("a") && q.tryConsume("a"));
  assert.equal(q.tryConsume("a"), false);
  assert.equal(q.tryConsume("b"), true);
  const g = new DailyQuota(5, 3);
  assert.ok(g.tryConsume("a") && g.tryConsume("b") && g.tryConsume("c"));
  assert.equal(g.tryConsume("d"), false);
});

function mockChain() {
  const txs = new Map<string, SuiTxView>();
  let fetches = 0;
  const usdc = SUI_USDC.testnet;
  const add = (digest: string, o: Partial<SuiTxView> & { to?: string; amount?: string | bigint; coin?: string } = {}) => {
    const amt = String(o.amount ?? "10000");
    txs.set(digest, {
      digest,
      sender: OTHER,
      status: o.status ?? "SUCCESS",
      timestampMs: o.timestampMs ?? Date.now(),
      balanceChanges: [
        { owner: o.to ?? PAYTO, coinType: o.coin ?? usdc, amount: amt },
        { owner: OTHER, coinType: o.coin ?? usdc, amount: "-" + amt },
      ],
    });
  };
  return {
    add,
    fetch: async (d: string) => {
      fetches++;
      return txs.get(d) ?? null;
    },
    get fetches() {
      return fetches;
    },
  };
}

async function connect(env: Record<string, string>, chain: ReturnType<typeof mockChain>, clientId = "client-1", payments = createPaymentRuntime(loadPaymentConfig({ ...base, ...env })!, chain.fetch, null)) {
  const server = createServer({ config: loadConfig(), payments, clientId });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (args: Record<string, unknown> = {}, name = "get_mid_price") =>
    client.callTool({ name, arguments: name === "get_indexer_status" ? args : { pool: "SUI_USDC", ...args } }) as Promise<any>;
  const challenge = async () => {
    const r = await call();
    assert.equal(r.isError, true, "expected payment required");
    const acc = r.structuredContent.accepts[0];
    return { token: acc.extra.paymentToken as string, amount: BigInt(acc.amount), acc, r };
  };
  return { client, call, payments, challenge };
}

test("MOCK-VERIFIED flow: free tier -> 402 challenge -> pay exact amount -> serve -> credits by token -> replay rejected", async () => {
  const chain = mockChain();
  const { client, call, payments, challenge } = await connect({ PLUMBLINE_FREE_CALLS_PER_DAY: "1" }, chain);

  const { tools } = await client.listTools();
  const mid = tools.find((t) => t.name === "get_mid_price")!;
  assert.match(mid.description!, /Free: 1 calls\/day.*0\.002 USDC per call on Sui testnet/);
  assert.ok((mid.inputSchema as any).properties.payment_tx && (mid.inputSchema as any).properties.payment_token);
  assert.ok(!(tools.find((t) => t.name === "get_indexer_status")!.inputSchema as any).properties?.payment_tx);

  assert.equal((await call()).isError, undefined, "call 1 is free");
  const { token, amount, acc, r } = await challenge();
  assert.equal(r.structuredContent.x402Version, 2);
  assert.equal(acc.scheme, "sui-challenge");
  assert.equal(acc.network, "sui:testnet");
  assert.equal(acc.asset, normalizeCoinType(SUI_USDC.testnet));
  assert.equal(acc.payTo, PAYTO);
  assert.ok(amount > 10000n && amount <= 10999n, `unique amount in range, got ${amount}`);
  assert.equal(acc.extra.exactAmount, true);
  assert.match(token, /^plb_[A-Za-z0-9_-]{43}$/);

  // Asking again with the token (no digest) returns the SAME challenge.
  const same = await call({ payment_token: token });
  assert.equal(same.structuredContent.accepts[0].amount, amount.toString());

  chain.add(D(1), { amount });
  const paid = await call({ payment_token: token, payment_tx: D(1) });
  assert.equal(paid.isError, undefined, JSON.stringify(paid).slice(0, 300));
  assert.equal(paid._meta["x402/payment-response"].transaction, D(1));
  assert.equal(paid._meta["x402/payment-response"].creditsRemaining, 4); // 0.0100xx / 0.002 = 5 calls, 1 used
  for (let i = 0; i < 4; i++) assert.equal((await call({ payment_token: token })).isError, undefined, `credit call ${i + 1}`);
  assert.equal(payments.creditsForToken(token), 0);
  assert.equal((await call({ payment_token: token })).structuredContent.error, "no_credits_left");

  // Replay: the same digest with the same token or with a new token is refused.
  assert.equal((await call({ payment_token: token, payment_tx: D(1) })).structuredContent.error, "payment_token_already_paid");
  const fresh = await challenge();
  assert.equal((await call({ payment_token: fresh.token, payment_tx: D(1) })).structuredContent.error, "digest_already_used");
  assert.equal((await call({}, "get_indexer_status")).isError, undefined, "health stays free");
  await client.close();
});

test("FRONT-RUNNING: a copied digest cannot be redeemed by someone else", async () => {
  const chain = mockChain();
  const payments = createPaymentRuntime(loadPaymentConfig({ ...base, PLUMBLINE_FREE_CALLS_PER_DAY: "0" })!, chain.fetch, null);
  const victim = await connect({}, chain, "victim", payments);
  const attacker = await connect({}, chain, "attacker", payments);
  const v = await victim.challenge();
  const a = await attacker.challenge();
  assert.notEqual(v.amount, a.amount, "open challenges never share an amount");
  chain.add(D(10), { amount: v.amount }); // victim pays; the digest is now public on-chain

  // Attacker races with the victim's digest: with their own token -> amount mismatch; with no token -> just a 402.
  assert.match((await attacker.call({ payment_token: a.token, payment_tx: D(10) })).structuredContent.error, /amount_mismatch/);
  const noTok = await attacker.call({ payment_tx: D(10) });
  assert.equal(noTok.structuredContent.error, "payment_required");
  assert.equal(payments.creditsForToken(a.token), 0);
  // A guessed/forged token is rejected without touching the chain.
  const before = chain.fetches;
  assert.match((await attacker.call({ payment_token: "plb_" + "A".repeat(43), payment_tx: D(10) })).structuredContent.error, /unknown_or_expired_payment_token/);
  assert.equal(chain.fetches, before);

  await new Promise((r) => setTimeout(r, 0));
  const ok = await victim.call({ payment_token: v.token, payment_tx: D(10) });
  assert.equal(ok.isError, undefined, JSON.stringify(ok.structuredContent));
  assert.equal(payments.creditsForToken(v.token), 4);
  await victim.client.close();
  await attacker.client.close();
});

test("MOCK-VERIFIED rejections: recipient, coin, wrong amount, failed, predates, late, future, unknown, format, _meta path", async () => {
  const chain = mockChain();
  const { client, call, payments, challenge } = await connect({ PLUMBLINE_FREE_CALLS_PER_DAY: "0", PLUMBLINE_MAX_OPEN_CHALLENGES: "20" }, chain, "client-2");
  const { token, amount } = await challenge();
  const err = async (digest: string, tok = token) => {
    const r = await call({ payment_token: tok, payment_tx: digest });
    payments.store.challenges.get(hashToken(tok))!.lastAttemptMs = 0; // skip the 2s per-token pacing in tests
    return r.structuredContent?.error as string;
  };
  chain.add(D(2), { to: OTHER, amount });
  chain.add(D(3), { coin: "0x2::sui::SUI", amount });
  chain.add(D(4), { amount: amount - 1n });
  chain.add(D(5), { amount: amount + 1n }); // overpaying also fails: exact match is what binds the payment
  chain.add(D(6), { status: "FAILURE", amount });
  chain.add(D(7), { amount, timestampMs: Date.now() - 3_600_000 });
  chain.add(D(8), { amount, timestampMs: Date.now() + 3_600_000 });
  assert.equal(await err(D(2)), "no_payment_to_payTo_in_required_asset");
  assert.equal(await err(D(3)), "no_payment_to_payTo_in_required_asset");
  assert.match(await err(D(4)), /amount_mismatch/);
  assert.match(await err(D(5)), /amount_mismatch/);
  assert.match(await err(D(6)), /transaction_failed/);
  assert.match(await err(D(7)), /payment_predates_challenge/);
  assert.match(await err(D(8)), /payment_after_challenge_expiry|in_future/);
  assert.match(await err(D(9)), /transaction_not_found/);
  assert.equal(await err("not-a-digest-0000000000000000000000000"), "invalid_digest_format");
  // The failed attempts kept the same challenge, so the exact amount is still valid. Pay via the x402 _meta path.
  chain.add(D(11), { amount });
  const viaMeta = (await client.callTool({ name: "get_mid_price", arguments: { pool: "SUI_USDC" }, _meta: { "x402/payment": { token, digest: D(11) } } } as any)) as any;
  assert.equal(viaMeta.isError, undefined, JSON.stringify(viaMeta.structuredContent));
  assert.equal(payments.creditsForToken(token), 4);

  // Late payment: after the challenge window (+ skew) it is refused even if the amount matches.
  const late = await challenge();
  const c = payments.store.challenges.get(hashToken(late.token))!;
  c.expiresMs = Date.now() - 120_000; // window ended 2 minutes ago; still inside the redeem grace
  chain.add(D(12), { amount: late.amount, timestampMs: Date.now() - 1_000 });
  assert.match(await err(D(12), late.token), /payment_after_challenge_expiry/);
  await client.close();
});

test("challenge amounts are unique; per-client cap and range exhaustion return payment_busy", async () => {
  const chain = mockChain();
  const payments = createPaymentRuntime(loadPaymentConfig({ ...base, PLUMBLINE_FREE_CALLS_PER_DAY: "0", PLUMBLINE_AMOUNT_TAG_RANGE: "12", PLUMBLINE_MAX_OPEN_CHALLENGES: "3" })!, chain.fetch, null);
  const seen = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const { call } = await connect({}, chain, `c${i}`, payments);
    for (let j = 0; j < 3; j++) seen.add((await call()).structuredContent.accepts[0].amount);
    if (i === 0) assert.match((await call()).structuredContent.error, /payment_busy/, "4th open challenge for one client is refused");
  }
  assert.equal(seen.size, 12, "12 distinct amounts for 12 challenges");
  const { call } = await connect({}, chain, "c-extra", payments);
  assert.match((await call()).structuredContent.error, /payment_busy/, "range exhausted");
});

test("PERSISTENCE: used digests, challenges and credits survive a restart; file holds no tokens or payTo", async () => {
  const stateFile = tmpState();
  const chain = mockChain();
  const env = { ...base, PLUMBLINE_FREE_CALLS_PER_DAY: "0", PLUMBLINE_STATE_FILE: stateFile };
  const first = await connect({}, chain, "p", createPaymentRuntime(loadPaymentConfig(env)!, chain.fetch, null));
  const { token, amount } = await first.challenge();
  const pending = await first.challenge(); // still open at "restart"
  chain.add(D(20), { amount });
  assert.equal((await first.call({ payment_token: token, payment_tx: D(20) })).isError, undefined);
  await first.client.close();

  const raw = readFileSync(stateFile, "utf8");
  assert.ok(!raw.includes(token) && !raw.includes(pending.token), "tokens are stored hashed");
  assert.ok(!raw.includes(PAYTO.slice(2)), "payTo is not stored in clear");
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);

  const second = await connect({}, chain, "p", createPaymentRuntime(loadPaymentConfig(env)!, chain.fetch, null));
  assert.equal(second.payments.creditsForToken(token), 4, "credits restored");
  assert.equal((await second.call({ payment_token: token })).isError, undefined, "credits usable after restart");
  const again = await second.challenge();
  assert.notEqual(again.amount, pending.amount, "reserved amounts restored");
  assert.equal((await second.call({ payment_token: again.token, payment_tx: D(20) })).structuredContent.error, "digest_already_used");
  await second.client.close();

  assert.throws(() => createPaymentRuntime(loadPaymentConfig({ ...env, PAYTO_ADDRESS: OTHER })!, chain.fetch, null), /different network or payTo/);
  writeFileSync(stateFile, "{corrupt");
  assert.throws(() => createPaymentRuntime(loadPaymentConfig(env)!, chain.fetch, null), /not valid JSON/);
});

test("CONCURRENCY + DoS: one digest pays once, credits never overspend, verifier cap, negative cache, chain check", async () => {
  const chain = mockChain();
  const cfg = loadPaymentConfig({ ...base, PLUMBLINE_FREE_CALLS_PER_DAY: "0", PLUMBLINE_MAX_CONCURRENT_VERIFICATIONS: "1" })!;
  const slow = async (d: string) => {
    await new Promise((r) => setTimeout(r, 30));
    return chain.fetch(d);
  };
  const p = createPaymentRuntime(cfg, slow, null);
  const s = await connect({}, chain, "k", p);
  const { token, amount } = await s.challenge();
  chain.add(D(30), { amount });
  const results = await Promise.all([1, 2, 3].map(() => s.call({ payment_token: token, payment_tx: D(30) })));
  assert.equal(results.filter((r) => r.isError === undefined).length, 1, "exactly one redemption");
  assert.ok(results.some((r) => /verification_in_progress|verifier_busy/.test(r.structuredContent?.error ?? "")));
  assert.equal(p.creditsForToken(token), 4);
  const spends = await Promise.all([1, 2, 3, 4, 5, 6].map(() => s.call({ payment_token: token })));
  assert.equal(spends.filter((r) => r.isError === undefined).length, 4, "4 credits -> 4 served, never more");
  assert.equal(p.creditsForToken(token), 0);

  // Negative cache: an unknown digest is fetched once, then answered from cache for a few seconds.
  const t2 = await s.challenge();
  const n0 = chain.fetches;
  await s.call({ payment_token: t2.token, payment_tx: D(31) });
  p.store.challenges.get(hashToken(t2.token))!.lastAttemptMs = 0;
  const cached = await s.call({ payment_token: t2.token, payment_tx: D(31) });
  assert.match(cached.structuredContent.error, /transaction_not_found/);
  assert.equal(chain.fetches - n0, 1);
  // Per-token pacing: immediate retries do not hit the chain.
  assert.match((await s.call({ payment_token: t2.token, payment_tx: D(32) })).structuredContent.error, /too_many_attempts|transaction_not_found/);
  await s.client.close();

  // Wrong chain behind the GraphQL URL: refuse to verify.
  const wrong = createPaymentRuntime(cfg, chain.fetch, async () => CHAIN_ID.mainnet);
  const w = await connect({}, chain, "w", wrong);
  const wc = await w.challenge();
  chain.add(D(33), { amount: wc.amount });
  assert.match((await w.call({ payment_token: wc.token, payment_tx: D(33) })).structuredContent.error, /not Sui testnet/);
  await w.client.close();
});

test("free-tier identity: spoofed headers ignored unless a trusted proxy is configured; IPv6 /64 buckets", () => {
  const req = (headers: Record<string, string>, ip = "203.0.113.9") => ({ headers, socket: { remoteAddress: ip } }) as any;
  assert.equal(clientIdFor(req({ "x-forwarded-for": "1.1.1.1" }), { trustProxy: false }), "ip:203.0.113.9");
  assert.equal(clientIdFor(req({ "x-forwarded-for": "1.1.1.1, 198.51.100.7" }), { trustProxy: true }), "ip:198.51.100.7", "rightmost (proxy-appended) entry");
  assert.equal(clientIdFor(req({ "fly-client-ip": "198.51.100.8", "x-forwarded-for": "1.1.1.1" }), { trustProxy: true, clientIpHeader: "fly-client-ip" }), "ip:198.51.100.8");
  assert.equal(clientIdFor(req({ "fly-client-ip": "not-an-ip" }), { trustProxy: false, clientIpHeader: "fly-client-ip" }), "ip:203.0.113.9");
  assert.equal(ipBucket("2001:db8:1:2:aaaa::1"), "2001:0db8:0001:0002::/64");
  assert.equal(ipBucket("2001:db8:1:2:bbbb:cccc:dddd:eeee"), ipBucket("2001:db8:1:2::9"));
  assert.equal(ipBucket("::ffff:192.0.2.1"), "192.0.2.1");
  const rl = new RateLimiter(2);
  assert.ok(rl.allow("a", 0) && rl.allow("a", 1));
  assert.equal(rl.allow("a", 2), false);
  assert.ok(rl.allow("b", 3) && rl.allow("a", 60_000));
});

test("logs never contain the full payTo or tokens", () => {
  const p = createPaymentRuntime(loadPaymentConfig(base)!, async () => null, null);
  const line = p.logLine();
  assert.ok(!line.includes(PAYTO) && line.includes(maskAddress(PAYTO)));
  assert.ok(!/plb_/.test(line));
});

test("LIVE read-only: chain id check and parsing of a real Sui testnet USDC transfer from GraphQL", async (t) => {
  const url = "https://graphql.testnet.sui.io/graphql";
  const q = `{ objects(last:20, filter:{type:"0x2::coin::Coin<${SUI_USDC.testnet}>"}){ nodes{ previousTransaction{ digest effects{ status timestamp balanceChanges{ nodes{ owner{address} amount coinType{repr} } } } } } } }`;
  let found: { digest: string; to: string; amount: bigint; ts: number } | undefined;
  try {
    assert.equal(await graphqlChainIdFetcher(url)(), CHAIN_ID.testnet);
    const j: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) })).json();
    for (const n of j.data?.objects?.nodes ?? []) {
      const tx = n.previousTransaction;
      if (tx?.effects?.status !== "SUCCESS") continue;
      const credit = tx.effects.balanceChanges.nodes.find(
        (b: any) => normalizeCoinType(b.coinType.repr) === normalizeCoinType(SUI_USDC.testnet) && BigInt(b.amount) > 0n && b.owner?.address,
      );
      if (credit) {
        found = { digest: tx.digest, to: credit.owner.address, amount: BigInt(credit.amount), ts: Date.parse(tx.effects.timestamp) };
        break;
      }
    }
  } catch (e) {
    t.skip(`testnet GraphQL unavailable: ${(e as Error).message}`);
    return;
  }
  if (!found) return t.skip("no recent testnet USDC transfer found");
  const cfg = loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: found.to, PLUMBLINE_PRICE_USDC: "0.000001", PLUMBLINE_MIN_PAYMENT_USDC: "0.000001" })!;
  const p = createPaymentRuntime(cfg, graphqlTxFetcher(url)); // real chain-id check too
  // Inject a challenge matching the real transfer (amount + window) to exercise the parser against chain data.
  const token = "plb_" + "L".repeat(43);
  // Net credit to `to` may include several balance changes; read it from the fetcher so the challenge matches.
  const view = (await graphqlTxFetcher(url)(found.digest))!;
  const net = view.balanceChanges.filter((b) => b.owner && b.owner.toLowerCase() === found!.to.toLowerCase() && normalizeCoinType(b.coinType) === normalizeCoinType(SUI_USDC.testnet)).reduce((s, b) => s + BigInt(b.amount), 0n);
  const now = Date.now();
  p.now = () => found!.ts + 1000;
  p.store.challenges.set(hashToken(token), { amount: net.toString(), clientKey: "x", createdMs: found.ts - 1000, expiresMs: found.ts + 60_000, reservedUntilMs: now + 1e9, attempts: 0, lastAttemptMs: 0 });
  const r = await p.verify(token, found.digest);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(((await p.verify(token, found.digest)) as any).reason, "payment_token_already_paid");
});
