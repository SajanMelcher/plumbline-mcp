import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { OrderLimiter, registerStoreTools, storeOrigin, verifyRhythm, STORE_ORIGIN } from "../src/store-tools.js";

function harness(fetchImpl: any, lim = new OrderLimiter(2, 5)) {
  const tools: Record<string, any> = {};
  const wrap = (fn: any) => async (a: any) => { try { return { ok: true, data: await fn(a) }; } catch (e) { return { ok: false, err: (e as Error).message }; } };
  registerStoreTools((n, c, h) => (tools[n] = { c, h }), wrap as any, { clientId: "c1", origin: STORE_ORIGIN, fetchImpl, lim });
  return tools;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("store origin is pinned: default, preview ok, anything else throws", () => {
  assert.equal(storeOrigin({}), STORE_ORIGIN);
  assert.equal(storeOrigin({ PLUMBLINE_STORE_URL: "https://abc123.spicemelange-site.pages.dev/x" }), "https://abc123.spicemelange-site.pages.dev");
  for (const bad of ["https://evil.example", "http://thespicemelange.org", "https://thespicemelange.org.evil.com", "https://x.spicemelange-site.pages.dev.evil.com"])
    assert.throws(() => storeOrigin({ PLUMBLINE_STORE_URL: bad }));
});

test("registers exactly the four store tools", () => {
  assert.deepEqual(Object.keys(harness(async () => json({}))).sort(), ["check_template_order", "create_template_order", "get_desk_rhythm", "list_templates"]);
});

test("create_template_order relays to the pinned store and is rate limited per client", async () => {
  const calls: string[] = [];
  const t = harness(async (u: string, init: any) => { calls.push(`${init.method} ${u}`); return json({ ok: true, order: { orderId: "SM-ABCDEFGHJK", token: "smt_" + "a".repeat(43), payTo: "0xpay", amount: "300.000123" } }, 201); });
  for (let i = 0; i < 2; i++) assert.equal((await t.create_template_order.h({ sku: "fish-speakers" })).ok, true);
  const third = await t.create_template_order.h({ sku: "fish-speakers" });
  assert.equal(third.ok, false); assert.match(third.err, /Too many/);
  assert.deepEqual(calls, [`POST ${STORE_ORIGIN}/api/store/order`, `POST ${STORE_ORIGIN}/api/store/order`]);
});

test("check_template_order: token goes in a header for status, body for verify; absolute links", async () => {
  const seen: any[] = [];
  const t = harness(async (u: string, init: any) => { seen.push({ u, h: init.headers, b: init.body }); return json({ ok: true, status: "paid", downloadUrl: "/api/store/download?x=1", addons: [{ sku: "desk-kit", name: "desk-kit", downloadUrl: "/api/store/download?y=2" }] }); });
  const tok = "smt_" + "b".repeat(43);
  const s = await t.check_template_order.h({ order_id: "SM-ABCDEFGHJK", token: tok });
  assert.equal(seen[0].u, `${STORE_ORIGIN}/api/store/status`); assert.equal(seen[0].h.authorization, `Bearer ${tok}`); assert.ok(!seen[0].b.includes(tok));
  assert.equal(s.data.downloadUrl, `${STORE_ORIGIN}/api/store/download?x=1`); assert.equal(s.data.addons[0].sku, "desk-kit");
  await t.check_template_order.h({ order_id: "SM-ABCDEFGHJK", token: tok, digest: "3".repeat(44) });
  assert.equal(seen[1].u, `${STORE_ORIGIN}/api/store/verify`);
});

test("rhythm: the published file verifies with the pinned key; a tampered one fails closed", async () => {
  const site = "/workspace/ixians/spicemelange-site/public";
  const body = readFileSync(`${site}/rhythm.json`), sig = readFileSync(`${site}/rhythm.json.sig`, "utf8");
  assert.equal(verifyRhythm(body, sig), true);
  const t = harness(async (u: string) => new Response(u.endsWith(".sig") ? sig : Buffer.concat([body, Buffer.from(" ")])));
  const r = await t.get_desk_rhythm.h({});
  assert.equal(r.ok, false); assert.match(r.err, /does NOT verify/);
  const good = harness(async (u: string) => new Response(u.endsWith(".sig") ? sig : body));
  const g = await good.get_desk_rhythm.h({});
  assert.equal(g.ok, true); assert.equal(g.data.verified, true); assert.equal(g.data.rhythm.guidanceOnly, true);
  const { privateKey } = generateKeyPairSync("ed25519");
  assert.equal(verifyRhythm(body, sign(null, body, privateKey).toString("base64")), false, "other keys are rejected");
});
