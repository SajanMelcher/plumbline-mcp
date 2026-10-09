# Plumbline: read-only DeepBook v3 market data for AI agents

Plumbline is a free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for **Sui DeepBook v3** market data. It gives agents pools, mid price, order book depth, volume, fees and pool parameters, recent trades and OHLCV candles from the public DeepBook indexer, plus live on-chain fee reads through Sui GraphQL.

- **No API keys, no wallet, no signing, no trading.** Every tool is annotated `readOnlyHint: true`.
- **Small outputs.** Compact JSON with column/row arrays for series, sensible rounding, and optional verbose fields.
- **Fast and polite.** In-memory TTL cache (2 s for books, up to 10 min for metadata), de-duplicated in-flight requests, and 8 s upstream timeouts.
- **Transports:** stdio (default) and an optional stateless streamable HTTP endpoint.

> **Disclaimer: for education and information only. This is not financial, investment, legal or tax advice.** Data comes from public third-party sources (Mysten Labs DeepBook indexer and Sui GraphQL). It may be delayed, incomplete or wrong, and is provided "as is" without warranty (see LICENSE). Nothing here recommends buying, selling or holding any asset. Do your own research.

## Tools

| Tool | What it returns | Key inputs |
|---|---|---|
| `list_pools` | All DeepBook pools: base/quote, tick, lot, min size, active flag | `asset?` (e.g. `SUI`), `include_ids?` |
| `get_mid_price` | Best bid/ask, mid, spread (abs and bps), last price | `pool` |
| `get_order_book` | Top N levels per side, plus base qty and quote notional within ±X% of mid | `pool`, `levels` (1-100), `within_pct` (e.g. `[0.5,1,2]`) |
| `get_volume` | 24h base/quote volume, high/low, % change, VWAP; or top pools by volume; or a custom trailing window | `pool?`, `window_hours` (1-720), `top` |
| `get_pool_params` | Taker/maker fee (pct and bps), DEEP stake required, tick/lot/min, whitelist/stable flags, vault balances (live on-chain) | `pool` |
| `get_recent_trades` | Latest fills: time, taker side, price, base and quote qty, buy/sell stats | `pool`, `limit` (1-200), `start_time?`, `end_time?` (unix seconds), `include_tx?` |
| `get_ohlcv` | Candles, oldest first; volume in the base asset | `pool`, `interval` (`1m,5m,15m,30m,1h,4h,1d,1w`), `limit` (1-500), `start_time?`, `end_time?` |
| `get_indexer_status` | Data-source health and freshness | none |

Pool names use `BASE_QUOTE` (for example `SUI_USDC`). Input is case-insensitive, and `sui/usdc` or `SUI-USDC` also work. An unknown pool returns a clear error with suggestions; `USDC_SUI`, for example, suggests `SUI_USDC`.

### Sample (`get_mid_price`, SUI_USDC, live 2026-10-09)

```json
{"pool":"SUI_USDC","quote":"USDC","best_bid":1.06268,"best_ask":1.06343,"mid":1.063055,"spread":0.00075,"spread_bps":7.055,"last_price":1.0629,"as_of":"2026-10-09T07:09:23.134Z"}
```

`get_order_book` depth bands (same snapshot):

```json
{"pct":1,"bid_base":204536.4,"bid_quote":216152.61,"ask_base":105721.5,"ask_quote":113063.72,"bid_levels":26,"ask_levels":27}
```

## Install

Requires Node.js 18.17 or later. Until a package is published, build from source:

```bash
git clone <repo-url> deepbook-mcp   # or copy the folder
cd deepbook-mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add plumbline -- node /absolute/path/to/deepbook-mcp/dist/index.js
```

### Claude Desktop / Cursor / Windsurf / any stdio MCP client

```json
{
  "mcpServers": {
    "plumbline": {
      "command": "node",
      "args": ["/absolute/path/to/deepbook-mcp/dist/index.js"]
    }
  }
}
```

After the npm package is published, this becomes `"command": "npx", "args": ["-y", "plumbline-mcp"]`. After the Smithery listing goes live, it becomes `npx -y @smithery/cli install plumbline --client claude`. Neither exists yet.

### Streamable HTTP (optional)

```bash
node dist/index.js --http --port 8081          # POST http://127.0.0.1:8081/mcp, GET /health
HOST=0.0.0.0 PORT=8081 node dist/index.js --http
```

The HTTP mode is stateless and returns JSON responses. Add your own reverse proxy and rate limiting before exposing it publicly.

### Configuration (all optional)

