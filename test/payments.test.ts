/**
 * Sui USDC pay-per-call tests.
 *  - Config, quota and the full 402 -> pay -> serve flow use a MOCK transaction fetcher (offline).
 *  - One test verifies a REAL Sui testnet USDC transfer, found live via GraphQL (read-only), to check parsing against chain data.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DailyQuota,
  SUI_USDC,
  createPaymentRuntime,
  graphqlTxFetcher,
  loadPaymentConfig,
  normalizeCoinType,
  type SuiTxView,
} from "../src/payments.ts";
import { createServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const PAYTO = "0x" + "ab".repeat(32); // dummy test address, not a real wallet
const OTHER = "0x" + "cd".repeat(32);
const base = { PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: PAYTO };
const D = (n: number) => "Dig" + String(n).padStart(40, "1"); // base58-shaped fake digests

test("payments are OFF by default", () => {
  assert.equal(loadPaymentConfig({}), null);
  assert.equal(loadPaymentConfig({ PAYTO_ADDRESS: PAYTO }), null);
});

test("config validation: receive-only address, testnet default, mainnet double opt-in", () => {
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1" }), /PAYTO_ADDRESS is not set/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "0xPAYTO_SUI_ADDRESS_PLACEHOLDER" }), /not set/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "suiprivkey1qexample" }), /private key/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "word ".repeat(12) }), /private key or mnemonic/);
  assert.throws(() => loadPaymentConfig({ PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: "0x1234" }), /not a valid/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_SUI_NETWORK: "mainnet" }), /second opt-in/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_SUI_NETWORK: "mainnet", PLUMBLINE_PAYMENTS_ALLOW_MAINNET: "1", PLUMBLINE_TEST_ASSET: "0x2::sui::SUI" }), /only allowed on testnet/);
  assert.throws(() => loadPaymentConfig({ ...base, PLUMBLINE_MIN_PAYMENT_USDC: "0.001" }), />= PLUMBLINE_PRICE_USDC/);
  const c = loadPaymentConfig(base)!;
  assert.equal(c.network, "sui:testnet");
  assert.equal(c.asset, normalizeCoinType(SUI_USDC.testnet));
  assert.equal(c.priceAtomic, 2000n);
  assert.equal(c.minPaymentAtomic, 10000n);
  assert.equal(c.freeCallsPerDay, 100);
  const m = loadPaymentConfig({ ...base, PLUMBLINE_SUI_NETWORK: "mainnet", PLUMBLINE_PAYMENTS_ALLOW_MAINNET: "1" })!;
  assert.equal(m.asset, normalizeCoinType(SUI_USDC.mainnet));
});

test("daily quota per client", () => {
  const q = new DailyQuota(2);
  assert.ok(q.tryConsume("a") && q.tryConsume("a"));
  assert.equal(q.tryConsume("a"), false);
  assert.equal(q.tryConsume("b"), true);
});

function mockChain() {
  const txs = new Map<string, SuiTxView>();
  const usdc = SUI_USDC.testnet;
  const add = (digest: string, o: Partial<SuiTxView> & { to?: string; amount?: string; coin?: string } = {}) =>
    txs.set(digest, {
      digest,
      sender: OTHER,
      status: o.status ?? "SUCCESS",
      timestampMs: o.timestampMs ?? Date.now() - 5_000,
      balanceChanges: [
        { owner: o.to ?? PAYTO, coinType: o.coin ?? usdc, amount: o.amount ?? "10000" },
        { owner: OTHER, coinType: o.coin ?? usdc, amount: "-" + (o.amount ?? "10000") },
      ],
    });
  return { add, fetch: async (d: string) => txs.get(d) ?? null };
}

async function connect(env: Record<string, string>, chain: ReturnType<typeof mockChain>, clientId = "client-1") {
  const payments = createPaymentRuntime(loadPaymentConfig({ ...base, ...env })!, chain.fetch);
  const server = createServer({ config: loadConfig(), payments, clientId });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (args: Record<string, unknown> = {}, name = "get_mid_price") =>
    client.callTool({ name, arguments: name === "get_indexer_status" ? args : { pool: "SUI_USDC", ...args } }) as Promise<any>;
  return { client, call, payments };
}

test("MOCK-VERIFIED flow: free tier -> 402 -> pay USDC -> serve -> credits -> replay rejected", async () => {
  const chain = mockChain();
  chain.add(D(1), { amount: "10000" }); // $0.01 = 5 calls at $0.002
  const { client, call, payments } = await connect({ PLUMBLINE_FREE_CALLS_PER_DAY: "1" }, chain);

  const { tools } = await client.listTools();
  const mid = tools.find((t) => t.name === "get_mid_price")!;
  assert.match(mid.description!, /Free: 1 calls\/day.*0\.002 USDC per call on Sui testnet/);
  assert.ok((mid.inputSchema as any).properties.payment_tx, "payment_tx arg exposed when payments are on");
  assert.ok(!(tools.find((t) => t.name === "get_indexer_status")!.inputSchema as any).properties?.payment_tx);

  assert.equal((await call()).isError, undefined, "call 1 is free");
  const pr = await call();
  assert.equal(pr.isError, true);
  const req = pr.structuredContent;
  assert.equal(req.x402Version, 2);
  assert.equal(req.accepts[0].scheme, "sui-digest");
  assert.equal(req.accepts[0].network, "sui:testnet");
  assert.equal(req.accepts[0].asset, normalizeCoinType(SUI_USDC.testnet));
  assert.equal(req.accepts[0].amount, "10000");
  assert.equal(req.accepts[0].payTo, PAYTO);

  const paid = await call({ payment_tx: D(1) });
  assert.equal(paid.isError, undefined, JSON.stringify(paid).slice(0, 300));
  assert.equal(paid._meta["x402/payment-response"].transaction, D(1));
  assert.equal(paid._meta["x402/payment-response"].creditsRemaining, 4);
  for (let i = 0; i < 4; i++) assert.equal((await call()).isError, undefined, `credit call ${i + 1}`);
  assert.equal(payments.creditsFor("client-1"), 0);
  const again = await call({ payment_tx: D(1) });
  assert.equal(again.structuredContent.error, "digest_already_used");
  const health = await call({}, "get_indexer_status");
  assert.equal(health.isError, undefined, "health stays free");
  await client.close();
});

test("MOCK-VERIFIED rejections: wrong recipient, wrong coin, too small, failed, stale, unknown, bad format, _meta path", async () => {
  const chain = mockChain();
  chain.add(D(2), { to: OTHER });
  chain.add(D(3), { coin: "0x2::sui::SUI" });
  chain.add(D(4), { amount: "9999" });
  chain.add(D(5), { status: "FAILURE" });
  chain.add(D(6), { timestampMs: Date.now() - 3_600_000 });
  chain.add(D(7), { amount: "20000" });
  const { client, call, payments } = await connect({ PLUMBLINE_FREE_CALLS_PER_DAY: "0" }, chain, "client-2");
  const err = async (args: any) => (await call(args)).structuredContent?.error as string;
  assert.equal(await err({ payment_tx: D(2) }), "no_payment_to_payTo_in_required_asset");
  assert.equal(await err({ payment_tx: D(3) }), "no_payment_to_payTo_in_required_asset");
  assert.match(await err({ payment_tx: D(4) }), /insufficient_amount/);
  assert.match(await err({ payment_tx: D(5) }), /transaction_failed/);
  assert.match(await err({ payment_tx: D(6) }), /payment_too_old/);
  assert.match(await err({ payment_tx: D(9) }), /transaction_not_found/);
  assert.equal((await call({ payment_tx: "not-a-digest-0000000000000000000000000" })).isError, true);
  // x402 _meta path, and the surplus becomes credits: $0.02 = 10 calls, 1 used now
  const viaMeta = (await client.callTool({ name: "get_mid_price", arguments: { pool: "SUI_USDC" }, _meta: { "x402/payment": { digest: D(7) } } } as any)) as any;
  assert.equal(viaMeta.isError, undefined);
  assert.equal(payments.creditsFor("client-2"), 9);
  await client.close();
});

test("LIVE read-only: verifier parses a real Sui testnet USDC transfer from GraphQL", async (t) => {
  const url = "https://graphql.testnet.sui.io/graphql";
  const q = `{ objects(last:20, filter:{type:"0x2::coin::Coin<${SUI_USDC.testnet}>"}){ nodes{ previousTransaction{ digest effects{ status balanceChanges{ nodes{ owner{address} amount coinType{repr} } } } } } } }`;
  let found: { digest: string; to: string; amount: bigint } | undefined;
  try {
    const j: any = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) })).json();
    for (const n of j.data?.objects?.nodes ?? []) {
      const tx = n.previousTransaction;
      if (tx?.effects?.status !== "SUCCESS") continue;
      const credit = tx.effects.balanceChanges.nodes.find(
        (b: any) => normalizeCoinType(b.coinType.repr) === normalizeCoinType(SUI_USDC.testnet) && BigInt(b.amount) > 0n && b.owner?.address,
      );
      if (credit) {
        found = { digest: tx.digest, to: credit.owner.address, amount: BigInt(credit.amount) };
        break;
      }
    }
  } catch (e) {
    t.skip(`testnet GraphQL unavailable: ${(e as Error).message}`);
    return;
  }
  if (!found) return t.skip("no recent testnet USDC transfer found");
  const cfgEnv = { PLUMBLINE_PAYMENTS: "1", PAYTO_ADDRESS: found.to, PLUMBLINE_PRICE_USDC: "0.000001", PLUMBLINE_MIN_PAYMENT_USDC: "0.000001" };
  // Relaxed freshness only for this parsing test (the real transfer may be old); default window must reject it.
  const relaxed = createPaymentRuntime({ ...loadPaymentConfig(cfgEnv)!, maxAgeSec: 10 * 365 * 86400 }, graphqlTxFetcher(url));
  const r = await relaxed.verifier.verifyAndRedeem(found.digest);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.ok(r.paidAtomic >= found.amount);
  assert.equal(((await relaxed.verifier.verifyAndRedeem(found.digest)) as any).reason, "digest_already_used");
  const strict = createPaymentRuntime(loadPaymentConfig(cfgEnv)!, graphqlTxFetcher(url));
  const s = await strict.verifier.verifyAndRedeem(found.digest);
  if (!s.ok) assert.match(s.reason, /payment_too_old/);
});
