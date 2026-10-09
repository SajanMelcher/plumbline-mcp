# Monetization options for Plumbline (recommendations only, nothing built)

Status: v1 is **free and read-only**. No paid features, payment code, keys or wallets exist in this repo. All publishing and pricing decisions need owner approval.

The demand logic comes from the research spec: list free on Smithery, use public `useCount` as the demand signal, and add a paid layer only if traffic reaches mid-tier (around 5-15k uses).

## 1. Free tier (recommended first step)
- **What:** the current 8 tools, stdio and npm, listed on Smithery.
- **Needs:** a public GitHub repo, `npm publish` (remove `"private": true`), a Smithery submission, and a light support channel (GitHub issues).
- **Cost:** $0 for stdio, because users run it locally. Upstream is the public Mysten indexer, so check its fair-use terms before driving heavy traffic.
- **Gate to go further:** useCount and GitHub stars over 4-8 weeks.

## 2. Pro tier: usage-based or $29-$129/mo
- **What could be paid:** a hosted HTTP endpoint with an SLA; higher rate limits; derived analytics such as historical depth/spread snapshots, slippage estimates for size X, cross-pool and cross-venue comparisons, alerts, and longer OHLCV history from a self-run indexer.
- **Needs:** a hosted deployment (container plus your own DeepBook indexer or a paid RPC/indexer for reliability); API-key issuance and metering; billing (Stripe, Lemon Squeezy, or Smithery/marketplace billing if available); ToS, privacy policy and a not-advice disclaimer; and monitoring.
- **Rough tiers:** Starter $29/mo (hosted, 50k calls); Pro $129/mo (500k calls plus analytics and history); overage per 1k calls.
- **Risk:** you would be competing with free public endpoints, so the value has to come from reliability and derived data, not raw passthrough.

## 3. x402-style pay-per-call in USDC on Sui (opt-in code now in repo, off by default)
- **What:** charge per tool call or per premium call (for example $0.001-$0.01) through HTTP 402 payment challenges, settled in USDC, so agents pay without accounts.
- **Status:** implemented as an opt-in `sui-digest` flow. The client pays USDC on Sui to `PAYTO_ADDRESS`, and the server verifies the digest via Sui GraphQL. There are no keys and no facilitator. See the README.
- **Needs:** the hosted HTTP transport; a **receive-only Sui address controlled by the owner**; owner sign-off on price and free tier; a mainnet opt-in; and accounting and tax handling for revenue.
- **Fit:** the spec flags x402/paid-MCP chatter at about 12.5k X posts in 7 days, and Allium's AgentHub uses this model for on-chain data.
- **Risk:** a young ecosystem, custody and treasury handling, and the possibility of payment-related regulatory questions. Use a dedicated, owner-controlled receiving wallet, never an operational or trading wallet.

## 4. Shopify (or Gumroad) digital listing
- **What:** sell a one-time "DeepBook agent data kit": a hosted-endpoint key or the self-host guide, prompt pack, example dashboards and n8n template. The MCP stays free.
- **Needs:** a store account, product copy with a clear not-advice disclaimer, a delivery mechanism (license key or download), and a refund policy.
- **Fit:** low effort if the n8n/prompt products from the spec are built anyway. Bundle it with them.
- **Risk:** low revenue per unit, and a one-time sale gives no recurring compounding.

## Recommendation
1. Ship the free listing (#1) after owner approval.
2. Watch useCount. If it reaches mid-tier, enable **Sui USDC pay-per-call on a hosted endpoint** (#3), with basic tools kept free.
3. Consider a subscription Pro (#2) only once there is a self-run indexer and derived data worth paying for.
4. Use the Shopify/Gumroad bundle (#4) as an opportunistic add-on alongside the template products.
