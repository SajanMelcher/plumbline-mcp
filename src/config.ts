export interface Config {
  indexerUrl: string;
  graphqlUrl: string;
  timeoutMs: number;
}

/** Empty strings count as unset (MCPB clients pass "" for optional settings left blank). */
const val = (v: string | undefined) => (v && v.trim() && !/^\$\{user_config\./.test(v) ? v.trim() : undefined);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const timeout = Number(val(env.PLUMBLINE_TIMEOUT_MS) ?? 8000);
  return {
    indexerUrl: (val(env.PLUMBLINE_INDEXER_URL) ?? "https://deepbook-indexer.mainnet.mystenlabs.com").replace(/\/+$/, ""),
    graphqlUrl: val(env.PLUMBLINE_GRAPHQL_URL) ?? "https://graphql.mainnet.sui.io/graphql",
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 60000 ? timeout : 8000,
  };
}

/** Cache TTLs (ms). Short for live book data, longer for slow-moving metadata. */
export const TTL = {
  pools: 10 * 60_000,
  poolCreated: 60 * 60_000,
  onchainParams: 60_000,
  orderbook: 2_000,
  summary: 15_000,
  ticker: 15_000,
  volume: 30_000,
  trades: 5_000,
  ohlcv: 30_000,
  status: 10_000,
} as const;
