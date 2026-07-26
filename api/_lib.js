/* Shared logic for /api/snapshot and /api/history.

   Snapshots still track kHYPE ONLY (charts are kHYPE-only by design, and this
   keeps Redis storage tiny). The multi-token helpers added below are used for
   ALERTING only — they read redemption rates on-chain and take a single quote
   per token, so they cost 3 extra Enso calls per cron run rather than 15.

   Underscore prefix = not exposed as a route by Vercel. */

const CONFIG = {
  COOLDOWN_DAYS: 8.5, // kHYPE
  SIZES_HYPE: [100, 1000, 2000, 5000, 10000],
  KHYPE: '0xfD739d4e423301CE9385c1fb8850539D657C296D',
  STAKING_ACCOUNTANT: '0x9209648Ec9D448EF57116B73A2f081835643dc7A',
  KMHYPE_STAKING_ACCOUNTANT: '0x5901e744759561C63309865Ef8822aBb041655E2', // fallback only
  KMHYPE_EXCHANGE_ROUTER: '0x6AB31532382Ba5cD5E8b5D343Cf5995906bb8DD8',
  KMHYPE_EXCHANGE_MANAGER: '0x4ef8bBaceE867eFd6Faa684B30ecD12DF74C4A48',
  NATIVE: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WHYPE: '0x5555555555555555555555555555555555555555',
  ZERO: '0x0000000000000000000000000000000000000000',
  RPCS: [
    'https://rpc.hyperliquid.xyz/evm',
    'https://rpc.hypurrscan.io',
    'https://hyperliquid.drpc.org'
  ],
  KYBER: 'https://aggregator-api.kyberswap.com/hyperevm/api/v1/routes', // kept as fallback
  ENSO_ROUTE: 'https://api.enso.build/api/v1/shortcuts/route',
  ENSO_PRICE: 'https://api.enso.build/api/v1/prices/999/0x5555555555555555555555555555555555555555',
  FROM_ADDRESS: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045',

  // selectors (mirrors index.html)
  SEL_KHYPE_TO_HYPE: '0x759bc2fc', // kHYPEToHYPE(uint256)
  SEL_EX_LST_TO_OUT: '0xa618ad3f', // exLstToTokenOut(address,address,uint256)
  SEL_HOOK:          '0x7f5a7c7b', // hook()       — BoringVault transfer hook = Teller
  SEL_ACCOUNTANT:    '0x4fb3ccc5', // accountant() — on the Teller
  SEL_GET_RATE:      '0x679aefce', // getRate()    — on the Accountant
  SEL_BASE:          '0x5001f3b5', // base()       — Accountant base asset

  LIST_KEY: 'khype:snaps',
  MAX_SNAPSHOTS: 6000,

  /* Mirror of CONFIG.TOKENS in index.html. Keep the two in sync.
     unit = the asset you pay in and get back at redemption. */
  TOKENS: [
    {
      sym: 'kHYPE', addr: '0xfD739d4e423301CE9385c1fb8850539D657C296D',
      unit: 'HYPE', cooldown: 8.5, source: 'kinetiq', yieldLabel: 'APY',
      link: 'https://kinetiq.xyz/stake-hype?unstake=true'
    },
    {
      sym: 'kmHYPE', addr: '0x360C140E5344A1A0593D44B4ea6Fc7C3DAf0C473',
      unit: 'HYPE', cooldown: 8.5, source: 'kinetiq-markets', yieldLabel: 'APY',
      fee: 0.001, // 0.10% withdrawal fee, paid in kmHYPE
      link: 'https://kinetiq.xyz/docs/kmhype'
    },
    {
      sym: 'vkHYPE', addr: '0x9ba2edc44e0a4632eb4723e81d4142353e1bb160',
      unit: 'kHYPE', cooldown: 5, source: 'veda', yieldLabel: 'APR',
      accountant: null, // auto-discovered
      link: 'https://kinetiq.xyz/earn/kinetiq-earn'
    },
    {
      sym: 'LHYPE', addr: '0x5748ae796AE46A4F1348a1693de4b50560485562',
      unit: 'HYPE', cooldown: 3, source: 'veda', yieldLabel: 'APY',
      accountant: '0xcE621a3CA6F72706678cFF0572ae8d15e5F001c3',
      link: 'https://www.loopedhype.com'
    }
  ]
};

