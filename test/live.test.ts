/** Live tests against the public DeepBook indexer + Sui GraphQL (network required). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

async function connect() {
  const server = createServer({ config: loadConfig() });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const client = await connect();

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const text = r.content[0]!.text;
  return { isError: Boolean(r.isError), text, json: r.isError ? undefined : JSON.parse(text) };
}

test("exposes exactly the read-only tool set, all annotated readOnly", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "estimate_fees", "get_bm_fills", "get_indexer_status", "get_mid_price", "get_ohlcv", "get_order_book", "get_pool_params", "get_pool_stats",
    "get_recent_trades", "get_swing_range", "get_volume", "list_pools",
    "check_template_order", "create_template_order", "get_desk_rhythm", "list_templates",
  ].sort());
  const writes = ["check_template_order", "create_template_order"]; // store orders only: no keys, no funds, nothing destructive
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, !writes.includes(t.name), t.name);
    assert.equal(t.annotations?.destructiveHint ?? false, false, t.name);
    assert.match(t.description ?? "", /not financial advice/i, `${t.name} disclaimer`);
    assert.doesNotMatch(t.name, /order_create|swap|transfer|sign|wallet|withdraw|deposit/);
  }
});

test("toolkit tools answer from live public data", async () => {
  const s = (await call("get_swing_range", { pool: "SUI_USDC" })).json;
  assert.ok(["CALM", "ELEVATED", "HIGH_VOL"].includes(s.regime));
  const f = (await call("estimate_fees", { pool: "SUI_USDC", qty: 10, role: "taker" })).json;
  assert.ok(f.pay_in_input_token.fee_quote_equiv >= 0);
  const b = (await call("get_bm_fills", { pool: "SUI_USDC", balance_manager_id: "0xb7084d0abf33836f215841f58219934bf34ada8d3d9c384d2ee6192887f85471", hours: 72 })).json;
  assert.equal(b.role, "maker"); assert.ok(Array.isArray(b.rows));
});

test("list_pools includes SUI_USDC with sane params", async () => {
  const r = await call("list_pools", { asset: "usdc" });
  assert.equal(r.isError, false, r.text);
  const p = r.json.pools.find((x: any) => x.pool === "SUI_USDC");
  assert.ok(p, "SUI_USDC present");
  assert.equal(p.base, "SUI");
  assert.ok(p.tick > 0 && p.tick < 0.01, `tick ${p.tick}`);
  assert.ok(p.lot > 0 && p.min_size >= p.lot);
});

test("get_mid_price SUI_USDC: bid < mid < ask, tight spread", async () => {
  const r = await call("get_mid_price", { pool: "sui/usdc" });
  assert.equal(r.isError, false, r.text);
  const { best_bid, best_ask, mid, spread_bps } = r.json;
  assert.ok(best_bid > 0 && best_bid < best_ask, r.text);
  assert.ok(mid > best_bid && mid < best_ask);
  assert.ok(spread_bps > 0 && spread_bps < 500, `spread_bps ${spread_bps}`);
  assert.ok(Date.now() - Date.parse(r.json.as_of) < 15 * 60_000, "book is fresh (<15 min)");
});

test("get_order_book SUI_USDC: sorted levels and monotone depth bands", async () => {
  const r = await call("get_order_book", { pool: "SUI_USDC", levels: 5, within_pct: [2, 0.5, 1] });
  assert.equal(r.isError, false, r.text);
  const { bids, asks, depth_within_pct: d } = r.json;
  assert.ok(bids.length > 0 && bids.length <= 5 && asks.length > 0 && asks.length <= 5);
  for (let i = 1; i < bids.length; i++) assert.ok(bids[i][0] < bids[i - 1][0], "bids descending");
  for (let i = 1; i < asks.length; i++) assert.ok(asks[i][0] > asks[i - 1][0], "asks ascending");
  assert.deepEqual(d.map((x: any) => x.pct), [0.5, 1, 2]);
  for (let i = 1; i < d.length; i++) {
    assert.ok(d[i].bid_base >= d[i - 1].bid_base && d[i].ask_quote >= d[i - 1].ask_quote, "depth grows with band");
  }
  assert.ok(d[2].bid_quote > 0 && d[2].ask_quote > 0, "liquidity within 2%");
});

test("get_volume SUI_USDC 24h and custom window", async () => {
  const r = await call("get_volume", { pool: "SUI_USDC" });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.quote_volume > 0 && r.json.base_volume > 0);
  assert.ok(r.json.low_24h <= r.json.last_price && r.json.last_price <= r.json.high_24h);
  const w = await call("get_volume", { pool: "SUI_USDC", window_hours: 6 });
  assert.equal(w.isError, false, w.text);
  assert.equal(w.json.window, "6h");
  assert.ok(w.json.quote_volume >= 0);
  const top = await call("get_volume", { top: 3 });
  assert.equal(top.json.pools.length <= 3, true);
});

test("get_pool_params SUI_USDC: live on-chain fees", async () => {
  const r = await call("get_pool_params", { pool: "SUI_USDC" });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.source, "sui-onchain", r.text);
  assert.ok(r.json.taker_fee.bps >= 0 && r.json.taker_fee.bps <= 100, `taker ${r.json.taker_fee.bps}bps`);
  assert.ok(r.json.maker_fee.bps >= 0 && r.json.maker_fee.bps <= r.json.taker_fee.bps + 1e-9);
  assert.ok(r.json.stake_required_deep >= 0);
  assert.ok(r.json.tick > 0);
});

test("get_recent_trades SUI_USDC", async () => {
  const r = await call("get_recent_trades", { pool: "SUI_USDC", limit: 5 });
  assert.equal(r.isError, false, r.text);
  assert.ok(r.json.rows.length >= 1 && r.json.rows.length <= 5);
  const [time, side, price, base, quote] = r.json.rows[0];
  assert.ok(!Number.isNaN(Date.parse(time)));
  assert.ok(side === "buy" || side === "sell");
  assert.ok(price > 0 && base > 0 && Math.abs(quote / base - price) / price < 0.01, "quote ≈ base × price");
});

test("get_ohlcv SUI_USDC 1h: chronological, H>=O,C>=L", async () => {
  const r = await call("get_ohlcv", { pool: "SUI_USDC", interval: "1h", limit: 6 });
  assert.equal(r.isError, false, r.text);
  const c = r.json.candles;
  assert.ok(c.length >= 1 && c.length <= 6);
  for (let i = 1; i < c.length; i++) assert.ok(Date.parse(c[i][0]) > Date.parse(c[i - 1][0]), "ascending time");
  for (const [, o, h, l, cl, v] of c) {
    assert.ok(h >= Math.max(o, cl) - 1e-12 && l <= Math.min(o, cl) + 1e-12 && v >= 0);
  }
});

test("get_indexer_status", async () => {
  const r = await call("get_indexer_status");
  assert.equal(r.isError, false, r.text);
  assert.ok(["OK", "UNHEALTHY"].includes(r.json.status));
});

test("input validation and friendly errors", async () => {
  const rev = await call("get_mid_price", { pool: "USDC_SUI" });
  assert.equal(rev.isError, true);
  assert.match(rev.text, /Unknown pool/);
  const bad = await call("get_order_book", { pool: "SUI_USDC", levels: 500 });
  assert.equal(bad.isError, true);
  const junk = await call("get_mid_price", { pool: "sui usdc; drop" });
  assert.equal(junk.isError, true);
  const range = await call("get_recent_trades", { pool: "SUI_USDC", start_time: 1791529000, end_time: 1791520000 });
  assert.equal(range.isError, true);
  assert.match(range.text, /start_time must be before end_time/);
});

test("cache: repeated call is served from memory", async () => {
  await call("list_pools");
  const t0 = performance.now();
  await call("list_pools");
  assert.ok(performance.now() - t0 < 50, "second list_pools under 50 ms");
});
