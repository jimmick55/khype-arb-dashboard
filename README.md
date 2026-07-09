[README.md](https://github.com/user-attachments/files/29835668/README.md)
# kHYPE:HYPE Arbitrage Dashboard (v3 — 24/7 history)

Real-time tracker for the kHYPE → HYPE redemption arbitrage on HyperEVM, with
server-side snapshots so charts keep filling in even when nobody has the page open.

Buy kHYPE below its redemption rate on a DEX, unstake through Kinetiq, receive
HYPE after the cooldown. **No withdrawal fee** (removed), **8.5-day cooldown**.

APY = `((redeemValue / hypeIn) − 1) × (365 / 8.5) × 100`

## What's in v3

- Trade sizes denominated in **HYPE**: 100 / 1K / 2K / 5K / 10K HYPE
- HYPE price shown to 2 decimals (e.g. $68.42)
- **24/7 history**: `/api/snapshot` (cron-triggered) stores compact data points
  in Upstash Redis; `/api/history` serves them to the charts. Live points are
  appended client-side while your tab is open.
- Gracefully degrades: if the API/database isn't configured, it falls back to
  live-session-only mode with a notice.

## Cost: $0 (and zero AI tokens — no AI involved at all)

| Piece | Plan | Usage here | Limit |
|---|---|---|---|
| Vercel hosting + functions | Hobby (free) | 2 tiny fn calls / 5 min | well under free limits |
| Upstash Redis | Free tier | ~900 commands/day | 10,000/day |
| cron-job.org (scheduler) | Free | 1 job every 5 min | free |

A snapshot every 5 minutes ≈ 288/day. Stored compactly (~150 bytes each),
capped at 6,000 points (~3 weeks at 5-min resolution — raise `MAX_SNAPSHOTS`
in `api/_lib.js` if you want more; storage is nowhere near the free limit).

## Setup (one time, ~5 minutes)

### 1. Create the database
- Go to [console.upstash.com](https://console.upstash.com) → create a free Redis database
- Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

### 2. Deploy to Vercel
```bash
vercel deploy --prod
```
Then in the Vercel project → **Settings → Environment Variables**, add:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `CRON_SECRET` — any random string (optional but recommended; protects the snapshot endpoint)

Redeploy after adding env vars (`vercel deploy --prod` again).

### 3. Schedule the snapshots
Vercel's built-in cron on the **Hobby plan only runs once per day**, so
`vercel.json` ships with a daily schedule as a baseline. For real 5-minute
resolution, pick one:

- **Free (Hobby):** create an account at [cron-job.org](https://cron-job.org)
  and add a job hitting `https://YOUR-APP.vercel.app/api/snapshot?key=YOUR_CRON_SECRET`
  every 5 minutes.
- **Vercel Pro:** just change the schedule in `vercel.json` to `"*/5 * * * *"`
  and delete the external cron. Vercel automatically sends the `CRON_SECRET`
  as a bearer token.

### 4. Verify
- Open `https://YOUR-APP.vercel.app/api/snapshot?key=YOUR_CRON_SECRET` → should return `{"ok":true,...}`
- Open `https://YOUR-APP.vercel.app/api/history` → should return stored snapshots
- The dashboard's History card should read "Server (24/7) + live"

## Data sources

- **Redemption rate** — `StakingAccountant.kHYPEToHYPE(1e18)` at
  `0x9209648Ec9D448EF57116B73A2f081835643dc7A` via HyperEVM RPC
  (`rpc.hyperliquid.xyz/evm`, with fallbacks). Selector `0x759bc2fc`.
- **DEX buy quotes** — KyberSwap Aggregator API, chain `hyperevm`, native HYPE →
  kHYPE (`0xfD739d4e423301CE9385c1fb8850539D657C296D`), WHYPE fallback.
- **HYPE/USD** — derived from Kyber's `amountInUsd` on the 100 HYPE route.

## Project layout

```
index.html        dashboard (static, client-side live quotes + charts)
api/_lib.js       shared: RPC, Kyber, snapshot builder, Redis helper
api/snapshot.js   cron target — takes a snapshot, stores it
api/history.js    serves stored snapshots to the frontend
vercel.json       cron config (daily baseline; see step 3)
```

Contract addresses from https://kinetiq.xyz/docs/contracts-and-audits
(verified July 2026). If Kinetiq migrates contracts, update `CONFIG` in
both `api/_lib.js` and `index.html`.
