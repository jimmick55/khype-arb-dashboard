# kHYPE:HYPE Arbitrage Dashboard (v2)

Real-time tracker for the kHYPE → HYPE redemption arbitrage on HyperEVM.

Buy kHYPE below its redemption rate on a DEX, unstake it through Kinetiq, receive HYPE after the cooldown. This dashboard quotes both legs live and annualizes the spread.

## What changed vs the original dashboard

| | v1 (old) | v2 (this) |
|---|---|---|
| Withdrawal fee | 0.1% applied on redeem | **None — fee removed** |
| Cooldown | 8.5 days | 8.5 days (unchanged) |
| Redeem value | `kHYPE × rate × 0.999` | `kHYPE × rate` |
| Trade sizes | $1K | $1K / $10K / $50K / $100K |

APY formula: `((redeemValue / hypeIn) − 1) × (365 / 8.5) × 100`

## Data sources (all client-side, no backend / API keys)

- **Redemption rate** — `StakingAccountant.kHYPEToHYPE(1e18)` at
  `0x9209648Ec9D448EF57116B73A2f081835643dc7A` via HyperEVM RPC
  (`rpc.hyperliquid.xyz/evm`, with fallbacks). Selector `0x759bc2fc`.
- **DEX buy quotes** — KyberSwap Aggregator API, chain `hyperevm`
  (`aggregator-api.kyberswap.com/hyperevm/api/v1/routes`), native HYPE → kHYPE
  (`0xfD739d4e423301CE9385c1fb8850539D657C296D`), falls back to WHYPE
  (`0x5555...5555`) if native routing fails.
- **HYPE/USD price** — derived from the Kyber route's `amountInUsd`.

Snapshots are taken every 60s and stored in the browser (localStorage, capped
at 3,000 points) so charts persist across visits. No server, no database.

## Deploy to Vercel

```bash
npm i -g vercel
vercel deploy --prod
```

Or push this folder to a GitHub repo and import it in the Vercel dashboard —
it's a static site, no build step or framework preset needed (framework: "Other").

## Local preview

```bash
npx serve .
# or
python3 -m http.server 8000
```

## Notes

- History only accumulates while a browser has the page open. If you want
  continuous 24/7 history like a hosted service, add a Vercel Cron + KV
  (or Upstash) snapshot job and read history from an `/api/history` endpoint.
- Contract addresses from https://kinetiq.xyz/docs/contracts-and-audits
  (last verified July 2026). If Kinetiq migrates contracts, update `CONFIG`
  at the top of `index.html`.
