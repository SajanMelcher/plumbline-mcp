import { test } from "node:test";
import assert from "node:assert/strict";
import { swingFromCandles, feeEstimate, DESK_TOOLS } from "../src/desk-tools.js";
import { PAID_TOOLS } from "../src/tools.js";

const candles = (rangePct: number, n = 25) =>
  Array.from({ length: n }, (_, i) => [i * 3600_000, 1, 1 + rangePct / 200, 1 - rangePct / 200, 1, 10] as [number, number, number, number, number, number]);

test("swing regime uses the Fish swing.ts cut-offs (2% / 4% of the 4h range)", () => {
  assert.equal(swingFromCandles(candles(1.9)).regime, "CALM");
  assert.equal(swingFromCandles(candles(2.0)).suggested_rungs, 4);
  assert.equal(swingFromCandles(candles(4.5)).suggested_rungs, 5);
  assert.throws(() => swingFromCandles(candles(1, 3)), /Not enough candles/);
});

test("fee estimate: input token costs 1.25x the DEEP rate", () => {
  const f = feeEstimate(0.001, 10, 1, 0.02);
  assert.equal(f.pay_in_input_token.fee_quote_equiv, 0.0125);
  assert.equal(f.pay_in_deep!.fee_quote_equiv, 0.01);
  assert.equal(f.pay_in_deep!.fee_deep, 0.5);
  assert.equal(f.saving_with_deep_quote, 0.0025);
  assert.equal(feeEstimate(0.001, 10, 1, null).pay_in_deep, null);
});

test("new toolkit tools are metered like the other data tools", () => {
  for (const t of DESK_TOOLS) assert.ok(PAID_TOOLS.includes(t));
});
