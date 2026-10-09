# Deploying the hosted HTTP endpoint (prep only)

Nothing here deploys anything by itself. Run these commands only when the owner approves going live.

## Recommended: Fly.io, one always-on machine plus a 1 GB volume

| Item | Price (fly.io/docs/about/pricing, checked Oct 2026) |
| --- | --- |
| shared-cpu-1x, 256 MB, `iad`, always on | $2.19 / month |
| 1 GB volume (holds the payment state file) | $0.15 / month |
| Egress (NA/EU) | $0.02 / GB |
| **Expected total** | **about $2.35 / month** at low traffic |

Fly has no free tier for new orgs (there is a short trial), so a card is required.

```bash
cd deploy
fly apps create plumbline-mcp            # or another free name; update app = in fly.toml
fly volumes create plumbline_data --size 1 --region iad
# Payment env comes from the PRIVATE env file outside the repo. Comments are stripped; values are never printed.
grep -E '^[A-Z0-9_]+=' /path/to/private/plumbline.env | fly secrets import --stage
fly deploy --ha=false                    # exactly one machine: payment state is a local file
curl -s https://plumbline-mcp.fly.dev/health
```

Rules:
- Exactly one machine (`--ha=false`, no `fly scale count 2`). The state file is local to the volume.
- `PLUMBLINE_STATE_FILE` must live on the volume (`/data/...`). On mainnet, the server refuses to start without it.
- The free-tier identity comes from `Fly-Client-IP`, which Fly's edge sets on every request.
- Back up the volume with Fly's daily snapshots (on by default, first 10 GB free).

## Alternatives

| Host | Cheapest workable setup | Monthly | Notes |
| --- | --- | --- | --- |
| Railway | Hobby plan, 1 service + 1 GB volume | $5 minimum (usage of this size fits inside the $5 credit) | The Free plan ($1 credit) cannot keep it running all month |
| Render | Starter + 1 GB disk | $7 + $0.25 = $7.25 | The Free plan spins down after 15 min and cannot mount a disk; `render.yaml` provided |
| Cloudflare Workers | Free (100k req/day) or Paid $5 | $0 to $5 | NOT compatible as-is: needs a port from node:http + fs to the Workers runtime, with state in a SQLite Durable Object |
