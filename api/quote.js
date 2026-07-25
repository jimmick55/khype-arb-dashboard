/* Server-side proxy for Enso Route API.
   Hides the ENSO_API_KEY and adds HYPE/USD pricing (Enso doesn't
   return amountInUsd in route responses, so we fetch price separately). */

const CHAIN_ID = 999;
const WHYPE = '0x5555555555555555555555555555555555555555';
const ENSO_ROUTE = 'https://api.enso.build/api/v1/shortcuts/route';
const ENSO_PRICE = `https://api.enso.build/api/v1/prices/${CHAIN_ID}/${WHYPE}`;
const FROM_ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'; // any valid address

let priceCache = { value: null, ts: 0 };
const PRICE_TTL = 60_000; // 1 min

async function getHypePrice(apiKey) {
  const now = Date.now();
  if (priceCache.value !== null && now - priceCache.ts < PRICE_TTL)
    return priceCache.value;
  const r = await fetch(ENSO_PRICE, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!r.ok) throw new Error(`Enso price HTTP ${r.status}`);
  const j = await r.json();
  const price = j.price ?? j.data?.price ?? null;
  if (price == null) throw new Error('no price in Enso response');
  priceCache = { value: price, ts: now };
  return price;
}

module.exports = async (req, res) => {
  const apiKey = process.env.ENSO_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ENSO_API_KEY not configured' });

  const tokenIn  = req.query.tokenIn;
  const tokenOut = req.query.tokenOut;
  const amountIn = req.query.amountIn;
  if (!tokenIn || !tokenOut || !amountIn)
    return res.status(400).json({ error: 'missing tokenIn, tokenOut, or amountIn' });

  try {
    const [routeRes, price] = await Promise.all([
      fetch(ENSO_ROUTE, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          chainId: CHAIN_ID,
          fromAddress: FROM_ADDRESS,
          routingStrategy: 'router',
          tokenIn: [tokenIn],
          tokenOut: [tokenOut],
          amountIn: [amountIn],
          slippage: '500'
        })
      }),
      getHypePrice(apiKey).catch(() => null)
    ]);

    if (!routeRes.ok) {
      const body = await routeRes.text();
      return res.status(routeRes.status).json({ error: `Enso HTTP ${routeRes.status}: ${body}` });
    }

    const route = await routeRes.json();
    const amountOut = route.amountOut;
    if (!amountOut) return res.status(502).json({ error: 'no amountOut in Enso response' });

    const amountInUsd = price ? +(price * (Number(amountIn) / 1e18)).toFixed(4) : null;

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json({ amountOut, amountInUsd });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
