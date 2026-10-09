# Optional pay-per-call in USDC on Sui (off by default)

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

USDC coin types come from [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses). Mainnet: `0xdba3…e7::usdc::USDC`. Testnet: `0xa1ec…29::usdc::USDC`. Hosting notes: [deploy/DEPLOY.md](../deploy/DEPLOY.md).

