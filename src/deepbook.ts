import { TtlCache } from "./cache.js";
import { Config, TTL } from "./config.js";
import { fetchJson, UpstreamError } from "./http.js";

export { UpstreamError };

const FLOAT_SCALING = 1e9; // DeepBook v3 fixed-point scaling for prices and fees
const DEEP_DECIMALS = 6;

export interface RawPool {
  pool_id: string;
  pool_name: string;
  base_asset_id: string;
  base_asset_decimals: number;
  base_asset_symbol: string;
  base_asset_name: string;
  quote_asset_id: string;
  quote_asset_decimals: number;
  quote_asset_symbol: string;
  quote_asset_name: string;
  min_size: number;
  lot_size: number;
  tick_size: number;
}

export interface SummaryRow {
  trading_pairs: string;
  base_currency: string;
  quote_currency: string;
  last_price: number;
  highest_bid: number;
  lowest_ask: number;
  highest_price_24h: number;
  lowest_price_24h: number;
  price_change_percent_24h: number;
  base_volume: number;
  quote_volume: number;
}

export interface TickerRow {
  last_price: number;
  base_volume: number;
  quote_volume: number;
  isFrozen: number;
}

export interface RawTrade {
  trade_id: string;
  digest: string;
  price: number;
  base_volume: number;
  quote_volume: number;
  timestamp: number;
  type: string;
  taker_is_bid: boolean;
  taker_fee: number;
  maker_fee: number;
  taker_fee_is_deep: boolean;
  maker_fee_is_deep: boolean;
}

export interface RawBook {
  timestamp: string;
  bids: [string, string][];
  asks: [string, string][];
}

export interface PoolCreatedEvent {
  pool_id: string;
  taker_fee: number;
  maker_fee: number;
  whitelisted_pool: boolean;
  checkpoint_timestamp_ms: number;
}

export const OHLCV_INTERVALS = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;
export type OhlcvInterval = (typeof OHLCV_INTERVALS)[number];

/** Round to a sensible number of significant digits to keep outputs short. */
export function sig(n: number, digits = 8): number {
  if (!Number.isFinite(n) || n === 0) return n;
  return Number(n.toPrecision(digits));
}

