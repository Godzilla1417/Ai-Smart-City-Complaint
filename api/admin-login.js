const { createHmac, timingSafeEqual } = require('node:crypto');

function matchesKey(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  const expected = process.env.ADMIN_ACCESS_KEY;
  if (!expected) return res.status(503).json({ error: 'Admin access is not configured on this deployment.' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!matchesKey(body.key, expected)) return res.status(401).json({ error: 'That access key is not recognized.' });
  const expiry = String(Date.now() + 12 * 60 * 60 * 1000);
  const payload = Buffer.from(expiry).toString('base64url');
  const signature = createHmac('sha256', expected).update(payload).digest('base64url');
  return res.status(200).json({ ok: true, token: `${payload}.${signature}` });
};
