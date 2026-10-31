const allowedStatuses = new Set(['Submitted', 'Under Review', 'In Progress', 'Resolved']);
const allowedCategories = new Set(['Roads', 'Sanitation', 'Streetlights', 'Water', 'Public spaces', 'Other']);
const { createHmac, timingSafeEqual } = require('node:crypto');

function adminAuthorized(req) {
  const expected = process.env.ADMIN_ACCESS_KEY;
  const token = req.headers['x-admin-token'];
  if (!expected || typeof token !== 'string') return false;
  const [payload,signature,...extra]=token.split('.');
  if(!payload||!signature||extra.length)return false;
  const wanted=createHmac('sha256',expected).update(payload).digest();
  let received;
  try{received=Buffer.from(signature,'base64url')}catch{return false}
  if(received.length!==wanted.length||!timingSafeEqual(received,wanted))return false;
  const expiry=Number(Buffer.from(payload,'base64url').toString());
  return Number.isFinite(expiry)&&expiry>Date.now();
}

function dbConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Shared complaint storage is not configured.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // The legacy service_role key is a JWT; current sb_secret keys are not.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return { baseUrl: `${url.replace(/\/$/, '')}/rest/v1/complaints`, headers };
}

async function databaseRequest(path, options = {}) {
  const { baseUrl, headers } = dbConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    console.error('Supabase complaint request failed:', response.status, data);
    throw new Error('The shared complaint database rejected the request. Check its table and Vercel settings.');
  }
  return data;
}

function fromDatabase(row) {
  return {
    id: row.id,
    userId: row.user_id || 'guest',
    title: row.title,
    description: row.description,
    category: row.category,
    address: row.address || row.location || '',
    location: row.location || row.address || '',
    zone: row.zone || 'Citywide',
    latitude: row.latitude,
    longitude: row.longitude,
    status: row.status,
    department: row.department || 'City Services',
    createdAt: row.created_at
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const id = String(req.query?.id || '').trim();
      if (id) {
        const query = new URLSearchParams({
          select: 'id,title,category,location,address,zone,latitude,longitude,status,department,created_at',
          id: `eq.${id}`,
          limit: '1'
        });
        const rows = await databaseRequest(`?${query}`);
        return res.status(200).json(rows?.[0] ? fromDatabase(rows[0]) : null);
      }
      if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin access required.' });
      const rows = await databaseRequest('?select=*&order=created_at.desc');
      return res.status(200).json((rows || []).map(fromDatabase));
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const category = String(body.category || '');
      const address = String(body.address || body.location || '').trim();
      const latitude = body.latitude == null || body.latitude === '' ? null : Number(body.latitude);
      const longitude = body.longitude == null || body.longitude === '' ? null : Number(body.longitude);
      if (title.length < 5 || title.length > 100 || description.length < 15 || description.length > 5000 || !allowedCategories.has(category)) {
        return res.status(400).json({ error: 'Please provide a valid title, description, and category.' });
      }
      if (!address && (!Number.isFinite(latitude) || !Number.isFinite(longitude))) {
        return res.status(400).json({ error: 'Add an address or map location before sending.' });
      }
      const record = {
        id: String(body.id || `CF-${Math.floor(100000 + Math.random() * 900000)}`),
        user_id: String(body.userId || 'guest'),
        title,
        description,
        category,
        address,
        location: address,
        zone: String(body.zone || 'Citywide'),
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        status: 'Submitted',
        department: String(body.department || 'City Services'),
        created_at: new Date().toISOString()
      };
      const rows = await databaseRequest('?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(record)
      });
      return res.status(201).json(fromDatabase(rows[0]));
    }

    if (req.method === 'PATCH') {
      if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin access required.' });
      const id = String(req.query?.id || '').trim();
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!id) return res.status(400).json({ error: 'Complaint ID is required.' });
      const update = {};
      if (body.status !== undefined) {
        if (!allowedStatuses.has(body.status)) return res.status(400).json({ error: 'Invalid complaint status.' });
        update.status = body.status;
      }
      if (body.department !== undefined) {
        const department = String(body.department).trim();
        if (!department || department.length > 80) return res.status(400).json({ error: 'Invalid department.' });
        update.department = department;
      }
      if (!Object.keys(update).length) return res.status(400).json({ error: 'No supported fields to update.' });
      const query = new URLSearchParams({ id: `eq.${id}`, select: '*' });
      const rows = await databaseRequest(`?${query}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(update)
      });
      return rows?.[0] ? res.status(200).json(fromDatabase(rows[0])) : res.status(404).json({ error: 'Complaint not found.' });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('Complaint API failed:', error);
    return res.status(503).json({ error: error.message || 'Complaint service is unavailable.' });
  }
};