export function iso(ms: number): string {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Normalize "sui/usdc", "SUI-USDC", "sui usdc" -> "SUI_USDC". */
export function normalizePoolName(input: string): string {
  return input.trim().toUpperCase().replace(/[\s/\-:]+/g, "_");
}

export class DeepBookClient {
  readonly cache = new TtlCache(256);
  constructor(readonly cfg: Config) {}

  private indexer<T>(path: string, ttl: number): Promise<T> {
    const url = `${this.cfg.indexerUrl}${path}`;
    return this.cache.getOrLoad(`idx:${path}`, ttl, () =>
      fetchJson<T>(url, { timeoutMs: this.cfg.timeoutMs, label: `DeepBook indexer ${path.split("?")[0]}` }),
    );
  }

  pools(): Promise<RawPool[]> {
    return this.indexer<RawPool[]>("/get_pools", TTL.pools);
  }

  /** Resolve a user-supplied pool name to the indexer's pool record, with a helpful error. */
  async resolvePool(input: string): Promise<RawPool> {
    const name = normalizePoolName(input);
    const pools = await this.pools();
    const hit = pools.find((p) => p.pool_name === name);
    if (hit) return hit;
    const [a, b] = name.split("_");
    const reversed = pools.find((p) => p.pool_name === `${b}_${a}`);
    const similar = pools
      .filter((p) => (a && p.pool_name.includes(a)) || (b && p.pool_name.includes(b)))
      .map((p) => p.pool_name)
      .slice(0, 8);
    let msg = `Unknown pool "${input}".`;
    if (reversed) msg += ` Did you mean ${reversed.pool_name}? (DeepBook names pools BASE_QUOTE.)`;
    else if (similar.length) msg += ` Similar pools: ${similar.join(", ")}.`;
    msg += " Call list_pools for all valid names.";
    throw new UserInputError(msg);
  }

  summary(): Promise<SummaryRow[]> {
    return this.indexer<SummaryRow[]>("/summary", TTL.summary);
  }

  ticker(): Promise<Record<string, TickerRow>> {
    return this.indexer<Record<string, TickerRow>>("/ticker", TTL.ticker);
  }

  orderbook(pool: string, depthPerSide: number): Promise<RawBook> {
    // Indexer "depth" counts both sides (depth=20 => 10 bids + 10 asks); level=1 gives top of book only.
    const q = depthPerSide <= 1 ? "level=1" : `level=2&depth=${depthPerSide * 2}`;
    return this.indexer<RawBook>(`/orderbook/${pool}?${q}`, TTL.orderbook);
  }

  trades(pool: string, limit: number, startSec?: number, endSec?: number): Promise<RawTrade[]> {
    const q = new URLSearchParams({ limit: String(limit) });
    if (startSec !== undefined) q.set("start_time", String(startSec));
    if (endSec !== undefined) q.set("end_time", String(endSec));
    return this.indexer<RawTrade[]>(`/trades/${pool}?${q}`, TTL.trades);
  }

  ohlcv(pool: string, interval: OhlcvInterval, limit: number, startSec?: number, endSec?: number) {
    const q = new URLSearchParams({ interval, limit: String(limit) });
    if (startSec !== undefined) q.set("start_time", String(startSec));
    if (endSec !== undefined) q.set("end_time", String(endSec));
    // Note: the indexer path is spelled "ohclv".
    return this.indexer<{ candles: [number, number, number, number, number, number][] }>(
      `/ohclv/${pool}?${q}`,
      TTL.ohlcv,
    );
  }

  historicalVolume(pool: string, startSec: number, endSec: number, inBase: boolean) {
    const q = new URLSearchParams({
      start_time: String(startSec),
      end_time: String(endSec),
      volume_in_base: String(inBase),
    });
    return this.indexer<Record<string, number>>(`/historical_volume/${pool}?${q}`, TTL.volume);
  }

  poolCreated(): Promise<PoolCreatedEvent[]> {
    return this.indexer<PoolCreatedEvent[]>("/pool_created", TTL.poolCreated);
  }

  status(): Promise<{ status: string; latest_onchain_checkpoint: number; current_time_ms: number; max_lag_pipeline?: string; pipelines?: unknown[] }> {
    return this.indexer("/status", TTL.status);
  }

  /** Read live trade params straight from the on-chain Pool object via Sui GraphQL (read-only). */
  async onchainPoolState(poolId: string): Promise<OnchainPoolState> {
    return this.cache.getOrLoad(`gql:pool:${poolId}`, TTL.onchainParams, async () => {
      const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
        const res = await fetchJson<{ data?: T; errors?: { message: string }[] }>(this.cfg.graphqlUrl, {
          method: "POST",
          body: { query, variables },
          timeoutMs: this.cfg.timeoutMs,
          label: "Sui GraphQL",
        });
        if (res.errors?.length) throw new UpstreamError(`Sui GraphQL error: ${res.errors[0]!.message}`);
        if (!res.data) throw new UpstreamError("Sui GraphQL returned no data");
        return res.data;
      };
      const outer = await gql<{ object: { asMoveObject: { contents: { json: { inner: { id: string; version: string } } } } } | null }>(
        "query($id: SuiAddress!){ object(address:$id){ asMoveObject{ contents{ json } } } }",
        { id: poolId },
      );
      const inner = outer.object?.asMoveObject?.contents?.json?.inner;
      if (!inner?.id) throw new UpstreamError(`Pool object ${poolId} not found on-chain`);
      const versionBcs = Buffer.alloc(8);
      versionBcs.writeBigUInt64LE(BigInt(inner.version));
      const df = await gql<{ address: { dynamicField: { value: { json: any } } | null } | null }>(
        "query($id: SuiAddress!, $bcs: Base64!){ address(address:$id){ dynamicField(name:{type:\"u64\", bcs:$bcs}){ value{ ... on MoveValue { json } } } } }",
        { id: inner.id, bcs: versionBcs.toString("base64") },
      );
      const j = df.address?.dynamicField?.value?.json;
      if (!j?.state?.governance?.trade_params) throw new UpstreamError("Unexpected on-chain pool layout (trade_params missing)");
      const g = j.state.governance;
      return {
        tradeParams: g.trade_params,
        nextTradeParams: g.next_trade_params,
        whitelisted: Boolean(g.whitelisted),
        stable: Boolean(g.stable),
        epoch: String(g.epoch),
        book: { tick_size: j.book?.tick_size, lot_size: j.book?.lot_size, min_size: j.book?.min_size },
        vault: j.vault,
      } satisfies OnchainPoolState;
    });
  }
}

export interface TradeParamsRaw {
  taker_fee: string;
  maker_fee: string;
  stake_required: string;
}

export interface OnchainPoolState {
  tradeParams: TradeParamsRaw;
  nextTradeParams?: TradeParamsRaw;
  whitelisted: boolean;
  stable: boolean;
  epoch: string;
  book: { tick_size?: string; lot_size?: string; min_size?: string };
  vault?: { base_balance: string; quote_balance: string; deep_balance: string };
}

export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

/** Convert raw DeepBook units to human units for a pool. */
export function poolUnits(p: RawPool) {
  const priceFactor = 10 ** (p.base_asset_decimals - p.quote_asset_decimals) / FLOAT_SCALING;
  return {
    tick: (raw: number | string) => sig(Number(raw) * priceFactor, 10),
    base: (raw: number | string) => sig(Number(raw) / 10 ** p.base_asset_decimals, 12),
    quote: (raw: number | string) => sig(Number(raw) / 10 ** p.quote_asset_decimals, 12),
    deep: (raw: number | string) => sig(Number(raw) / 10 ** DEEP_DECIMALS, 12),
    feeRate: (raw: number | string) => Number(raw) / FLOAT_SCALING,
  };
}
