/* Shared logic for /api/snapshot and /api/history.
   Underscore prefix = not exposed as a route by Vercel. */

const CONFIG = {
  COOLDOWN_DAYS: 8.5,
  SIZES_HYPE: [100, 1000, 2000, 5000, 10000],
  KHYPE: '0xfD739d4e423301CE9385c1fb8850539D657C296D',
  STAKING_ACCOUNTANT: '0x9209648Ec9D448EF57116B73A2f081835643dc7A',
  NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WHYPE: '0x5555555555555555555555555555555555555555',
  RPCS: [
    'https://rpc.hyperliquid.xyz/evm',
    'https://rpc.hypurrscan.io',
    'https://hyperliquid.drpc.org'
  ],
  KYBER: 'https://aggregator-api.kyberswap.com/hyperevm/api/v1/routes',
  SEL_KHYPE_TO_HYPE: '0x759bc2fc', // keccak256("kHYPEToHYPE(uint256)")[:4]
  LIST_KEY: 'khype:snaps',
  MAX_SNAPSHOTS: 6000
};

const fromWei = s => Number(BigInt(s)) / 1e18;
const toWeiDec = hype => (BigInt(hype) * 10n ** 18n).toString();

async function rpcCall(to, data) {
  let lastErr;
  for (const url of CONFIG.RPCS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'RPC error');
      if (j.result && j.result !== '0x') return j.result;
      throw new Error('empty result');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

async function fetchRedemptionRate() {
  const oneKhype = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
  const res = await rpcCall(CONFIG.STAKING_ACCOUNTANT, CONFIG.SEL_KHYPE_TO_HYPE + oneKhype);
  return fromWei(res);
}

async function kyberRoute(tokenIn, amountInWeiDec) {
  const u = `${CONFIG.KYBER}?tokenIn=${tokenIn}&tokenOut=${CONFIG.KHYPE}&amountIn=${amountInWeiDec}&gasInclude=true`;
  const r = await fetch(u, { headers: { 'x-client-id': 'khype-arb-dashboard' } });
  if (!r.ok) throw new Error(`Kyber HTTP ${r.status}`);
  const j = await r.json();
  const rs = j && j.data && j.data.routeSummary;
  if (!rs) throw new Error((j && j.message) || 'no route');
  return rs;
}

async function kyberQuote(hypeAmount) {
  const wei = toWeiDec(hypeAmount);
  try { return await kyberRoute(CONFIG.NATIVE, wei); }
  catch { return await kyberRoute(CONFIG.WHYPE, wei); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Compact snapshot: { t, r: redeemRate, p: hypeUsd, q: [[sizeHype, buyRate, apy], ...] } */
async function takeSnapshot() {
  const rate = await fetchRedemptionRate();
  const q = [];
  let price = null;

  for (const hype of CONFIG.SIZES_HYPE) {
    try {
      const rs = await kyberQuote(hype);
      const khypeOut = fromWei(rs.amountOut);
      const buyRate = hype / khypeOut;
      const profitPct = (rate / buyRate - 1) * 100;
      const apy = profitPct * (365 / CONFIG.COOLDOWN_DAYS);
      q.push([hype, +buyRate.toFixed(8), +apy.toFixed(4)]);
      if (price === null && rs.amountInUsd) price = +(Number(rs.amountInUsd) / hype).toFixed(4);
    } catch {
      q.push([hype, null, null]);
    }
    await sleep(300);
  }

  return { t: Date.now(), r: +rate.toFixed(8), p: price, q };
}

async function redis(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not configured');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

module.exports = { CONFIG, takeSnapshot, redis };
