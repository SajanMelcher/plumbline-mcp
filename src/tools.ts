import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PaymentRuntime } from "./payments.js";
import { registerDeskTools, DESK_TOOLS } from "./desk-tools.js";
import {
  DeepBookClient,
  OHLCV_INTERVALS,
  UpstreamError,
  UserInputError,
  iso,
  normalizePoolName,
  poolUnits,
  sig,
} from "./deepbook.js";

export const DISCLAIMER = "Education/information only; not financial advice. Read-only public data, may be delayed or wrong.";

const poolArg = z
  .string()
  .min(3)
  .max(40)
  .transform(normalizePoolName)
  .refine((s) => /^[A-Z0-9]+_[A-Z0-9]+$/.test(s), { message: "Pool must look like BASE_QUOTE, e.g. SUI_USDC" })
  .describe("DeepBook pool name BASE_QUOTE, e.g. SUI_USDC (case-insensitive; '/' or '-' also accepted)");

const unixSec = z
  .number()
  .int()
  .min(1_600_000_000)
  .max(4_102_444_800)
  .describe("Unix timestamp in SECONDS");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

function fail(err: unknown): ToolResult {
  let msg: string;
  if (err instanceof UserInputError) msg = err.message;
  else if (err instanceof UpstreamError) msg = `${err.message}. The public data source may be down or rate-limiting; retry shortly.`;
  else msg = `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function bookTop(bids: [string, string][], asks: [string, string][]) {
  const bestBid = bids.length ? Number(bids[0]![0]) : undefined;
  const bestAsk = asks.length ? Number(asks[0]![0]) : undefined;
  if (bestBid === undefined || bestAsk === undefined) return { bestBid, bestAsk };
  const mid = (bestBid + bestAsk) / 2;
  return { bestBid, bestAsk, mid, spread: bestAsk - bestBid, spreadBps: ((bestAsk - bestBid) / mid) * 1e4 };
}

/** Tools that may be metered when x402 is enabled. get_indexer_status always stays free. */
export const PAID_TOOLS = ["list_pools", "get_mid_price", "get_order_book", "get_volume", "get_pool_params", "get_recent_trades", "get_ohlcv", ...DESK_TOOLS];

export interface RegisterOptions {
  payments?: PaymentRuntime | null;
  clientId?: string;
}

export function registerTools(server: McpServer, db: DeepBookClient, opts: RegisterOptions = {}): void {
  const { payments, clientId = "anonymous" } = opts;
  const suffix = payments ? ` ${payments.describe()}` : "";
  const paymentArg = z
    .string()
    .min(32)
    .max(64)
    .optional()
    .describe("Only after the free tier: Sui transaction digest of your exact USDC payment for payment_token (see the payment-required response)");
  const tokenArg = z
    .string()
    .regex(/^plb_[A-Za-z0-9_-]{43}$/)
    .optional()
    .describe("Only after the free tier: the private payment_token from the payment-required response; it holds your prepaid calls");
  const reg = (
    name: string,
    config: { description: string; inputSchema?: Record<string, z.ZodTypeAny> } & Record<string, unknown>,
    handler: (...a: any[]) => Promise<ToolResult>,
  ) => {
    const metered = Boolean(payments) && PAID_TOOLS.includes(name);
    return (server.registerTool as any)(
      name,
      {
        ...config,
        description: metered ? config.description + suffix : config.description,
        inputSchema: metered ? { ...(config.inputSchema ?? {}), payment_token: tokenArg, payment_tx: paymentArg } : config.inputSchema,
      },
      metered ? payments!.gate(name, handler as any, clientId) : handler,
    );
  };

  // 1. list_pools
  reg(
    "list_pools",
    {
      title: "List DeepBook pools",
      description:
        `List Sui DeepBook v3 spot pools with base/quote assets and trading params (tick, lot, min size in human units). Optional filter by asset symbol. ${DISCLAIMER}`,
      inputSchema: {
        asset: z.string().min(1).max(20).optional().describe("Only pools containing this asset symbol, e.g. SUI or USDC"),
        include_ids: z.boolean().default(false).describe("Include pool object IDs and coin types (longer output)"),
      },
      annotations: { title: "List DeepBook pools", ...READ_ONLY },
    },
    wrap(async ({ asset, include_ids }: { asset?: string; include_ids: boolean }) => {
      const [pools, ticker] = await Promise.all([db.pools(), db.ticker().catch(() => ({}) as Record<string, never>)]);
      const a = asset?.trim().toUpperCase();
      const rows = pools
        .filter((p) => !a || p.pool_name.split("_").includes(a) || p.base_asset_symbol === a || p.quote_asset_symbol === a)
        .map((p) => {
          const u = poolUnits(p);
          const t = (ticker as Record<string, { isFrozen?: number }>)[p.pool_name];
          return {
            pool: p.pool_name,
            base: p.base_asset_symbol,
            quote: p.quote_asset_symbol,
            tick: u.tick(p.tick_size),
            lot: u.base(p.lot_size),
            min_size: u.base(p.min_size),
            ...(t ? { active: t.isFrozen === 0 } : {}),
            ...(include_ids ? { pool_id: p.pool_id, base_type: p.base_asset_id, quote_type: p.quote_asset_id } : {}),
          };
        })
        .sort((x, y) => x.pool.localeCompare(y.pool));
      if (a && !rows.length) throw new UserInputError(`No pools contain asset "${asset}". Call list_pools without a filter to see all.`);
      return {
        count: rows.length,
        units: "tick in quote per base; lot/min_size in base",
        note: "Params from indexer metadata; get_pool_params returns live on-chain values (tick can differ after governance updates).",
        pools: rows,
      };
    }),
  );

  // 2. get_mid_price
  reg(
    "get_mid_price",
    {
      title: "Mid price",
      description: `Best bid, best ask, mid price and spread (abs and bps) for a DeepBook pool, plus last trade price. ${DISCLAIMER}`,
      inputSchema: { pool: poolArg },
      annotations: { title: "Mid price", ...READ_ONLY },
    },
    wrap(async ({ pool }: { pool: string }) => {
      const p = await db.resolvePool(pool);
      const [book, ticker] = await Promise.all([db.orderbook(p.pool_name, 1), db.ticker().catch(() => undefined)]);
      const top = bookTop(book.bids, book.asks);
      return {
        pool: p.pool_name,
        quote: p.quote_asset_symbol,
        best_bid: top.bestBid ?? null,
        best_ask: top.bestAsk ?? null,
        mid: top.mid !== undefined ? sig(top.mid) : null,
        spread: top.spread !== undefined ? sig(top.spread, 6) : null,
        spread_bps: top.spreadBps !== undefined ? sig(top.spreadBps, 4) : null,
        last_price: ticker?.[p.pool_name]?.last_price ?? null,
        as_of: iso(Number(book.timestamp)),
        ...(top.mid === undefined ? { note: "One side of the book is empty; no mid price." } : {}),
      };
    }),
  );

  // 3. get_order_book
  reg(
    "get_order_book",
    {
      title: "Order book depth",
      description:
        `Order book for a DeepBook pool: top N price levels per side and cumulative liquidity (base qty and quote notional) within ±X% of mid. ${DISCLAIMER}`,
      inputSchema: {
        pool: poolArg,
        levels: z.number().int().min(1).max(100).default(10).describe("Price levels to return per side (1-100, default 10)"),
        within_pct: z
          .array(z.number().gt(0).max(50))
          .min(1)
          .max(6)
          .default([0.5, 1, 2])
          .describe("Depth bands as % distance from mid, e.g. [0.5, 1, 2]"),
      },
      annotations: { title: "Order book depth", ...READ_ONLY },
    },
    wrap(async ({ pool, levels, within_pct }: { pool: string; levels: number; within_pct: number[] }) => {
      const p = await db.resolvePool(pool);
      // Fetch the max the indexer serves (100/side) once and reuse it via cache for any band/level combo.
      const book = await db.orderbook(p.pool_name, 100);
      const bids = book.bids.map(([px, q]) => [Number(px), Number(q)] as [number, number]);
      const asks = book.asks.map(([px, q]) => [Number(px), Number(q)] as [number, number]);
      const top = bookTop(book.bids, book.asks);
      if (top.mid === undefined) throw new UpstreamError(`Order book for ${p.pool_name} has an empty side; depth unavailable`);
      const mid = top.mid;
      const depth = [...within_pct].sort((x, y) => x - y).map((pct) => {
        const lo = mid * (1 - pct / 100);
        const hi = mid * (1 + pct / 100);
        const b = bids.filter(([px]) => px >= lo);
        const a = asks.filter(([px]) => px <= hi);
        const sum = (rows: [number, number][]) => rows.reduce((s, [px, q]) => ({ base: s.base + q, quote: s.quote + px * q }), { base: 0, quote: 0 });
        const sb = sum(b);
        const sa = sum(a);
        const truncated = (b.length === bids.length && bids.length >= 100) || (a.length === asks.length && asks.length >= 100);
        return {
          pct,
          bid_base: sig(sb.base, 8),
          bid_quote: sig(sb.quote, 8),
          ask_base: sig(sa.base, 8),
          ask_quote: sig(sa.quote, 8),
          bid_levels: b.length,
          ask_levels: a.length,
          ...(truncated ? { truncated: true } : {}),
        };
      });
      return {
        pool: p.pool_name,
        base: p.base_asset_symbol,
        quote: p.quote_asset_symbol,
        mid: sig(mid),
        spread_bps: sig(top.spreadBps!, 4),
        as_of: iso(Number(book.timestamp)),
        bids: bids.slice(0, levels),
        asks: asks.slice(0, levels),
        level_format: "[price, base_qty]",
        depth_within_pct: depth,
        ...(depth.some((d) => d.truncated)
          ? { note: "truncated=true: band extends past the 100 levels/side the indexer serves; depth is a lower bound." }
          : {}),
      };
    }),
  );

  // 4. get_volume
  reg(
    "get_volume",
    {
      title: "Trading volume",
      description:
        `24h volume, high/low, last price and % change for one DeepBook pool, or the top pools by 24h quote volume if no pool is given. Set window_hours for a custom trailing window (single pool). ${DISCLAIMER}`,
      inputSchema: {
        pool: poolArg.optional(),
        window_hours: z.number().int().min(1).max(720).default(24).describe("Trailing window in hours (default 24). Non-24 values need a pool."),
        top: z.number().int().min(1).max(50).default(10).describe("When no pool is given: how many pools to return (default 10)"),
      },
      annotations: { title: "Trading volume", ...READ_ONLY },
    },
    wrap(async ({ pool, window_hours, top }: { pool?: string; window_hours: number; top: number }) => {
      if (!pool) {
        if (window_hours !== 24) throw new UserInputError("A custom window_hours requires a pool.");
        const rows = (await db.summary())
          .filter((r) => r.quote_volume > 0)
          .sort((a, b) => b.quote_volume - a.quote_volume)
          .slice(0, top)
          .map((r) => ({
            pool: r.trading_pairs,
            quote: r.quote_currency,
            last: r.last_price,
            chg_24h_pct: sig(r.price_change_percent_24h, 4),
            base_vol_24h: sig(r.base_volume, 10),
            quote_vol_24h: sig(r.quote_volume, 10),
          }));
        return { window: "24h", note: "Sorted by quote volume; quote assets differ, so values are not directly comparable across quotes.", pools: rows };
      }
      const p = await db.resolvePool(pool);
      if (window_hours === 24) {
        const r = (await db.summary()).find((s) => s.trading_pairs === p.pool_name);
        if (!r) throw new UpstreamError(`No 24h summary available for ${p.pool_name}`);
        return {
          pool: p.pool_name,
          window: "24h",
          base_volume: sig(r.base_volume, 10),
          quote_volume: sig(r.quote_volume, 10),
          base: p.base_asset_symbol,
          quote: p.quote_asset_symbol,
          last_price: r.last_price,
          high_24h: r.highest_price_24h,
          low_24h: r.lowest_price_24h,
          change_24h_pct: sig(r.price_change_percent_24h, 4),
          vwap_24h: r.base_volume > 0 ? sig(r.quote_volume / r.base_volume, 8) : null,
        };
      }
      const end = Math.floor(Date.now() / 60_000) * 60; // minute-aligned for cache reuse
      const start = end - window_hours * 3600;
      const u = poolUnits(p);
      const [qv, bv] = await Promise.all([
        db.historicalVolume(p.pool_name, start, end, false),
        db.historicalVolume(p.pool_name, start, end, true),
      ]);
      const base = u.base(bv[p.pool_name] ?? 0);
      const quote = u.quote(qv[p.pool_name] ?? 0);
      return {
        pool: p.pool_name,
        window: `${window_hours}h`,
        from: iso(start * 1000),
        to: iso(end * 1000),
        base_volume: base,
        quote_volume: quote,
        base: p.base_asset_symbol,
        quote: p.quote_asset_symbol,
        vwap: base > 0 ? sig(quote / base, 8) : null,
      };
    }),
  );

  // 5. get_pool_params
  reg(
    "get_pool_params",
    {
      title: "Fees and pool parameters",
      description:
        `Taker/maker fees, DEEP stake required, tick/lot/min size, whitelist/stable flags and vault balances for a DeepBook pool. Reads the live on-chain Pool object via Sui GraphQL; falls back to indexer pool-creation values if GraphQL is unavailable. ${DISCLAIMER}`,
      inputSchema: { pool: poolArg },
      annotations: { title: "Fees and pool parameters", ...READ_ONLY },
    },
    wrap(async ({ pool }: { pool: string }) => {
      const p = await db.resolvePool(pool);
      const u = poolUnits(p);
      const fee = (raw: string | number) => {
        const r = u.feeRate(raw);
        return { pct: sig(r * 100, 6), bps: sig(r * 1e4, 6) };
      };
      const base = {
        pool: p.pool_name,
        pool_id: p.pool_id,
        base: p.base_asset_symbol,
        quote: p.quote_asset_symbol,
        base_decimals: p.base_asset_decimals,
        quote_decimals: p.quote_asset_decimals,
      };
      try {
        const s = await db.onchainPoolState(p.pool_id);
        const changed =
          s.nextTradeParams &&
          (s.nextTradeParams.taker_fee !== s.tradeParams.taker_fee || s.nextTradeParams.maker_fee !== s.tradeParams.maker_fee);
        return {
          ...base,
          source: "sui-onchain",
          taker_fee: fee(s.tradeParams.taker_fee),
          maker_fee: fee(s.tradeParams.maker_fee),
          stake_required_deep: u.deep(s.tradeParams.stake_required),
          ...(changed ? { next_epoch_taker_fee: fee(s.nextTradeParams!.taker_fee), next_epoch_maker_fee: fee(s.nextTradeParams!.maker_fee) } : {}),
          whitelisted: s.whitelisted,
          stable: s.stable,
          epoch: s.epoch,
          tick: u.tick(s.book.tick_size ?? p.tick_size),
          lot: u.base(s.book.lot_size ?? p.lot_size),
          min_size: u.base(s.book.min_size ?? p.min_size),
          ...(s.vault
            ? { vault: { base: u.base(s.vault.base_balance), quote: u.quote(s.vault.quote_balance), deep: u.deep(s.vault.deep_balance) } }
            : {}),
          fee_note: "Fees apply to the taker/maker side of each fill. Rates are per DeepBook governance and can change each epoch.",
        };
      } catch (err) {
        if (err instanceof UserInputError) throw err;
        const ev = (await db.poolCreated()).find((e) => e.pool_id === p.pool_id);
        return {
          ...base,
          source: "indexer-pool_created (fallback; initial values, may be outdated)",
          onchain_error: (err as Error).message,
          ...(ev ? { taker_fee: fee(ev.taker_fee), maker_fee: fee(ev.maker_fee), whitelisted: ev.whitelisted_pool } : {}),
          tick: u.tick(p.tick_size),
          lot: u.base(p.lot_size),
          min_size: u.base(p.min_size),
        };
      }
    }),
  );

  // 6. get_recent_trades
  reg(
    "get_recent_trades",
    {
      title: "Recent trades",
      description:
        `Most recent fills in a DeepBook pool (newest first): time, taker side, price, base and quote size. Optional time range. ${DISCLAIMER}`,
      inputSchema: {
        pool: poolArg,
        limit: z.number().int().min(1).max(200).default(20).describe("Number of trades (1-200, default 20)"),
        start_time: unixSec.optional(),
        end_time: unixSec.optional(),
        include_tx: z.boolean().default(false).describe("Include transaction digests (longer output)"),
      },
      annotations: { title: "Recent trades", ...READ_ONLY },
    },
    wrap(async (a: { pool: string; limit: number; start_time?: number; end_time?: number; include_tx: boolean }) => {
      if (a.start_time && a.end_time && a.start_time >= a.end_time) throw new UserInputError("start_time must be before end_time.");
      const p = await db.resolvePool(a.pool);
      const trades = await db.trades(p.pool_name, a.limit, a.start_time, a.end_time);
      const rows = trades.slice(0, a.limit).map((t) => {
        const r: (string | number)[] = [iso(t.timestamp), t.type, t.price, sig(t.base_volume, 10), sig(t.quote_volume, 10)];
        if (a.include_tx) r.push(t.digest);
        return r;
      });
      const buys = trades.filter((t) => t.type === "buy");
      return {
        pool: p.pool_name,
        count: rows.length,
        cols: ["time", "taker_side", "price", `${p.base_asset_symbol}_qty`, `${p.quote_asset_symbol}_qty`, ...(a.include_tx ? ["tx_digest"] : [])],
        rows,
        stats: rows.length
          ? {
              buy_count: buys.length,
              sell_count: trades.length - buys.length,
              base_total: sig(trades.reduce((s, t) => s + t.base_volume, 0), 10),
              quote_total: sig(trades.reduce((s, t) => s + t.quote_volume, 0), 10),
            }
          : undefined,
      };
    }),
  );

  // 7. get_ohlcv
  reg(
    "get_ohlcv",
    {
      title: "OHLCV candles",
      description:
        `OHLCV candles for a DeepBook pool (oldest first). Intervals: ${OHLCV_INTERVALS.join(", ")}. Volume is in the base asset. ${DISCLAIMER}`,
      inputSchema: {
        pool: poolArg,
        interval: z.enum(OHLCV_INTERVALS).default("1h"),
        limit: z.number().int().min(1).max(500).default(24).describe("Number of candles (1-500, default 24)"),
        start_time: unixSec.optional(),
        end_time: unixSec.optional(),
      },
      annotations: { title: "OHLCV candles", ...READ_ONLY },
    },
    wrap(async (a: { pool: string; interval: (typeof OHLCV_INTERVALS)[number]; limit: number; start_time?: number; end_time?: number }) => {
      if (a.start_time && a.end_time && a.start_time >= a.end_time) throw new UserInputError("start_time must be before end_time.");
      const p = await db.resolvePool(a.pool);
      const res = await db.ohlcv(p.pool_name, a.interval, a.limit, a.start_time, a.end_time);
      const candles = (res.candles ?? [])
        .slice(0, a.limit)
        .sort((x, y) => x[0] - y[0])
        .map(([t, o, h, l, c, v]) => [iso(t), o, h, l, c, sig(v, 10)]);
      return {
        pool: p.pool_name,
        interval: a.interval,
        count: candles.length,
        cols: ["open_time", "open", "high", "low", "close", `volume_${p.base_asset_symbol}`],
        candles,
      };
    }),
  );

  // 8. get_indexer_status
  reg(
    "get_indexer_status",
    {
      title: "Data source health",
      description: `Health and freshness of the public DeepBook indexer (status, latest checkpoint, server time). Use when data looks stale. ${DISCLAIMER}`,
      inputSchema: {},
      annotations: { title: "Data source health", ...READ_ONLY },
    },
    wrap(async () => {
      const s = await db.status();
      return {
        status: s.status,
        latest_onchain_checkpoint: s.latest_onchain_checkpoint,
        server_time: iso(s.current_time_ms),
        clock_skew_s: Math.round((Date.now() - s.current_time_ms) / 1000),
        max_lag_pipeline: s.max_lag_pipeline,
        indexer: db.cfg.indexerUrl,
      };
    }),
  );

  // 9-12. agent toolkit (read-only; metered like the data tools)
  registerDeskTools(reg, wrap as any, db, poolArg, READ_ONLY, DISCLAIMER);
}
