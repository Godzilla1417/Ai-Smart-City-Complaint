const allowedStatuses = new Set(['Submitted', 'Under Review', 'In Progress', 'Awaiting Resolution Evidence']);
const allowedCategories = new Set(['Roads', 'Sanitation', 'Streetlights', 'Water', 'Public spaces', 'Other']);
const { createHmac, timingSafeEqual } = require('node:crypto');
const imageBucket = 'civic-complaint-images';

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
  // Vercel values pasted from dashboards may include surrounding whitespace/newlines.
  // Trim those before using the value in an HTTP header.
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Shared complaint storage is not configured.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // The legacy service_role key is a JWT; current sb_secret keys are not.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return { baseUrl: `${url.replace(/\/$/, '')}/rest/v1/complaints`, headers };
}

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Shared complaint storage is not configured.');
  const headers = { apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return { url: url.replace(/\/$/, ''), headers };
}

async function storageRequest(path, options = {}) {
  const { url, headers } = storageConfig();
  const response = await fetch(`${url}/storage/v1${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    console.error('Supabase image storage request failed:', response.status, data);
    throw new Error('Image storage is not ready. Run the storage setup SQL in Supabase, then try again.');
  }
  return data;
}

async function signImage(path) {
  if (!path) return null;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const data = await storageRequest(`/object/sign/${imageBucket}/${encodedPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 900 })
  });
  return data?.signedURL ? `${storageConfig().url}/storage/v1${data.signedURL}` : null;
}

async function saveImage(dataUrl, complaintId) {
  if (!dataUrl) return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw new Error('Choose a JPEG, PNG, or WebP image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 1_500_000) throw new Error('Image must be smaller than 1.5 MB after compression.');
  const mime = match[1];
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const path = `${complaintId}/${require('node:crypto').randomBytes(12).toString('hex')}.${extension}`;
  await storageRequest(`/object/${imageBucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { 'Content-Type': mime, 'x-upsert': 'false', 'Cache-Control': '3600' },
    body: bytes
  });
  return path;
}

async function signedImageUrl(path) {
  if (!path) return null;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const data = await storageRequest(`/object/sign/civic-complaint-images/${encodedPath}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 900 })
  });
  const { url } = storageConfig();
  return data?.signedURL ? `${url}/storage/v1${data.signedURL}` : null;
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
    createdAt: row.created_at,
    resolutionStatus: row.resolution_status || 'Awaiting Resolution Evidence'
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const id = String(req.query?.id || '').trim();
      if (id) {
        const query = new URLSearchParams({
          select: 'id,title,description,category,location,address,zone,latitude,longitude,status,department,created_at,image_path,before_image_path,after_image_paths,resolution_description,resolution_completed_at,resolution_department,resolution_status,submitted_at,verified_at',
          id: `eq.${id}`,
          limit: '1'
        });
        const rows = await databaseRequest(`?${query}`);
        if (!rows?.[0]) return res.status(200).json(null);
        const row = rows[0], record = fromDatabase(row);
        record.beforeImageUrl = await signedImageUrl(row.before_image_path || row.image_path);
        const verified = row.resolution_status === 'Verified' && row.status === 'Resolved';
        record.afterImageUrls = verified ? await Promise.all((Array.isArray(row.after_image_paths) ? row.after_image_paths : []).map(signedImageUrl)) : [];
        record.resolutionDescription = verified ? row.resolution_description : null;
        record.resolutionCompletedAt = verified ? row.resolution_completed_at : null;
        record.resolutionDepartment = verified ? row.resolution_department : null;
        record.resolutionStatus = row.resolution_status || 'Awaiting Resolution Evidence';
        record.submittedAt = verified ? row.submitted_at : null;
        record.verifiedAt = verified ? row.verified_at : null;
        return res.status(200).json(record);
      }
      if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin access required.' });
      const rows = await databaseRequest('?select=*&order=created_at.desc');
      const records = await Promise.all((rows || []).map(async row => {
        const verified = row.resolution_status === 'Verified' && row.status === 'Resolved';
        return {
          ...fromDatabase(row),
          photoUrl: await signedImageUrl(row.image_path),
          beforeImageUrl: await signedImageUrl(row.before_image_path || row.image_path),
          resolutionDescription: row.resolution_description,
          resolutionCompletedAt: row.resolution_completed_at,
          resolutionDepartment: row.resolution_department,
          resolutionStatus: row.resolution_status || 'Awaiting Resolution Evidence',
          submittedByAdminId: row.submitted_by_admin_id,
          submittedAt: row.submitted_at,
          verifiedByAdminId: row.verified_by_admin_id,
          verifiedAt: row.verified_at,
          afterImageUrls: verified ? await Promise.all((Array.isArray(row.after_image_paths) ? row.after_image_paths : []).map(signedImageUrl)) : []
        };
      }));
      return res.status(200).json(records);
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
      if (body.image) record.image_path = await saveImage(body.image, record.id);
      let rows;
      try {
        rows = await databaseRequest('?select=*', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(record)
        });
      } catch (error) {
        if (record.image_path) {
          try { await storageRequest(`/object/${imageBucket}/${record.image_path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); }
          catch (cleanupError) { console.error('Could not remove orphaned complaint image:', cleanupError); }
        }
        throw error;
      }
      return res.status(201).json(fromDatabase(rows[0]));
    }

    if (req.method === 'PATCH') {
      if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin access required.' });
      const id = String(req.query?.id || '').trim();
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (!id) return res.status(400).json({ error: 'Complaint ID is required.' });
      const update = {};
      if (body.status !== undefined) {
        if (body.status === 'Resolved' || body.status === 'Pending Verification' || body.status === 'Returned for Additional Work') {
          return res.status(409).json({ error: 'Resolution status changes require the proof review workflow.' });
        }
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
      if (update.status !== undefined) {
        const existing = await databaseRequest(`?${new URLSearchParams({ select: 'id,status', id: `eq.${id}`, limit: '1' })}`);
        if (!existing?.[0]) return res.status(404).json({ error: 'Complaint not found.' });
        if (['Pending Verification', 'Returned for Additional Work', 'Resolved'].includes(existing[0].status)) {
          return res.status(409).json({ error: 'This status can only change through the resolution verification workflow.' });
        }
      }
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
