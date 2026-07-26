const { CONFIG, takeSnapshot, redis } = require('./_lib');
const { maybeAlert, sendTelegram } = require('./_alert');

module.exports = async (req, res) => {
  // Optional protection: set CRON_SECRET in Vercel env vars.
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" automatically;
  // external pingers (cron-job.org) can use /api/snapshot?key=<CRON_SECRET>.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers['authorization'] || '';
    const key = (req.query && req.query.key) || '';
    if (auth !== `Bearer ${secret}` && key !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  // /api/snapshot?key=...&test=1 → just prove Telegram is wired up correctly.
  if (req.query && req.query.test) {
    try {
      await sendTelegram('✅ Test message from the kHYPE arb dashboard.');
      return res.status(200).json({ ok: true, test: 'sent' });
    } catch (e) {
      return res.status(500).json({ error: String((e && e.message) || e) });
    }
  }

  try {
    const snap = await takeSnapshot();
    await redis(['RPUSH', CONFIG.LIST_KEY, JSON.stringify(snap)]);
    await redis(['LTRIM', CONFIG.LIST_KEY, String(-CONFIG.MAX_SNAPSHOTS), '-1']);

    // Alerting must never break snapshotting.
    let alert;
    try { alert = await maybeAlert(snap); }
    catch (e) { alert = { sent: false, error: String((e && e.message) || e) }; }

    res.status(200).json({ ok: true, snap, alert });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