const fromWei = s => Number(BigInt(s)) / 1e18;
const toWeiDec = amount => (BigInt(amount) * 10n ** 18n).toString();
const addrEq = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const wordToAddr = hex => '0x' + hex.replace(/^0x/, '').slice(-40);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/* ---------- redemption rates ---------- */

async function fetchKinetiqRate(accountant) {
  const oneToken = '0000000000000000000000000000000000000000000000000de0b6b3a7640000';
  const res = await rpcCall(accountant, CONFIG.SEL_KHYPE_TO_HYPE + oneToken);
  return fromWei(res);
}

const fetchRedemptionRate = () => fetchKinetiqRate(CONFIG.STAKING_ACCOUNTANT); // kHYPE

/* kmHYPE — Markets ExchangeRouter.exLstToTokenOut(manager, HYPE, 1e18).
   Native-HYPE representation isn't documented: try 0xEeee…, 0x0000…, WHYPE. */
async function fetchKmHypeRate() {
  const pad = a => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const one = (10n ** 18n).toString(16).padStart(64, '0');
  const call = tokenOut => rpcCall(
    CONFIG.KMHYPE_EXCHANGE_ROUTER,
    CONFIG.SEL_EX_LST_TO_OUT + pad(CONFIG.KMHYPE_EXCHANGE_MANAGER) + pad(tokenOut) + one
  );
  for (const tokenOut of [CONFIG.NATIVE, CONFIG.ZERO, CONFIG.WHYPE]) {
    try {
      const rate = fromWei(await call(tokenOut));
      if (rate > 0) return rate;
    } catch {}
  }
  return fetchKinetiqRate(CONFIG.KMHYPE_STAKING_ACCOUNTANT);
}

/* Veda/Nucleus BoringVault. Cached per warm lambda; re-discovered on cold start. */
const _accountants = {};
async function resolveAccountant(token) {
  if (token.accountant) return token.accountant;
  if (_accountants[token.sym]) return _accountants[token.sym];
  const teller = wordToAddr(await rpcCall(token.addr, CONFIG.SEL_HOOK));
  if (addrEq(teller, CONFIG.ZERO)) throw new Error('vault hook not set');
  const acct = wordToAddr(await rpcCall(teller, CONFIG.SEL_ACCOUNTANT));
  if (addrEq(acct, CONFIG.ZERO)) throw new Error('accountant not found on teller');
  _accountants[token.sym] = acct;
  return acct;
}

async function fetchVedaRate(token, khypeRate) {
  const acct = await resolveAccountant(token);
  const raw = fromWei(await rpcCall(acct, CONFIG.SEL_GET_RATE));
  const base = wordToAddr(await rpcCall(acct, CONFIG.SEL_BASE));
  const baseUnit = addrEq(base, CONFIG.WHYPE) ? 'HYPE'
                 : addrEq(base, CONFIG.KHYPE) ? 'kHYPE'
                 : null;
  if (!baseUnit) throw new Error('unsupported base asset ' + base);
  if (baseUnit === token.unit) return raw;
  return token.unit === 'HYPE' ? raw * khypeRate : raw / khypeRate;
}

async function fetchTokenRate(token, khypeRate) {
  if (token.source === 'kinetiq') return khypeRate;
  if (token.source === 'kinetiq-markets') return fetchKmHypeRate();
  return fetchVedaRate(token, khypeRate);
}

/* ---------- DEX quotes ---------- */

let _priceCache = { value: null, ts: 0 };

