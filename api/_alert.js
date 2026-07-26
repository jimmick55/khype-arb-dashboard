/* Telegram alerting for /api/snapshot — all four LSTs.

   Per token: fires ONCE when its annualized yield crosses above the threshold,
   then stays quiet until it falls back below the re-arm level (hysteresis).
   All alert state lives in ONE Redis key, so watching 4 tokens still costs
   exactly 2 Upstash commands per cron run.

   kHYPE is read from the snapshot you already took (free). The other three
   cost 1 Enso quote each per run.

   Env vars:
     TELEGRAM_BOT_TOKEN     from @BotFather                        (required)
     TELEGRAM_CHAT_ID       your user/group/channel id             (required)
     ALERT_TOKENS           default "kHYPE,kmHYPE,vkHYPE,LHYPE"
     ALERT_APY_PCT          fire above this,   default 8
     ALERT_REARM_PCT        re-arm below this, default 6
     ALERT_SIZE_HYPE        trade size,        default 1000
     ALERT_MAX_AGE_H        re-ping if still hot after N hours, default 0 (off)
     DASHBOARD_URL          optional link in the message

   Per-token overrides (suffix = symbol, uppercased):
     ALERT_APY_PCT_KHYPE, ALERT_APY_PCT_KMHYPE,
     ALERT_APY_PCT_VKHYPE, ALERT_APY_PCT_LHYPE   (same for ALERT_REARM_PCT_*)

   Underscore prefix = not exposed as a route by Vercel.
*/

const { CONFIG, redis, surveyTokens } = require('./_lib');

const STATE_KEY = 'arb:alert:state';
const num = (v, d) => (v == null || v === '' || isNaN(Number(v)) ? d : Number(v));

const DEFAULTS = {
  THRESHOLD: num(process.env.ALERT_APY_PCT, 8),
  REARM: num(process.env.ALERT_REARM_PCT, 6),
  SIZE: num(process.env.ALERT_SIZE_HYPE, 1000),
  MAX_AGE_MS: num(process.env.ALERT_MAX_AGE_H, 0) * 3600_000,
  URL: process.env.DASHBOARD_URL || ''
};

const WATCHED = (process.env.ALERT_TOKENS || CONFIG.TOKENS.map(t => t.sym).join(','))
  .split(',').map(s => s.trim()).filter(Boolean);

const isWatched = sym => WATCHED.some(w => w.toLowerCase() === sym.toLowerCase());

function thresholdsFor(sym) {
  const k = sym.toUpperCase();
  return {
    threshold: num(process.env[`ALERT_APY_PCT_${k}`], DEFAULTS.THRESHOLD),
    rearm: num(process.env[`ALERT_REARM_PCT_${k}`], DEFAULTS.REARM)
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.description || `telegram HTTP ${r.status}`);
  return j;
}

/* Pull the kHYPE reading out of the snapshot instead of re-quoting it.
   snap.q entries are [sizeHype, buyRate, apy]. */
function khypeFromSnapshot(snap, size) {
  const token = CONFIG.TOKENS.find(t => t.sym === 'kHYPE');
  const usable = (snap.q || []).filter(row => row[2] != null);
  if (!usable.length) return { token, error: 'no usable quote in snapshot' };
  const row = size ? usable.find(r => r[0] === size)
                   : usable.reduce((best, r) => (r[2] > best[2] ? r : best));
  if (!row) return { token, error: `no quote at size ${size}` };
  const [, buyRate, annualized] = row;
  return {
    token, rate: snap.r, buyRate, annualized,
    profitPct: annualized / (365 / token.cooldown)
  };
}

