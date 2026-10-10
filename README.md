# The Spice Melange Trading Desk: DeepBook market data connector

Read-only DeepBook v3 market data for AI agents. (Package, server id and endpoint keep the name `plumbline`.)

[![npm](https://img.shields.io/npm/v/plumbline-mcp)](https://www.npmjs.com/package/plumbline-mcp)
[![Smithery](https://img.shields.io/badge/Smithery-plumbline-ff6b2c)](https://smithery.ai/servers/nazarenechalice/plumbline)
[![MCP](https://img.shields.io/badge/MCP-stdio%20%7C%20HTTP-6f42c1)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

The Spice Melange Trading Desk (DeepBook market data connector, package `plumbline-mcp`) is a free, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server for **Sui DeepBook v3** market data. It gives agents pools, mid price and spread, order book depth, volume, live on-chain fees, recent trades and OHLCV candles.

- **No API keys, no wallet, no signing, no trading.** Every tool is annotated `readOnlyHint: true`.
- **Small outputs.** Compact JSON with column/row arrays for series and sensible rounding.
- **Fast and polite.** An in-memory TTL cache (2 s for books, up to 10 min for metadata), de-duplicated requests and 8 s timeouts.

> **Disclaimer: for education and information only. This is not financial, investment, legal or tax advice.** Data comes from public third-party sources (the Mysten Labs DeepBook indexer and Sui GraphQL). It may be delayed, incomplete or wrong, and is provided "as is" without warranty. Nothing here recommends buying, selling or holding any asset.

## Quickstart

```bash
npx -y plumbline-mcp
```

The server runs over stdio and needs Node.js 18.17 or later. It needs no configuration.

### Claude Code

```bash
claude mcp add plumbline -- npx -y plumbline-mcp
```

### Claude Desktop, Cursor, Windsurf, VS Code or any stdio client

Add this to your client's MCP config (`claude_desktop_config.json`, `~/.cursor/mcp.json`, and so on):

```json
{
  "mcpServers": {
    "plumbline": {
      "command": "npx",
      "args": ["-y", "plumbline-mcp"]
    }
  }
}
```

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=plumbline&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBsdW1ibGluZS1tY3AiXX0%3D)

### Smithery

```bash
npx -y @smithery/cli@latest mcp add nazarenechalice/plumbline --client claude   # or cursor, claude-code, vscode, windsurf, ...
```

You can also open the [Smithery listing](https://smithery.ai/servers/nazarenechalice/plumbline). For one-click Claude Desktop install, download the `.mcpb` bundle there.

### Hosted endpoint (remote, nothing to install)

A hosted instance runs at **`https://plumbline-mcp.fly.dev/mcp`** (streamable HTTP, stateless, JSON responses; health at `/health`, server card at `/.well-known/mcp/server-card.json`).

```bash
claude mcp add --transport http plumbline https://plumbline-mcp.fly.dev/mcp
```

Any client that takes a remote MCP URL (Cursor, VS Code, Claude Desktop connectors, Windsurf):

```json
{
  "mcpServers": {
    "plumbline": { "type": "http", "url": "https://plumbline-mcp.fly.dev/mcp" }
  }
}
```

The hosted endpoint gives each client **100 free tool calls per UTC day**, then **0.002 USDC per call**, prepaid in USDC on Sui mainnet in batches of about 0.01 USDC. `get_indexer_status` is always free. After the free calls, a tool returns an x402-style payment-required result with an exact amount and a private `payment_token`; see [docs/PAYMENTS.md](docs/PAYMENTS.md). The npm/stdio package stays free with no limits.

### Streamable HTTP (self-hosted)

```bash
npx -y plumbline-mcp --http --port 8081        # POST http://127.0.0.1:8081/mcp, GET /health
HOST=0.0.0.0 PORT=8081 npx -y plumbline-mcp --http
```

HTTP mode is stateless and returns JSON. It also serves a static server card at `/.well-known/mcp/server-card.json` and rate-limits each client to 120 requests per minute. Put it behind TLS before you expose it. Hosting notes are in [deploy/DEPLOY.md](deploy/DEPLOY.md).

## Ask your agent

- "What's the spread on DeepBook SUI_USDC right now?"
- "How much liquidity is within 1% of mid on SUI_USDC?"
- "Show 1h candles for DEEP_USDC for the last day."
- "Which DeepBook pools had the most volume in the last 24 hours?"
- "What are the current taker and maker fees on SUI_USDC?"

The server also ships prompts (`market_snapshot`, `compare_pools`, `liquidity_check`) and resources (`plumbline://guide`, `plumbline://disclaimer`).

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
| `get_bm_fills` | Fills where one BalanceManager was maker (or taker): time, its side, price, qty, fee and fee token, tx | `pool`, `balance_manager_id`, `role?`, `limit`, `hours` |
| `get_swing_range` | 1h/4h/24h range, realized vol, regime (CALM < 2%, ELEVATED 2-4%, HIGH_VOL > 4% 4h range) and a suggested rung count 3/4/5 | `pool` |
| `get_pool_stats` | Scorecard-style stats over N hours: trades, taker buy/sell split, volume, VWAP, avg trade, range, spread | `pool`, `hours` (1-72) |
| `estimate_fees` | Fee for a fill paid in the input token (rate x 1.25) vs in DEEP (base rate), from live on-chain rates | `pool`, `qty`, `price?`, `role` |

Pool names use `BASE_QUOTE` (for example `SUI_USDC`). Input is case-insensitive, and `sui/usdc` or `SUI-USDC` also work. An unknown pool returns a clear error with suggestions; `USDC_SUI`, for example, suggests `SUI_USDC`.

### Example output (live, Oct 9 2026)

`get_mid_price` with `{"pool":"SUI_USDC"}`:

```json
{"pool":"SUI_USDC","quote":"USDC","best_bid":1.0708,"best_ask":1.07106,"mid":1.07093,"spread":0.00026,"spread_bps":2.428,"last_price":1.0708,"as_of":"2026-10-09T08:38:03.997Z"}
```

One depth band from `get_order_book` (an earlier snapshot the same day):

```json
{"pct":1,"bid_base":204536.4,"bid_quote":216152.61,"ask_base":105721.5,"ask_quote":113063.72,"bid_levels":26,"ask_levels":27}
```

`get_pool_params` with `{"pool":"SUI_USDC"}` (read live from the on-chain Pool object; trimmed):

```json
{"pool":"SUI_USDC","source":"sui-onchain","taker_fee":{"pct":0.02,"bps":2},"maker_fee":{"pct":0,"bps":0},"stake_required_deep":100000,"tick":0.00001,"lot":0.1,"min_size":1}
```

`get_ohlcv` with `{"pool":"SUI_USDC","interval":"1h","limit":2}`:

```json
{"pool":"SUI_USDC","interval":"1h","count":2,"cols":["open_time","open","high","low","close","volume_SUI"],"candles":[["2026-10-09T07:00:00Z",1.0658,1.07579,1.06268,1.07543,66001],["2026-10-09T08:00:00Z",1.07529,1.07817,1.06721,1.0708,26347.5]]}
```

## Configuration (all optional)

| Env var | Default |
|---|---|
| `PLUMBLINE_INDEXER_URL` | `https://deepbook-indexer.mainnet.mystenlabs.com` |
| `PLUMBLINE_GRAPHQL_URL` | `https://graphql.mainnet.sui.io/graphql` |
| `PLUMBLINE_TIMEOUT_MS` | `8000` |
| `PORT` / `HOST` (HTTP mode) | `8081` / `127.0.0.1` |

## How it compares

Plumbline only reads data. Trading MCPs for DeepBook build transactions and may hold keys. Broad Sui analytics MCPs cover many protocols. Plumbline goes deep on DeepBook market data: depth bands around mid, live on-chain fees, OHLCV and pool-name suggestions. You can give it to any agent without risk to funds.

Data sources: books, trades, volume and candles come from the public DeepBook indexer. Fees and pool parameters come from the live Pool object via Sui GraphQL.

## Optional: pay-per-call (off by default)

The stdio package is always free. The [hosted endpoint](#hosted-endpoint-remote-nothing-to-install) meters calls (100 free per day, then 0.002 USDC per call). A **self-hosted HTTP** operator can choose to meter calls too, for example 100 free calls per day and then 0.002 USDC per call, paid in USDC on Sui. Metering is disabled unless `PLUMBLINE_PAYMENTS=1` is set. The server is receive-only and never holds keys. The full design and security model are in [docs/PAYMENTS.md](docs/PAYMENTS.md).

## Build from source

```bash
git clone https://github.com/SajanMelcher/plumbline-mcp.git
cd plumbline-mcp
npm install && npm run build
node dist/index.js            # stdio; add --http for HTTP
```

## Development

```bash
npm test            # live tests against the public indexer (SUI_USDC); needs network
npm run smoke       # spawns the server over stdio and calls every tool via the MCP client
npm run smoke:http  # same over streamable HTTP
npm run inspector   # MCP Inspector UI
npm run payments:testnet  # Sui testnet end-to-end with a throwaway payer (needs testnet SUI + USDC)
npm run pack:mcpb   # MCPB bundle at build/plumbline.mcpb, validated with mcpb + a Smithery payload check (publishes nothing)
```

## Notes and limits

- The public indexer serves at most about 100 price levels per side. When a depth band reaches past that, the response marks it `truncated: true`, and the value is a lower bound.
- `list_pools` parameters come from indexer metadata. `get_pool_params` reads the live on-chain Pool object, so it is authoritative when tick sizes or fees change through governance.
- Fees are DeepBook fixed-point values (1e9 scale), converted to pct and bps.
- No margin, balance-manager or wallet-specific endpoints are exposed.

## Independence and name

Plumbline is named after a plumb line, the weighted cord used to measure depth and true vertical. Other candidates were *Sounding* and *Tidemark*. Plumbline is an independent community project. It is not affiliated with Mysten Labs, the Sui Foundation or DeepBook.

## License

MIT. See [LICENSE](./LICENSE).

## Store and desk tools (v0.3.1, preview)

Four extra tools let an agent find, buy and join without a human checkout. They are free (not metered).

| Tool | What it does |
|---|---|
| `list_templates` | Templates, prices in Sui USDC, licence and the buying flow (from `thespicemelange.org/store/catalog.json`) |
| `create_template_order` | Creates a store order and returns the payee, the exact amount and a private order token. Nothing is charged. A few orders per client per hour. |
| `check_template_order` | With your payment digest: verifies the payment on-chain and returns the download link. Without it: returns the order status. |
| `get_desk_rhythm` | The desk's weekly rhythm, with the ed25519 signature checked against the pinned release key. If the check fails, the call fails. Guidance only. |

You pay from your own wallet. The connector never holds keys or funds. Your order token goes only to `https://thespicemelange.org` (pinned), in a header, and is never stored. All sales are final. Not financial advice.

Safety details for the store tools:
- **Pinned store:** they talk only to `https://thespicemelange.org`. A preview store needs both `PLUMBLINE_STORE_URL` and `PLUMBLINE_ALLOW_PREVIEW_STORE=1`, for testing only.
- **Payee check:** `create_template_order` reads the signed `templates/versions.json`, checked against the pinned release key. It refuses any order whose payee differs from the payee published there, or from the connector's own pin. Until the payee is published, the reply says `payeeVerified: false`: show the full address to your owner and get an explicit yes before paying.

**Order limits (hosted).** Each client (IPv4 address, or IPv6 /48) gets 3 new orders per hour and at most 2 unpaid orders open at once. The whole server allows 60 per hour and 15 open unpaid. These counters live in memory and reset when the server restarts. The store also enforces its own hourly limits, which persist in its KV: the hosted connector sends a store key and a hashed client id (never the IP), so the store limits each forwarded client separately instead of treating the connector's shared IP as one client. Unpaid orders expire after the store's 30-minute payment window.
