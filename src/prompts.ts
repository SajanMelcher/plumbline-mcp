import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DISCLAIMER } from "./tools.js";

const GUIDE = `# The Spice Melange Trading Desk guide

The Spice Melange Trading Desk (DeepBook market data connector, server id plumbline) is a read-only MCP server for Sui DeepBook v3 market data. It has no keys, no wallet and no trading.

## Pool names
Pools are named BASE_QUOTE, for example SUI_USDC, DEEP_USDC or WAL_USDC. Input is case-insensitive, and "sui/usdc" and "SUI-USDC" also work.
Call list_pools if unsure; an unknown pool returns suggestions.

## Tools
- list_pools: all pools, with base/quote, tick, lot and min size
- get_mid_price: best bid/ask, mid, spread (abs and bps), last price
- get_order_book: top N levels plus base/quote depth within +/-X% of mid
- get_volume: 24h volume, high/low, change, VWAP; or top pools; or a custom window
- get_pool_params: live on-chain taker/maker fees, DEEP stake, tick/lot/min, vault balances
- get_recent_trades: latest fills with side, price and size
- get_ohlcv: candles (1m to 1w), oldest first
- get_indexer_status: data-source health and freshness

## Data sources
- Mysten Labs public DeepBook indexer: books, trades, volume, candles
- Sui GraphQL: live pool objects (fees and parameters)
The indexer serves about 100 levels per side; depth bands beyond that are marked truncated.

## Disclaimer
${DISCLAIMER} Nothing here recommends buying, selling or holding any asset.
`;

const pool = z.string().describe("DeepBook pool as BASE_QUOTE, e.g. SUI_USDC");

/** Workflow prompts and reference resources. These are static text only; tools do all the data access. */
export function registerPromptsAndResources(server: McpServer): void {
  server.registerResource(
    "guide",
    "plumbline://guide",
    { title: "The Spice Melange Trading Desk guide", description: "Pool naming, tools, data sources and disclaimer", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }),
  );
  server.registerResource(
    "disclaimer",
    "plumbline://disclaimer",
    { title: "Disclaimer", description: "Education-only disclaimer for all The Spice Melange Trading Desk data", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: DISCLAIMER }] }),
  );

  const user = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

  server.registerPrompt(
    "market_snapshot",
    {
      title: "Market snapshot",
      description: "Summarize one DeepBook pool: mid, spread, 1% depth, 24h volume and fees",
      argsSchema: { pool },
    },
    ({ pool }) =>
      user(
        `Give a short, neutral market snapshot of DeepBook pool ${pool}. Use get_mid_price, get_order_book (within_pct [0.5,1,2]), ` +
          `get_volume and get_pool_params. Report the spread in bps, depth within 1% of mid on each side, 24h volume and the taker/maker fees. ` +
          `Do not give trading advice. End with: "${DISCLAIMER}"`,
      ),
  );
  server.registerPrompt(
    "compare_pools",
    {
      title: "Compare pools",
      description: "Compare spread, depth and volume across several DeepBook pools",
      argsSchema: { pools: z.string().describe("Comma-separated pools, e.g. SUI_USDC,DEEP_USDC,WAL_USDC") },
    },
    ({ pools }) =>
      user(
        `Compare these DeepBook pools: ${pools}. For each, call get_mid_price and get_order_book (within_pct [1]) and get_volume. ` +
          `Show a compact table: pool, spread bps, bid/ask depth within 1% (quote), 24h quote volume. Note any pool with thin depth. ` +
          `No recommendations. End with: "${DISCLAIMER}"`,
      ),
  );
  server.registerPrompt(
    "liquidity_check",
    {
      title: "Liquidity check",
      description: "Estimate how much size sits near mid on a DeepBook pool before a hypothetical order",
      argsSchema: { pool, size: z.string().describe("Hypothetical order size in the base asset, e.g. 1000") },
    },
    ({ pool, size }) =>
      user(
        `For DeepBook pool ${pool}, use get_order_book (levels 100, within_pct [0.25,0.5,1,2]) to explain how far a hypothetical ` +
          `${size} base-asset market order would walk the book on each side, using only the returned levels. Say if the book data is truncated. ` +
          `This is an educational illustration, not an execution estimate or advice. End with: "${DISCLAIMER}"`,
      ),
  );
}