async function getHypePrice() {
  const now = Date.now();
  if (_priceCache.value !== null && now - _priceCache.ts < 60_000) return _priceCache.value;
  const r = await fetch(CONFIG.ENSO_PRICE, {
    headers: { Authorization: `Bearer ${process.env.ENSO_API_KEY}` }
  });
  if (!r.ok) throw new Error(`Enso price HTTP ${r.status}`);
  const j = await r.json();
  const price = j.price ?? j.data?.price ?? null;
  if (price == null) throw new Error('no price in Enso response');
  _priceCache = { value: price, ts: now };
  return price;
}

async function ensoRoute(tokenIn, tokenOut, amountInWeiDec) {
  const r = await fetch(CONFIG.ENSO_ROUTE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.ENSO_API_KEY}`
    },
    body: JSON.stringify({
      chainId: 999,
      fromAddress: CONFIG.FROM_ADDRESS,
      routingStrategy: 'router',
      tokenIn: [tokenIn],
      tokenOut: [tokenOut],
      amountIn: [amountInWeiDec],
      slippage: '500'
    })
  });
  if (!r.ok) throw new Error(`Enso HTTP ${r.status}`);
  const j = await r.json();
  if (!j.amountOut) throw new Error(j.message || 'no route');
  return { amountOut: j.amountOut, amountInUsd: null };
}

/* Original kHYPE-only quote (native → kHYPE, WHYPE fallback). Unchanged. */
async function kyberQuote(tokenOut, hypeAmount) {
  const wei = toWeiDec(hypeAmount);
  let route;
  try { route = await ensoRoute(CONFIG.NATIVE, tokenOut, wei); }
  catch { route = await ensoRoute(CONFIG.WHYPE, tokenOut, wei); }
  try {
    const price = await getHypePrice();
    route.amountInUsd = (price * hypeAmount).toFixed(4);
  } catch {}
  return route;
}

/* Unit-aware quote: kHYPE-denominated tokens (vkHYPE) are bought with kHYPE. */
async function quoteToken(token, amount) {
  const wei = toWeiDec(amount);
  if (token.unit === 'kHYPE') return ensoRoute(CONFIG.KHYPE, token.addr, wei);
  try { return await ensoRoute(CONFIG.NATIVE, token.addr, wei); }
  catch { return await ensoRoute(CONFIG.WHYPE, token.addr, wei); }
}

/* Same math as the frontend: fee is netted out of redeem value. */
function computeYield(token, size, amountOut, rate) {
  const feeMult = 1 - (token.fee || 0);
  const tokOut = fromWei(amountOut);
  const buyRate = size / tokOut;
  const redeemValue = tokOut * feeMult * rate;
  const profitPct = (redeemValue / size - 1) * 100;
  const annualized = profitPct * (365 / token.cooldown);
  return { tokOut, buyRate, redeemValue, profit: redeemValue - size, profitPct, annualized };
}

/* One quote per token at `size` — used by the alerter. kHYPE is skipped here
   when the caller already has it from the snapshot. */
async function surveyTokens(size, { skip = [] } = {}) {
  const khypeRate = await fetchRedemptionRate();
  const out = {};
  for (const token of CONFIG.TOKENS) {
    if (skip.includes(token.sym)) continue;
    try {
      const rate = await fetchTokenRate(token, khypeRate);
      const rs = await quoteToken(token, size);
      out[token.sym] = { token, rate, ...computeYield(token, size, rs.amountOut, rate) };
    } catch (e) {
      out[token.sym] = { token, error: String((e && e.message) || e) };
    }
    await sleep(300);
  }
  return out;
}

/* ---------- kHYPE snapshot (unchanged) ---------- */

async function takeSnapshot() {
  const rate = await fetchRedemptionRate();
  const q = [];
  let price = null;

  for (const hype of CONFIG.SIZES_HYPE) {
    try {
      const rs = await kyberQuote(CONFIG.KHYPE, hype);
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

module.exports = {
  CONFIG, takeSnapshot, redis,
  surveyTokens, computeYield, fetchRedemptionRate, fetchTokenRate, quoteToken
};