| Env var | Default |
|---|---|
| `PLUMBLINE_INDEXER_URL` | `https://deepbook-indexer.mainnet.mystenlabs.com` |
| `PLUMBLINE_GRAPHQL_URL` | `https://graphql.mainnet.sui.io/graphql` |
| `PLUMBLINE_TIMEOUT_MS` | `8000` |
| `PORT` / `HOST` (HTTP mode) | `8081` / `127.0.0.1` |

## Optional: pay-per-call in USDC on Sui (off by default)

Plumbline is free by default. An operator of a **hosted HTTP** deployment can opt in to metering, paid in **USDC on Sui**. The flow is x402-style, but it uses a native receipt check instead of a facilitator:

1. Each client gets a free daily allowance.
2. After that, a tool call returns an x402-style `PaymentRequired` result (`x402Version: 2`, scheme `sui-digest`, network `sui:testnet` or `sui:mainnet`, USDC coin type, `payTo`, and the minimum amount).
3. The client sends USDC on Sui to `payTo` from its own wallet, then retries the same call with the transaction digest in the `payment_tx` argument (or in `_meta["x402/payment"] = {"digest": "..."}`).
4. Plumbline verifies the digest read-only through Sui GraphQL: the transaction succeeded, the coin type is USDC, the net credit to `payTo` is at least the minimum, the payment is recent (15 minutes by default), and the digest has not been used before. Then it serves the call. Any value above one call becomes prepaid calls for that client.

Safety model:
- **Receive-only.** The server needs only `PAYTO_ADDRESS`. It never reads, stores or requires a private key, and there is no facilitator or custody.
- Calls that fail do not use credits. `get_indexer_status` is always free.
- Testnet is the default. Mainnet requires `PLUMBLINE_PAYMENTS_ALLOW_MAINNET=1`.
- Known limit: Sui digests are public, so someone watching `payTo` could try to redeem a payer's digest before the payer does. The short freshness window and single use limit this to one minimum payment. Binding a payment to a payer signature is a planned upgrade.

```bash
PLUMBLINE_PAYMENTS=1 \
PAYTO_ADDRESS=0xPAYTO_SUI_ADDRESS_PLACEHOLDER \
PLUMBLINE_SUI_NETWORK=testnet \
node dist/index.js --http
```

| Env var | Default | Notes |
|---|---|---|
| `PLUMBLINE_PAYMENTS` | off | `1` enables metering |
| `PAYTO_ADDRESS` | (none) | Receive-only Sui address (0x + 64 hex); the placeholder is rejected |
| `PLUMBLINE_SUI_NETWORK` | `testnet` | `mainnet` also needs `PLUMBLINE_PAYMENTS_ALLOW_MAINNET=1` |
| `PLUMBLINE_PRICE_USDC` | `0.002` | Per call after the free tier |
| `PLUMBLINE_MIN_PAYMENT_USDC` | `0.01` | Minimum single payment (= 5 calls at the default price) |
| `PLUMBLINE_FREE_CALLS_PER_DAY` | `100` | Per client per UTC day; clients are keyed by hashed IP in HTTP mode |
| `PLUMBLINE_PAYMENT_MAX_AGE_SEC` | `900` | Freshness window for payment transactions |
| `PLUMBLINE_REDEEMED_FILE` | (memory) | Optional file that keeps used digests across restarts |
| `PLUMBLINE_TRUST_PROXY` | off | Use `X-Forwarded-For` for client identity behind a proxy |

USDC coin types come from [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses). Mainnet: `0xdba3…e7::usdc::USDC`. Testnet: `0xa1ec…29::usdc::USDC`.

## Development

```bash
npm test            # live tests against the public indexer (SUI_USDC); needs network
npm run smoke       # spawns the server over stdio and calls every tool via the MCP client
npm run smoke:http  # same over streamable HTTP
npm run inspector   # MCP Inspector UI
npm run payments:testnet  # Sui testnet end-to-end with a throwaway payer (needs testnet SUI + USDC)
npm run pack:mcpb   # local MCPB bundle at build/plumbline.mcpb (for Smithery local publishing; publishes nothing)
```

## Notes and limits

- The public indexer serves at most about 100 price levels per side. When a depth band reaches past that, the response marks it `truncated: true`, and the value is a lower bound.
- `list_pools` parameters come from indexer metadata. `get_pool_params` reads the live on-chain Pool object, so it is authoritative when tick sizes or fees change through governance.
- Fees are DeepBook fixed-point values (1e9 scale), converted to pct and bps.
- No margin, balance-manager or wallet-specific endpoints are exposed.

## Name

Plumbline is named after a plumb line, the weighted cord used to measure depth and true vertical. Other candidates were *Sounding* and *Tidemark*. The name is neutral and not affiliated with Mysten Labs or Sui.

## License

MIT. See [LICENSE](./LICENSE).
