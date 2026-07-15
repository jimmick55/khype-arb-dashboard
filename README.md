[README.md](https://github.com/user-attachments/files/29857129/README.md)
# HYPE LST Arbitrage Dashboard (v6 — kHYPE · kmHYPE · vkHYPE · LHYPE)

Real-time tracker for HYPE liquid-staking-token redemption arbitrage on HyperEVM:
buy the LST below its redemption rate on a DEX, redeem/unstake through the
protocol, receive HYPE after the cooldown.

| Token | Protocol | Cooldown | Fee | Coverage |
|---|---|---|---|---|
| kHYPE | Kinetiq | 8.5 days | none (removed) | live quotes + 24/7 charts |
| kmHYPE | Markets by Kinetiq | ~8.5 days | 0.10% (in kmHYPE) | live quotes only |
| vkHYPE | Kinetiq Earn (Veda vault) | 5 days | no exit fee | live quotes only |
| LHYPE | loopedHYPE (Nucleus vault) | 3 days | — | live quotes only |

APY per token = `((redeemValue / hypeIn) − 1) × (365 / cooldown) × 100` —
each token annualizes over its own cooldown. Trade sizes quoted:
100 / 1K / 2K / 5K / 10K HYPE.

## Redemption-rate sources (all on-chain via HyperEVM RPC)

- **kHYPE** — `StakingAccountant.kHYPEToHYPE(1e18)` at
  `0x9209648Ec9D448EF57116B73A2f081835643dc7A` (selector `0x759bc2fc`).
- **kmHYPE** — Markets by Kinetiq uses the same LST `StakingAccountant`
  codebase, deployed at `0x5901e744759561C63309865Ef8822aBb041655E2`, so the
  same `kHYPEToHYPE(1e18)` call (selector `0x759bc2fc`) returns the
  kmHYPE→HYPE rate. The 0.10% withdrawal fee (paid in kmHYPE) is netted out
  of the redeem-value math; withdrawals take ~8.5 days when the pool holds
  >500K HYPE, otherwise they queue (per kinetiq.xyz/docs/kmhype).
- **LHYPE** — Nucleus `Accountant.getRate()` at
  `0xcE621a3CA6F72706678cFF0572ae8d15e5F001c3` (from loopedHYPE's official
  security docs), converted to HYPE via the accountant's `base()` asset.
- **vkHYPE** — the Veda accountant address isn't published, so it's
  **auto-discovered on-chain** each session: `vault.hook()` (`0x7f5a7c7b`,
  the BoringVault transfer hook = the Teller) → `teller.accountant()`
  (`0x4fb3ccc5`) → `accountant.getRate()` (`0x679aefce`). The accountant's
  `base()` (`0x5001f3b5`) determines conversion: WHYPE base is used directly,
  kHYPE base is multiplied by the kHYPE→HYPE rate. If discovery ever fails
  (e.g. Veda changes the hook), the vkHYPE section shows a clear error
  instead of wrong numbers — you can then pin the address in
  `CONFIG.TOKENS[].accountant` in `index.html`.

DEX buy quotes come from the KyberSwap Aggregator (native HYPE → token,
WHYPE fallback). HYPE/USD is derived from Kyber's `amountInUsd`.

Token addresses: kHYPE `0xfD739d4e423301CE9385c1fb8850539D657C296D`,
kmHYPE `0x360C140E5344A1A0593D44B4ea6Fc7C3DAf0C473`,
vkHYPE `0x9ba2edc44e0a4632eb4723e81d4142353e1bb160`,
LHYPE `0x5748ae796AE46A4F1348a1693de4b50560485562`.

## 24/7 history (kHYPE charts)

`/api/snapshot` (cron-triggered) stores compact kHYPE data points in Upstash
Redis; `/api/history` serves them to the charts. kmHYPE/vkHYPE/LHYPE are live-only
by design, so they're not snapshotted (keeps storage tiny). Costs $0 and zero
AI tokens: Vercel Hobby (free) + Upstash free tier (~900 of 10,000 daily
commands at 5-min snapshots) + cron-job.org (free).

## Setup (~5 minutes)

1. **Database** — [console.upstash.com](https://console.upstash.com) → create
   free Redis DB → copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. **Deploy** — `vercel deploy --prod`, then in Vercel → Settings →
   Environment Variables add the two Upstash vars plus `CRON_SECRET` (any
   random string). Redeploy.
3. **Schedule** — Vercel's built-in cron on Hobby only runs daily (that's the
   baseline in `vercel.json`). For 5-minute resolution: free option is a
   [cron-job.org](https://cron-job.org) job hitting
   `https://YOUR-APP.vercel.app/api/snapshot?key=YOUR_CRON_SECRET` every
   5 minutes; on Vercel Pro just change `vercel.json` to `"*/5 * * * *"`.
4. **Verify** — `/api/snapshot?key=...` returns `{"ok":true}`, `/api/history`
   returns snapshots, and the History card reads "Server (24/7) + live".

## Project layout

```
index.html        dashboard (client-side live quotes for all 4 tokens + kHYPE charts)
api/_lib.js       shared: RPC, Kyber, kHYPE snapshot builder, Redis helper
api/snapshot.js   cron target — takes a kHYPE snapshot, stores it
api/history.js    serves stored snapshots to the frontend
vercel.json       cron config (daily baseline; see step 3)
```

## Notes

- Cooldowns are configured per token in `CONFIG.TOKENS` (kHYPE 8.5d,
  kmHYPE 8.5d, vkHYPE 5d, LHYPE 3d per your spec — Kinetiq Earn officially quotes
  "~3–5 days, max 10" and vault withdrawals depend on solver liquidity,
  so treat the vault APYs as estimates).
- Withdrawal fees are configured per token via the optional `fee` field in
  `CONFIG.TOKENS` (fraction of the LST taken at withdrawal — currently only
  kmHYPE at `0.001` = 0.10%). The fee is netted out of redeem value, profit,
  and APY automatically.
- Contract addresses verified July 2026 from kinetiq.xyz/docs and
  docs.loopingcollective.org. If a protocol migrates, update `CONFIG`
  in `index.html` (and `api/_lib.js` for kHYPE).
