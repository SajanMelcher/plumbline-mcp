// Agent toolkit tools (Ixians 2026-10-10; Sajan 01:47 PT order item 5). Read-only, no keys, same pay-per-call metering as the
// other data tools (added to PAID_TOOLS). Built only on the public DeepBook indexer + Sui GraphQL calls the server already makes.
import { z } from "zod";
import { DeepBookClient, UserInputError, iso, poolUnits, sig } from "./deepbook.js";

export const DESK_TOOLS = ["get_bm_fills", "get_swing_range", "get_pool_stats", "estimate_fees"] as const;
/** DeepBook v3 charges fees paid in the input token at the DEEP rate x 1.25 (FEE_PENALTY_MULTIPLIER). */
export const INPUT_TOKEN_FEE_MULTIPLIER = 1.25;

type Reg = (name: string, config: any, handler: (...a: any[]) => Promise<any>) => unknown;
type Wrap = <A>(fn: (args: A) => Promise<unknown>) => (args: A) => Promise<any>;

const bmArg = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "balance manager id must be 0x + 64 hex").describe("DeepBook BalanceManager object id (0x + 64 hex)");

/** Swing regime from the 4h high-low range (same cut-offs as the Fish Speakers' swing.ts): CALM < 2%, ELEVATED 2-4%, HIGH_VOL > 4%. */
export function swingFromCandles(c: [number, number, number, number, number, number][]) {
  const cs = [...c].sort((a, b) => a[0] - b[0]);
  if (cs.length < 5) throw new UserInputError("Not enough candles for a swing signal (need >= 5 hourly candles).");
  const rng = (xs: typeof cs) => ((Math.max(...xs.map((x) => x[2])) - Math.min(...xs.map((x) => x[3]))) / xs[xs.length - 1]![4]) * 100;
  const r4 = rng(cs.slice(-4)), r24 = rng(cs.slice(-24)), r1 = rng(cs.slice(-1));
  const rets = cs.slice(1).map((x, i) => Math.log(x[4] / cs[i]![4]));
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, rets.length - 1));
  const regime = r4 > 4 ? "HIGH_VOL" : r4 >= 2 ? "ELEVATED" : "CALM";
  return { range_1h_pct: sig(r1, 4), range_4h_pct: sig(r4, 4), range_24h_pct: sig(r24, 4), rv_1h_pct: sig(sd * 100, 4), rv_daily_pct: sig(sd * Math.sqrt(24) * 100, 4),
    regime, suggested_rungs: regime === "HIGH_VOL" ? 5 : regime === "ELEVATED" ? 4 : 3 };
}

/** Fee for one fill: rate x notional; paying in the input token costs rate x 1.25, paying in DEEP costs rate in DEEP. */
export function feeEstimate(rate: number, qty: number, price: number, deepPrice: number | null) {
  const notional = qty * price;
  const inputUsd = notional * rate * INPUT_TOKEN_FEE_MULTIPLIER;
  const deepUsd = notional * rate;
  return { notional_quote: sig(notional, 10), fee_rate_bps: sig(rate * 1e4, 6),
    pay_in_input_token: { fee_quote_equiv: sig(inputUsd, 8), multiplier: INPUT_TOKEN_FEE_MULTIPLIER },
    pay_in_deep: deepPrice ? { fee_deep: sig(deepUsd / deepPrice, 8), fee_quote_equiv: sig(deepUsd, 8), deep_price: deepPrice } : null,
    saving_with_deep_quote: sig(inputUsd - deepUsd, 8) };
}

