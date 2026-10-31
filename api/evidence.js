const { createHmac, timingSafeEqual, createHash } = require('node:crypto');
const bucket = 'civic-complaint-images';

function config() {
  const url = process.env.SUPABASE_URL;
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Shared complaint storage is not configured.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return { url: url.replace(/\/$/, ''), headers };
}

async function request(table, query = '', options = {}) {
  const { url, headers } = config();
  const response = await fetch(`${url}/rest/v1/${table}${query}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    console.error(`Supabase evidence ${table} request failed:`, response.status, data);
    throw new Error('The evidence request could not be saved. Check the database schema.');
  }
  return data;
}

function adminAuthorized(req) {
  const key = process.env.ADMIN_ACCESS_KEY;
  const token = req.headers?.['x-admin-token'];
  if (!key || typeof token !== 'string') return false;
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) return false;
  const expected = createHmac('sha256', key).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  return Number(Buffer.from(payload, 'base64url').toString()) > Date.now();
}

function ownsComplaint(req, complaint) {
  const token = req.headers?.['x-citizen-token'];
  if (typeof token !== 'string' || !complaint?.citizen_access_token_hash) return false;
  const actual = createHash('sha256').update(token).digest();
  const expected = Buffer.from(complaint.citizen_access_token_hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function signedUrl(path) {
  const { url, headers } = config();
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${encoded}`, {
    method: 'POST', headers, body: JSON.stringify({ expiresIn: 900 })
  });
  if (!response.ok) throw new Error('Could not create a secure evidence link.');
  const data = await response.json();
  return data?.signedURL ? `${url}/storage/v1${data.signedURL}` : null;
}

async function audit(complaintId, action, actorType, actorId, details) {
  return request('complaint_resolution_audit', '', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ complaint_id: complaintId, action, actor_type: actorType, actor_id: actorId, actor_admin_id: actorType === 'admin' ? actorId : null, details })
  });
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const complaintId = String(req.query?.id || '').trim();
      if (complaintId) {
        const complaintRows = await request('complaints', `?${new URLSearchParams({ select: 'id,status,resolution_status,citizen_access_token_hash', id: `eq.${complaintId}`, limit: '1' })}`);
        const complaint = complaintRows?.[0];
        if (!complaint || !ownsComplaint(req, complaint)) return res.status(403).json({ error: 'This report’s private evidence access key is required.' });
        const query = new URLSearchParams({ select: 'evidence_id,evidence_owner_type,evidence_image_path,evidence_description,evidence_submitted_at,evidence_status,deletion_request_status,deletion_requested_at', complaint_id: `eq.${complaintId}`, order: 'evidence_submitted_at.asc' });
        const rows = await request('complaint_evidence', `?${query}`);
        const verified = complaint.status === 'Resolved' && complaint.resolution_status === 'Verified';
        const visible = (rows || []).filter(item => item.evidence_owner_type === 'citizen' || (item.evidence_owner_type === 'admin' && verified));
        return res.status(200).json(await Promise.all(visible.map(async item => ({
          evidenceId: item.evidence_id, ownerType: item.evidence_owner_type, description: item.evidence_description,
          submittedAt: item.evidence_submitted_at, evidenceStatus: item.evidence_status,
          deletionRequestStatus: item.deletion_request_status, deletionRequestedAt: item.deletion_requested_at,
          imageUrl: await signedUrl(item.evidence_image_path)
        }))));
      }
      if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin access required.' });
      const query = new URLSearchParams({
        select: 'evidence_id,complaint_id,evidence_owner_type,evidence_owner_id,evidence_image_path,evidence_description,evidence_submitted_at,evidence_status,deletion_request_status,deletion_requested_at',
        deletion_request_status: 'in.(Pending,In Review,Escalated for Privacy Review)',
        order: 'deletion_requested_at.asc'
      });
      const rows = await request('complaint_evidence', `?${query}`);
      return res.status(200).json(await Promise.all((rows || []).map(async item => {
        const complaint = await request('complaints', `?${new URLSearchParams({ select: 'title,category,status', id: `eq.${item.complaint_id}`, limit: '1' })}`);
        return { ...item, imageUrl: await signedUrl(item.evidence_image_path), complaint: complaint?.[0] || null };
      })));
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed. Evidence cannot be deleted through this endpoint.' });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const evidenceId = String(body.evidenceId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(evidenceId)) return res.status(400).json({ error: 'A valid evidence ID is required.' });
    const evidenceRows = await request('complaint_evidence', `?${new URLSearchParams({ select: '*', evidence_id: `eq.${evidenceId}`, limit: '1' })}`);
    const evidence = evidenceRows?.[0];
    if (!evidence) return res.status(404).json({ error: 'Evidence not found.' });

    if (body.action === 'request-deletion') {
      if (body.confirmed !== true) return res.status(400).json({ error: 'Confirm the deletion request before submitting it.' });
      if (evidence.evidence_owner_type !== 'citizen') return res.status(403).json({ error: 'Citizens cannot request deletion of administrator resolution evidence.' });
      const complaintRows = await request('complaints', `?${new URLSearchParams({ select: 'id,citizen_access_token_hash', id: `eq.${evidence.complaint_id}`, limit: '1' })}`);
      const complaint = complaintRows?.[0];
      if (!ownsComplaint(req, complaint)) return res.status(403).json({ error: 'This report’s private evidence access key is required.' });
      if (evidence.deletion_request_status !== 'None' || evidence.evidence_status !== 'Active') return res.status(409).json({ error: 'A deletion request is already open or this evidence is unavailable.' });
      const updated = await request('complaint_evidence', `?evidence_id=eq.${evidenceId}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ evidence_status: 'Deletion Requested', deletion_request_status: 'Pending', deletion_requested_at: new Date().toISOString() })
      });
      await audit(evidence.complaint_id, 'citizen_deletion_requested', 'citizen', 'report-owner', { evidence_id: evidenceId, retention_action: 'pending_review' });
      return res.status(200).json({ evidenceId, status: updated?.[0]?.deletion_request_status || 'Pending', message: 'The request is recorded for retention review. The photo remains attached while the request is reviewed.' });
    }

    if (body.action === 'review-deletion') {
      if (!adminAuthorized(req)) return res.status(401).json({ error: 'Admin access required.' });
      if (evidence.evidence_owner_type !== 'citizen' || evidence.deletion_request_status !== 'Pending') return res.status(409).json({ error: 'Only pending citizen evidence requests can be reviewed.' });
      const decision = String(body.decision || ''), note = String(body.note || '').trim();
      if (!['retain', 'escalate'].includes(decision) || note.length < 5 || note.length > 1000) return res.status(400).json({ error: 'Choose retain or escalate and provide a review note.' });
      const status = decision === 'retain' ? 'Retained' : 'Escalated for Privacy Review';
      const updated = await request('complaint_evidence', `?evidence_id=eq.${evidenceId}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ evidence_status: decision === 'retain' ? 'Active' : 'Privacy Review', deletion_request_status: status })
      });
      const actorId = String(process.env.ADMIN_ACTOR_ID || 'shared-admin').trim().slice(0, 120) || 'shared-admin';
      await audit(evidence.complaint_id, 'deletion_reviewed', 'admin', actorId, { evidence_id: evidenceId, decision, note, file_deleted: false });
      return res.status(200).json({ evidenceId, status: updated?.[0]?.deletion_request_status || status, fileDeleted: false });
    }
    return res.status(400).json({ error: 'Choose request-deletion or review-deletion.' });
  } catch (error) {
    console.error('Evidence API failed:', error);
    return res.status(503).json({ error: error.message || 'Evidence service is unavailable.' });
  }
};