async function readState() {
  try {
    const raw = await redis(['GET', STATE_KEY]);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function fireMessage(sym, r, size, threshold) {
  const t = r.token;
  return `🟢 <b>${esc(sym)} arb ${r.annualized.toFixed(2)}% ${t.yieldLabel}</b>\n` +
         `above your ${threshold}% threshold\n\n` +
         `Size: <b>${size.toLocaleString()} ${esc(t.unit)}</b>\n` +
         `Buy rate: <code>${r.buyRate.toFixed(6)}</code> ${esc(t.unit)}/${esc(sym)}\n` +
         `Redeem rate: <code>${r.rate.toFixed(6)}</code>\n` +
         `Spread: <b>${r.profitPct.toFixed(3)}%</b> over ${t.cooldown}d cooldown` +
         (t.fee ? ` · ${(t.fee * 100).toFixed(2)}% fee netted` : '') +
         (t.link ? `\n\n${esc(t.link)}` : '') +
         (DEFAULTS.URL ? `\n${esc(DEFAULTS.URL)}` : '');
}

async function maybeAlert(snap) {
  const size = DEFAULTS.SIZE;
  const now = Date.now();

  // kHYPE comes free from the snapshot; quote the rest once each.
  const readings = {};
  if (isWatched('kHYPE')) readings.kHYPE = khypeFromSnapshot(snap, size);

  const others = CONFIG.TOKENS
    .filter(t => t.sym !== 'kHYPE' && isWatched(t.sym))
    .map(t => t.sym);

  if (others.length) {
    const surveyed = await surveyTokens(size, {
      skip: CONFIG.TOKENS.map(t => t.sym).filter(s => !others.includes(s))
    });
    Object.assign(readings, surveyed);
  }

  const state = await readState();
  const results = [];
  let dirty = false;

  for (const [sym, r] of Object.entries(readings)) {
    if (r.error || r.annualized == null || !isFinite(r.annualized)) {
      results.push({ sym, sent: false, reason: r.error || 'no reading' });
      continue;
    }

    const { threshold, rearm } = thresholdsFor(sym);
    const prev = state[sym] || { firing: false };
    const apy = r.annualized;

    // crossed up
    if (apy >= threshold && !prev.firing) {
      await sendTelegram(fireMessage(sym, r, size, threshold));
      state[sym] = { firing: true, since: now, peak: apy, lastPing: now };
      dirty = true;
      results.push({ sym, sent: true, kind: 'cross-up', apy });
      continue;
    }

    // still hot — optional periodic reminder
    if (apy >= threshold && prev.firing) {
      const peak = Math.max(prev.peak ?? apy, apy);
      if (DEFAULTS.MAX_AGE_MS && now - (prev.lastPing ?? prev.since ?? now) >= DEFAULTS.MAX_AGE_MS) {
        await sendTelegram(
          `⏳ <b>${esc(sym)} still ${apy.toFixed(2)}%</b> at ${size.toLocaleString()} ${esc(r.token.unit)} ` +
          `(peak ${peak.toFixed(2)}%, open ${((now - prev.since) / 3600_000).toFixed(1)}h)`
        );
        state[sym] = { ...prev, peak, lastPing: now };
        dirty = true;
        results.push({ sym, sent: true, kind: 'reminder', apy });
        continue;
      }
      if (peak !== prev.peak) { state[sym] = { ...prev, peak }; dirty = true; }
      results.push({ sym, sent: false, reason: 'already firing', apy });
      continue;
    }

    // dropped below re-arm
    if (apy < rearm && prev.firing) {
      await sendTelegram(
        `⚪️ <b>${esc(sym)}</b> back to ${apy.toFixed(2)}% — alert re-armed ` +
        `(peak was ${(prev.peak ?? apy).toFixed(2)}%)`
      );
      state[sym] = { firing: false, closedAt: now };
      dirty = true;
      results.push({ sym, sent: true, kind: 'cross-down', apy });
      continue;
    }

    results.push({ sym, sent: false, reason: 'no change', apy });
  }

  if (dirty) await redis(['SET', STATE_KEY, JSON.stringify(state)]);
  return { size, results };
}

module.exports = { maybeAlert, sendTelegram, WATCHED };
