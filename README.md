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

Plumbline is free by default. An operator of a **hosted HTTP** deployment can opt in to metering, paid in **USDC on Sui**. The flow is x402-style (scheme `sui-challenge`) and uses a read-only receipt check instead of a facilitator:

1. Each client gets a free daily allowance.
2. After that, a tool call returns an x402-style `PaymentRequired` result (`x402Version: 2`, network `sui:testnet` or `sui:mainnet`, the Circle USDC coin type, `payTo`) with a **challenge**: a private `paymentToken` and a **unique exact amount** such as `0.010437` USDC.
3. The client sends **exactly** that amount to `payTo` in one transaction, from any wallet (self-custody, zkLogin, multisig or an exchange withdrawal).
4. The client retries with `payment_token` and `payment_tx` (the digest); the x402 form `_meta["x402/payment"] = {"token": "...", "digest": "..."}` also works. Plumbline checks through Sui GraphQL that the transaction succeeded, the coin type is pinned USDC, the net credit to `payTo` **equals** the challenge amount, the transaction falls inside the challenge window, and neither the digest nor the challenge was used before.
5. The token now holds prepaid calls (amount / price, e.g. 5 calls). Later calls pass only `payment_token`.

Security model:
- **Receive-only.** The server needs only `PAYTO_ADDRESS`. It never reads, stores or requires a private key; there is no facilitator or custody.
- **No front-running.** A digest is public but the token is not. Someone who copies a payer's digest has to present it with their own challenge, whose amount differs, so it is rejected. Amounts are never shared by open challenges and are not reissued until long after a window closes; the payment must also be newer than its challenge.
- **Replay-safe across restarts.** `PLUMBLINE_STATE_FILE` persists used digests, open challenges and credits (atomic write, mode 0600, tokens stored only as hashes, payTo stored only as a hash). Mainnet refuses to start without it, and a corrupt or mismatched state file stops startup instead of silently starting empty.
- **Pinned asset and chain.** Mainnet accepts only Circle native USDC (`0xdba3…e7::usdc::USDC`). The test-asset override is refused on mainnet. Before verifying, the server checks that the GraphQL endpoint reports the expected Sui chain identifier.
- **Exact integer math.** Amounts are parsed from decimal strings to integer atomic units with BigInt; there is no floating point.
- **DoS limits.** An unknown or forged token is rejected before any network call. Each token gets at most one verification per 2 s and 20 total. Verifications are capped globally (4 concurrent), not-found digests are cached briefly, and HTTP requests are rate-limited per client (120/min).
- **Free-tier identity** is the client IP. IPv6 is bucketed by /64. `X-Forwarded-For` is ignored unless `PLUMBLINE_TRUST_PROXY=1`, and then only its rightmost (proxy-appended) entry counts. Behind Fly.io use `PLUMBLINE_CLIENT_IP_HEADER=fly-client-ip`. Paid credits never depend on IP.
- Logs never contain tokens, keys or the full `payTo` (masked as `0x1234…abcd`). Calls that fail are refunded. `get_indexer_status` is always free.

```bash
PLUMBLINE_PAYMENTS=1 \
PAYTO_ADDRESS=0xPAYTO_SUI_ADDRESS_PLACEHOLDER \
PLUMBLINE_SUI_NETWORK=testnet \
PLUMBLINE_STATE_FILE=./plumbline-state.json \
node dist/index.js --http
```

| Env var | Default | Notes |
|---|---|---|
| `PLUMBLINE_PAYMENTS` | off | `1` enables metering |
| `PAYTO_ADDRESS` | (none) | Receive-only Sui address (0x + 64 hex); the placeholder is rejected |
| `PLUMBLINE_SUI_NETWORK` | `testnet` | `mainnet` also needs `PLUMBLINE_PAYMENTS_ALLOW_MAINNET=1` |
| `PLUMBLINE_STATE_FILE` | (memory) | Payment state file on a persistent disk; **required on mainnet** |
| `PLUMBLINE_PRICE_USDC` | `0.002` | Per call after the free tier |
| `PLUMBLINE_MIN_PAYMENT_USDC` | `0.01` | Base of each challenge amount; at least 0.01 on mainnet (common exchange deposit minimum) |
| `PLUMBLINE_AMOUNT_TAG_RANGE` | `999` | Unique tag in atomic units added to the base (0.010001 to 0.010999); also the number of challenges that can be open at once |
| `PLUMBLINE_FREE_CALLS_PER_DAY` | `100` | Per client per UTC day |
| `PLUMBLINE_FREE_CALLS_GLOBAL_PER_DAY` | `0` (unlimited) | Global cap on free calls per day |
| `PLUMBLINE_PAYMENT_MAX_AGE_SEC` | `900` | Challenge window (60 to 3600) |
| `PLUMBLINE_REDEEM_GRACE_SEC` | `600` | Extra time after the window to submit the digest |
| `PLUMBLINE_CLOCK_SKEW_SEC` | `60` | Tolerance between chain time and server time (0 to 300) |
| `PLUMBLINE_MAX_OPEN_CHALLENGES` | `3` | Open challenges per client |
| `PLUMBLINE_MAX_CONCURRENT_VERIFICATIONS` | `4` | Concurrent GraphQL verifications |
| `PLUMBLINE_CREDIT_TTL_DAYS` | `90` | Unused prepaid calls expire after this |
| `PLUMBLINE_TRUST_PROXY` | off | Use the rightmost `X-Forwarded-For` entry |
| `PLUMBLINE_CLIENT_IP_HEADER` | (none) | Single-value client-IP header set by your edge (e.g. `fly-client-ip`) |
| `PLUMBLINE_RATE_LIMIT_PER_MIN` | `120` | HTTP requests per client per minute (`0` disables) |

USDC coin types come from [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses). Mainnet: `0xdba3…e7::usdc::USDC`. Testnet: `0xa1ec…29::usdc::USDC`. Hosting notes: [deploy/DEPLOY.md](deploy/DEPLOY.md).

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
