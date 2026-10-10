import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { OrderLimiter, registerStoreTools, storeBucket, forwardedClient, connectorKey, clientSalt, storeOrigin, verifyRhythm, checkPayee, STORE_ORIGIN, PINNED_PAYEE } from "../src/store-tools.js";

function harness(fetchImpl: any, lim = new OrderLimiter(2, 5, 9, 9)) {
  const tools: Record<string, any> = {};
  const wrap = (fn: any) => async (a: any) => { try { return { ok: true, data: await fn(a) }; } catch (e) { return { ok: false, err: (e as Error).message }; } };
  registerStoreTools((n, c, h) => (tools[n] = { c, h }), wrap as any, { clientId: "c1", origin: STORE_ORIGIN, fetchImpl, lim });
  return tools;
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("store origin is pinned (S7): default only; a preview needs PLUMBLINE_ALLOW_PREVIEW_STORE=1; anything else throws", () => {
  assert.equal(storeOrigin({}), STORE_ORIGIN);
  assert.throws(() => storeOrigin({ PLUMBLINE_STORE_URL: "https://abc123.spicemelange-site.pages.dev/x" }), /ALLOW_PREVIEW/);
  assert.equal(storeOrigin({ PLUMBLINE_STORE_URL: "https://abc123.spicemelange-site.pages.dev/x", PLUMBLINE_ALLOW_PREVIEW_STORE: "1" }), "https://abc123.spicemelange-site.pages.dev");
  assert.throws(() => storeOrigin({ PLUMBLINE_STORE_URL: "https://evil.example", PLUMBLINE_ALLOW_PREVIEW_STORE: "1" }));
  for (const bad of ["https://evil.example", "http://thespicemelange.org", "https://thespicemelange.org.evil.com", "https://x.spicemelange-site.pages.dev.evil.com"])
    assert.throws(() => storeOrigin({ PLUMBLINE_STORE_URL: bad }));
});

test("registers exactly the four store tools", () => {
  assert.deepEqual(Object.keys(harness(async () => json({}))).sort(), ["check_template_order", "create_template_order", "get_desk_rhythm", "list_templates"]);
});

test("create_template_order relays to the pinned store and is rate limited per client", async () => {
  const calls: string[] = [];
  const site = "/workspace/ixians/spicemelange-site/public/templates";
  const t = harness(async (u: string, init: any) => {
    if (u.endsWith("/templates/versions.json")) return new Response(readFileSync(`${site}/versions.json`));
    if (u.endsWith("/templates/versions.json.sig")) return new Response(readFileSync(`${site}/versions.json.sig`, "utf8"));
    calls.push(`${init.method} ${u}`); return json({ ok: true, order: { orderId: "SM-ABCDEFGHJK", token: "smt_" + "a".repeat(43), payTo: PINNED_PAYEE!, amount: "300.000123" } }, 201); });
  for (let i = 0; i < 2; i++) { const r = await t.create_template_order.h({ sku: "fish-speakers" }); assert.equal(r.ok, true); assert.equal(r.data.payeeVerified, true, "pin + signed versions.json payee match"); }
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

test("payee pin (S2): pinned to 0x88e8…780f; any mismatch with the pin or the signed payee refuses", () => {
  assert.equal(PINNED_PAYEE, "0x88e8516771e71da54a7449a0a46e6a0c4af71ef71ac4d379847319c7e18a780f", "Sajan 6:37 AM PT: pinned");
  const A = "0x" + "ab".repeat(32), B = "0x" + "cd".repeat(32);
  assert.deepEqual(checkPayee(A, null, null), { ok: true, verified: false, payTo: A });
  assert.equal(checkPayee(A, A, null).verified, true);
  assert.equal(checkPayee(A.toUpperCase().replace("0X", "0x"), A, null).ok, true, "case-insensitive");
  assert.equal(checkPayee(A, B, null).ok, false);
  assert.equal(checkPayee(A, null, B).ok, false);
  assert.equal(checkPayee("nonsense", null, null).ok, false);
});

test("create_template_order refuses a payee that differs from the pin, and a versions.json with a bad signature", async () => {
  const site = "/workspace/ixians/spicemelange-site/public/templates";
  const mk = (sig: string, pinnedPayee: string | null, payTo: string = PINNED_PAYEE!) => {
    const tools: Record<string, any> = {};
    const wrap = (fn: any) => async (a: any) => { try { return { ok: true, data: await fn(a) }; } catch (e) { return { ok: false, err: (e as Error).message }; } };
    registerStoreTools((n, c, h) => (tools[n] = { c, h }), wrap as any, { clientId: "p", origin: STORE_ORIGIN, lim: new OrderLimiter(9, 9), pinnedPayee,
      fetchImpl: (async (u: string) => u.endsWith("versions.json") ? new Response(readFileSync(`${site}/versions.json`)) : u.endsWith(".sig") ? new Response(sig)
        : json({ ok: true, order: { orderId: "SM-ABCDEFGHJK", token: "smt_" + "a".repeat(43), payTo, amount: "50.000001" } }, 201)) as any });
    return tools;
  };
  const good = readFileSync(`${site}/versions.json.sig`, "utf8");
  const r1 = await mk(good, "0x" + "cd".repeat(32)).create_template_order.h({ sku: "moneo" });
  assert.equal(r1.ok, false); assert.match(r1.err, /REFUSED/);
  const r2 = await mk(Buffer.alloc(64).toString("base64"), null).create_template_order.h({ sku: "moneo" });
  assert.equal(r2.ok, false); assert.match(r2.err, /does NOT verify/);
  const r3 = await mk(good, PINNED_PAYEE).create_template_order.h({ sku: "moneo" });
  assert.equal(r3.ok, true); assert.equal(r3.data.payeeVerified, true);
  const r4 = await mk(good, null, "0x" + "ab".repeat(32)).create_template_order.h({ sku: "moneo" });
  assert.equal(r4.ok, false); assert.match(r4.err, /signed versions\.json/, "the signed payee alone also refuses a swapped payTo");
});

test("S5: open-hold caps per client and global, plus hourly rate", () => {
  const now = 1_000_000_000_000;
  const l = new OrderLimiter(10, 100, 2, 3);
  assert.equal(l.check("a", now), null); l.hold("a", now + 1_800_000, now);
  assert.equal(l.check("a", now), null); l.hold("a", now + 1_800_000, now);
  assert.match(l.check("a", now) ?? "", /unpaid orders waiting/);
  assert.equal(l.check("a", now + 1_800_001), null, "holds end when the payment window ends");
  const g = new OrderLimiter(10, 100, 5, 2);
  g.check("x", now); g.hold("x", now + 60_000, now); g.check("y", now); g.hold("y", now + 60_000, now);
  assert.match(g.check("z", now) ?? "", /connector right now/);
  const r = new OrderLimiter(1, 100, 5, 50);
  assert.equal(r.check("c", now), null); assert.match(r.check("c", now) ?? "", /last hour/);
});

test("S5: /48 grouping, hashed forwarded client, store key only when set", async () => {
  assert.equal(storeBucket("ip:2001:0db8:0001:0002::/64"), "ip:2001:0db8:0001::/48");
  assert.equal(storeBucket("ip:2001:0db8:0001:ffff::/64"), "ip:2001:0db8:0001::/48");
  assert.equal(storeBucket("ip:203.0.113.9"), "ip:203.0.113.9");
  assert.match(forwardedClient("ip:203.0.113.9", "s".repeat(16)), /^[0-9a-f]{24}$/);
  assert.notEqual(forwardedClient("ip:203.0.113.9", "a".repeat(16)), forwardedClient("ip:203.0.113.9", "b".repeat(16)), "salted");
  assert.equal(clientSalt({ PLUMBLINE_STORE_CLIENT_SALT: "short" } as any), null);
  assert.equal(connectorKey({ PLUMBLINE_STORE_CONNECTOR_KEY: "short" } as any), null);
  const seen: any[] = [];
  const fakeFetch: any = async (url: string, init: any) => { seen.push(init?.headers ?? {}); return new Response(JSON.stringify({ ok: true, order: { orderId: "SM-X", token: "t", payTo: "0x" + "ab".repeat(32), amount: "1", expiresAt: new Date(Date.now() + 1e6).toISOString() } }), { status: 201, headers: { "content-type": "application/json" } }); };
  for (const [key, salt] of [["k".repeat(40), "z".repeat(24)], [null, "z".repeat(24)], ["k".repeat(40), null]] as const) {
    seen.length = 0;
    const tools: Record<string, any> = {};
    registerStoreTools((n: string, _c: any, h: any) => (tools[n] = h), ((fn: any) => fn) as any, { clientId: "ip:2001:0db8:0001:0002::/64", fetchImpl: fakeFetch, lim: new OrderLimiter(9, 9, 9, 9), pinnedPayee: null, connectorKey: key, clientSalt: salt });
    try { await tools.create_template_order({ sku: "moneo" }); } catch { /* payee lookups may fail on the fake; headers are what we check */ }
    const h = seen[0];
    if (key && salt) { assert.equal(h["x-connector-key"], key); assert.equal(h["x-connector-client"], forwardedClient("ip:2001:0db8:0001::/48", salt)); }
    else assert.equal(h["x-connector-key"], undefined);
  }
});

test("S2 end-to-end: production pin + signed versions.json (real signed bytes) -> payeeVerified=true; any other payTo refused", async () => {
  const { readFileSync } = await import("node:fs");
  const vbody = readFileSync(new URL("./fixtures/versions.prod.json", import.meta.url));
  const vsig = readFileSync(new URL("./fixtures/versions.prod.json.sig", import.meta.url), "utf8");
  const order = (payTo: string) => ({ ok: true, order: { orderId: "SM-PINTEST01", token: "t".repeat(32), payTo, coinType: "x", amount: "50.001", amountAtomic: "50001000", expiresAt: new Date(Date.now() + 1_800_000).toISOString() } });
  const mk = (payTo: string) => async (url: string) => {
    if (url.endsWith("/templates/versions.json")) return new Response(vbody);
    if (url.endsWith("/templates/versions.json.sig")) return new Response(vsig);
    if (url.endsWith("/api/store/order")) return json(order(payTo), 201);
    return json({}, 404);
  };
  const ok = await harness(mk(PINNED_PAYEE!)).create_template_order.h({ sku: "moneo" });
  assert.equal(ok.ok, true); assert.equal(ok.data.payeeVerified, true);
  const bad = await harness(mk("0x" + "ab".repeat(32))).create_template_order.h({ sku: "moneo" });
  assert.equal(bad.ok, false); assert.match(bad.err, /REFUSED/);
});
