const { CONFIG, redis } = require('./_lib');

module.exports = async (req, res) => {
  try {
    const raw = await redis(['LRANGE', CONFIG.LIST_KEY, '0', '-1']);
    const snaps = (raw || [])
      .map(s => { try { return JSON.parse(s); } catch { return null; } })
      .filter(Boolean);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({ snaps });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