export function registerDeskTools(reg: Reg, wrap: Wrap, db: DeepBookClient, poolArg: z.ZodTypeAny, READ_ONLY: object, DISCLAIMER: string) {
  reg("get_bm_fills", {
    title: "Fill history for a balance manager",
    description: `Fills (OrderFilled) where a given DeepBook BalanceManager was the maker or the taker in one pool, newest first: time, its side, price, qty, fee, tx. Public data; no keys. ${DISCLAIMER}`,
    inputSchema: { pool: poolArg, balance_manager_id: bmArg, role: z.enum(["maker", "taker"]).default("maker"),
      limit: z.number().int().min(1).max(200).default(50), hours: z.number().int().min(1).max(720).default(168).describe("Look-back window in hours (default 168 = 7 days)") },
    annotations: { title: "Fill history for a balance manager", ...READ_ONLY },
  }, wrap(async (a: { pool: string; balance_manager_id: string; role: "maker" | "taker"; limit: number; hours: number }) => {
    const p = await db.resolvePool(a.pool);
    const bm = a.balance_manager_id.toLowerCase();
    const end = Math.floor(Date.now() / 1000);
    const trades: any[] = await db.bmTrades(p.pool_name, bm, a.role, a.limit, end - a.hours * 3600, end);
    const mine = trades.filter((t) => String(t[`${a.role}_balance_manager_id`]).toLowerCase() === bm);
    const rows = mine.slice(0, a.limit).map((t) => {
      const side = a.role === "maker" ? (t.taker_is_bid ? "sell" : "buy") : (t.taker_is_bid ? "buy" : "sell");
      return [iso(t.timestamp), side, t.price, sig(t.base_volume, 10), sig(t.quote_volume, 10), sig(Number(t[`${a.role}_fee`] ?? 0), 8), t[`${a.role}_fee_is_deep`] ? "DEEP" : "input", t.digest];
    });
    return { pool: p.pool_name, balance_manager_id: bm, role: a.role, window_hours: a.hours, count: rows.length,
      cols: ["time", "bm_side", "price", `${p.base_asset_symbol}_qty`, `${p.quote_asset_symbol}_qty`, "fee", "fee_token", "tx_digest"], rows };
  }));

  reg("get_swing_range", {
    title: "Swing / range signal",
    description: `1h/4h/24h high-low range and realized volatility from hourly candles, a regime (CALM < 2%, ELEVATED 2-4%, HIGH_VOL > 4% 4h range) and a suggested ladder rung count (3/4/5). Information only, not a trading instruction. ${DISCLAIMER}`,
    inputSchema: { pool: poolArg },
    annotations: { title: "Swing / range signal", ...READ_ONLY },
  }, wrap(async ({ pool }: { pool: string }) => {
    const p = await db.resolvePool(pool);
    const res = await db.ohlcv(p.pool_name, "1h", 25);
    return { pool: p.pool_name, candles: (res.candles ?? []).length, ...swingFromCandles(res.candles ?? []),
      note: "Suggested rungs assume a 3-rung base widened on bigger swings; any real ladder must apply its own caps and risk rules." };
  }));

  reg("get_pool_stats", {
    title: "Pool scorecard stats",
    description: `Scorecard-style stats for one pool over the last N hours: trade count, taker buy/sell split, base/quote volume, VWAP, average trade size, price range, current spread. ${DISCLAIMER}`,
    inputSchema: { pool: poolArg, hours: z.number().int().min(1).max(72).default(24) },
    annotations: { title: "Pool scorecard stats", ...READ_ONLY },
  }, wrap(async ({ pool, hours }: { pool: string; hours: number }) => {
    const p = await db.resolvePool(pool);
    const end = Math.floor(Date.now() / 1000);
    const [tr, book] = await Promise.all([db.trades(p.pool_name, 500, end - hours * 3600, end), db.orderbook(p.pool_name, 1)]);
    const base = tr.reduce((s, t) => s + t.base_volume, 0), quote = tr.reduce((s, t) => s + t.quote_volume, 0);
    const px = tr.map((t) => t.price);
    const bid = book.bids?.length ? Number(book.bids[0]![0]) : NaN, ask = book.asks?.length ? Number(book.asks[0]![0]) : NaN;
    return { pool: p.pool_name, window_hours: hours, trades: tr.length, truncated_at_500: tr.length >= 500,
      taker_buys: tr.filter((t) => t.taker_is_bid).length, taker_sells: tr.filter((t) => !t.taker_is_bid).length,
      base_volume: sig(base, 10), quote_volume: sig(quote, 10), vwap: base > 0 ? sig(quote / base, 8) : null,
      avg_trade_quote: tr.length ? sig(quote / tr.length, 6) : null,
      high: px.length ? Math.max(...px) : null, low: px.length ? Math.min(...px) : null,
      spread_bps: Number.isFinite(bid) && Number.isFinite(ask) ? sig(((ask - bid) / ((ask + bid) / 2)) * 1e4, 4) : null };
  }));

  reg("estimate_fees", {
    title: "Fee estimate (input token vs DEEP)",
    description: `Estimated DeepBook fee for a fill of qty at price as maker or taker, paid in the input token (rate x 1.25) versus in DEEP (base rate), using the live on-chain fee rates and the DEEP_USDC mid. ${DISCLAIMER}`,
    inputSchema: { pool: poolArg, qty: z.number().positive().describe("Base quantity"), price: z.number().positive().optional().describe("Price; defaults to the current mid"),
      role: z.enum(["maker", "taker"]).default("taker") },
    annotations: { title: "Fee estimate", ...READ_ONLY },
  }, wrap(async (a: { pool: string; qty: number; price?: number; role: "maker" | "taker" }) => {
    const p = await db.resolvePool(a.pool);
    const u = poolUnits(p);
    const s = await db.onchainPoolState(p.pool_id);
    const rate = u.feeRate(a.role === "maker" ? s.tradeParams.maker_fee : s.tradeParams.taker_fee);
    const mid = async (name: string) => { const b = await db.orderbook(name, 1); return b.bids?.length && b.asks?.length ? (Number(b.bids[0]![0]) + Number(b.asks[0]![0])) / 2 : null; };
    const price = a.price ?? (await mid(p.pool_name));
    if (!price) throw new UserInputError("No mid price available; pass price explicitly.");
    let deep: number | null = null; try { deep = await mid("DEEP_USDC"); } catch { deep = null; }
    const quoteIsUsdc = p.quote_asset_symbol === "USDC";
    return { pool: p.pool_name, role: a.role, qty: a.qty, price, ...feeEstimate(rate, a.qty, price, quoteIsUsdc ? deep : null),
      ...(quoteIsUsdc ? {} : { note: "DEEP comparison needs a USDC-quoted pool; only the input-token fee is shown." }),
      stake_required_deep: u.deep(s.tradeParams.stake_required) };
  }));
}
