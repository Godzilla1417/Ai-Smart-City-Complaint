const { createHmac, timingSafeEqual, randomBytes } = require('node:crypto');
const bucket = 'civic-complaint-images';
function actorId() { return String(process.env.ADMIN_ACTOR_ID || 'shared-admin').trim().slice(0, 120) || 'shared-admin'; }
function invalidPhoto(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

function authorized(req) {
  const key = process.env.ADMIN_ACCESS_KEY;
  const token = req.headers['x-admin-token'];
  if (!key || typeof token !== 'string') return false;
  const [payload, signature, ...extra] = token.split('.');
  if (!payload || !signature || extra.length) return false;
  const expected = createHmac('sha256', key).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  const expiry = Number(Buffer.from(payload, 'base64url').toString());
  return Number.isFinite(expiry) && expiry > Date.now();
}

function config() {
  const url = process.env.SUPABASE_URL;
  const key = String(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) throw new Error('Shared complaint storage is not configured.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  return { url: url.replace(/\/$/, ''), headers };
}

async function request(kind, path, options = {}) {
  const { url, headers } = config();
  const endpoint = kind === 'storage' ? `${url}/storage/v1${path}` : `${url}/rest/v1/${path}`;
  const response = await fetch(endpoint, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    console.error(`Supabase resolution ${kind} request failed:`, response.status, data);
    throw new Error('The resolution update could not be saved. Check the Supabase schema and storage setup.');
  }
  return data;
}

function signedUrl(path) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return request('storage', `/object/sign/${bucket}/${encoded}`, {
    method: 'POST', body: JSON.stringify({ expiresIn: 900 })
  }).then(data => data?.signedURL ? `${config().url}/storage/v1${data.signedURL}` : null);
}

function parseImage(dataUrl) {
  if (typeof dataUrl !== 'string') throw invalidPhoto('Choose a JPG, PNG, or WebP photo.');
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw invalidPhoto('Only JPG, PNG, and WebP photos are supported.');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 1_500_000) throw invalidPhoto('Each photo must be 1.5 MB or smaller after compression.');
  const signatureValid = match[1] === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : match[1] === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureValid) throw invalidPhoto('Photo contents do not match their file type.');
  const extension = match[1] === 'image/jpeg' ? 'jpg' : match[1].split('/')[1];
  return { bytes, mime: match[1], extension };
}

async function uploadImage(complaintId, dataUrl) {
  const image = parseImage(dataUrl);
  const path = `${complaintId}/resolution/${Date.now()}-${randomBytes(10).toString('hex')}.${image.extension}`;
  await request('storage', `/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST',
    headers: { 'Content-Type': image.mime, 'x-upsert': 'false', 'Cache-Control': '3600' },
    body: image.bytes
  });
  return path;
}

async function getComplaint(id) {
  const query = new URLSearchParams({ select: '*', id: `eq.${id}`, limit: '1' });
  return (await request('database', `complaints?${query}`))?.[0] || null;
}

async function audit(id, action, details) {
  await request('database', 'complaint_resolution_audit', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ complaint_id: id, action, actor_admin_id: actorId(), actor_type: 'admin', actor_id: actorId(), details })
  });
}

async function evidenceRows(id, paths, description, ownerId) {
  for (const imagePath of paths) await request('database', 'complaint_evidence', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ complaint_id: id, evidence_owner_type: 'admin', evidence_owner_id: ownerId, evidence_image_path: imagePath, evidence_description: description || null, evidence_submitted_at: new Date().toISOString() })
  });
}

async function removeEvidenceRows(id, paths) {
  for (const imagePath of paths) {
    const query = new URLSearchParams({ complaint_id: `eq.${id}`, evidence_image_path: `eq.${imagePath}` });
    try { await request('database', `complaint_evidence?${query}`, { method: 'DELETE' }); }
    catch (error) { console.error('Could not roll back evidence ledger row:', error); }
  }
}

async function rollbackComplaint(id, query, row) {
  await request('database', `complaints?${query}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
    status: row.status, resolution_status: row.resolution_status, before_image_path: row.before_image_path,
    after_image_paths: row.after_image_paths, resolution_description: row.resolution_description,
    resolution_completed_at: row.resolution_completed_at, resolution_department: row.resolution_department,
    submitted_by_admin_id: row.submitted_by_admin_id, submitted_at: row.submitted_at,
    verified_by_admin_id: row.verified_by_admin_id, verified_at: row.verified_at
  }) });
}

async function publicProof(row) {
  const verified = row.resolution_status === 'Verified' && row.status === 'Resolved';
  const beforePath = row.before_image_path || row.image_path;
  const afterPaths = Array.isArray(row.after_image_paths) ? row.after_image_paths : [];
  const [beforeImageUrl, afterImageUrls] = verified
    ? await Promise.all([
        beforePath ? signedUrl(beforePath) : null,
        Promise.all(afterPaths.map(signedUrl))
      ])
    : [null, []];
  return {
    beforeImageUrl,
    afterImageUrls,
    resolutionDescription: verified ? row.resolution_description : null,
    resolutionCompletedAt: verified ? row.resolution_completed_at : null,
    resolutionDepartment: verified ? row.resolution_department : null,
    resolutionStatus: row.resolution_status || 'Awaiting Resolution Evidence',
    verifiedAt: verified ? row.verified_at : null
  };
}

async function adminRecord(row) {
  const beforePath = row.before_image_path || row.image_path;
  const afterPaths = Array.isArray(row.after_image_paths) ? row.after_image_paths : [];
  const [beforeImageUrl, afterImageUrls] = await Promise.all([
    beforePath ? signedUrl(beforePath) : null,
    Promise.all(afterPaths.map(signedUrl))
  ]);
  const evidenceQuery = new URLSearchParams({ select: 'evidence_id,evidence_owner_type,evidence_owner_id,evidence_image_path,evidence_description,evidence_submitted_at,evidence_status,deletion_request_status', complaint_id: `eq.${row.id}`, order: 'evidence_submitted_at.asc' });
  const evidence = await request('database', `complaint_evidence?${evidenceQuery}`);
  const evidenceRecords = await Promise.all((evidence || []).map(async item => ({
    evidenceId: item.evidence_id, ownerType: item.evidence_owner_type, ownerId: item.evidence_owner_id,
    imageUrl: await signedUrl(item.evidence_image_path), description: item.evidence_description,
    submittedAt: item.evidence_submitted_at, status: item.evidence_status,
    deletionRequestStatus: item.deletion_request_status
  })));
  return {
    beforeImageUrl, afterImageUrls,
    resolutionDescription: row.resolution_description,
    resolutionCompletedAt: row.resolution_completed_at,
    resolutionDepartment: row.resolution_department,
    resolutionStatus: row.resolution_status || 'Awaiting Resolution Evidence',
    submittedByAdminId: row.submitted_by_admin_id,
    submittedAt: row.submitted_at,
    verifiedByAdminId: row.verified_by_admin_id,
    verifiedAt: row.verified_at,
    evidenceRecords
  };
}

module.exports = async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: 'Admin access required.' });
  try {
    const id = String(req.query?.id || '').trim();
    if (!id || id.length > 100) return res.status(400).json({ error: 'A valid complaint ID is required.' });

    if (req.method === 'GET') {
      const row = await getComplaint(id);
      if (!row) return res.status(404).json({ error: 'Complaint not found.' });
      const auditQuery = new URLSearchParams({ select: '*', complaint_id: `eq.${id}`, order: 'created_at.desc' });
      const events = await request('database', `complaint_resolution_audit?${auditQuery}`);
      return res.status(200).json({ ...await adminRecord(row), auditTrail: events || [] });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const row = await getComplaint(id);
    if (!row) return res.status(404).json({ error: 'Complaint not found.' });
    const now = new Date().toISOString();
    const action = String(body.action || '');
    let update, eventAction, details;
    const uploadedPaths = [];
    let replacementEvidence = null, replacementEvidenceId = null, replacementPath = null;

    if (action === 'submit') {
      if (!['In Progress', 'Awaiting Resolution Evidence', 'Returned for Additional Work'].includes(row.status)) {
        return res.status(409).json({ error: 'Move the complaint to In Progress or Awaiting Resolution Evidence before submitting proof.' });
      }
      const description = String(body.description || '').trim();
      const department = String(body.department || '').trim();
      if (description.length < 10 || description.length > 2000) return res.status(400).json({ error: 'Resolution description must be between 10 and 2,000 characters.' });
      if (!department || department.length > 120) return res.status(400).json({ error: 'Enter the department or repair team.' });
      if (!Number.isFinite(Date.parse(body.completedAt)) || Date.parse(body.completedAt) > Date.now()) return res.status(400).json({ error: 'Enter a valid repair completion date and time that is not in the future.' });
      const completedAt = new Date(body.completedAt).toISOString();
      const photos = Array.isArray(body.photos) ? body.photos : [];
      if (photos.length < 1 || photos.length > 4) return res.status(400).json({ error: 'Upload one required after-repair photo and up to three additional photos.' });
      let total = 0;
      for (const photo of photos) { const parsed = parseImage(photo); total += parsed.bytes.length; }
      if (total > 2_500_000) return res.status(400).json({ error: 'All resolution photos combined must be 2.5 MB or smaller after compression.' });

      try {
        for (const photo of photos) uploadedPaths.push(await uploadImage(id, photo));
        update = {
          before_image_path: row.image_path || null,
          after_image_paths: [...(Array.isArray(row.after_image_paths) ? row.after_image_paths : []), ...uploadedPaths],
          resolution_description: description,
          resolution_completed_at: completedAt,
          resolution_department: department,
          resolution_status: 'Pending Verification',
          submitted_by_admin_id: actorId(),
          submitted_at: now,
          verified_by_admin_id: null,
          verified_at: null,
          status: 'Pending Verification'
        };
        eventAction = 'evidence_submitted';
        details = { description, department, completed_at: completedAt, image_paths: uploadedPaths };
      } catch (error) {
        for (const path of uploadedPaths) {
          try { await request('storage', `/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); }
          catch (cleanupError) { console.error('Could not clean up resolution photo:', cleanupError); }
        }
        throw error;
      }
    } else if (action === 'verify') {
      if (row.resolution_status !== 'Pending Verification' || row.status !== 'Pending Verification') return res.status(409).json({ error: 'Only evidence pending verification can be approved.' });
      update = { resolution_status: 'Verified', verified_by_admin_id: actorId(), verified_at: now, status: 'Resolved' };
      eventAction = 'verified'; details = { verified_at: now };
    } else if (action === 'return') {
      if (row.resolution_status !== 'Pending Verification' || row.status !== 'Pending Verification') return res.status(409).json({ error: 'Only evidence pending verification can be returned.' });
      const note = String(body.note || '').trim();
      if (note.length < 5 || note.length > 1000) return res.status(400).json({ error: 'Add a return note between 5 and 1,000 characters.' });
      update = { resolution_status: 'Returned for Additional Work', status: 'Returned for Additional Work' };
      eventAction = 'returned_for_work'; details = { note };
    } else if (action === 'replace') {
      const evidenceId = String(body.evidenceId || '').trim(), reason = String(body.reason || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(evidenceId) || reason.length < 5 || reason.length > 1000) return res.status(400).json({ error: 'Choose resolution evidence and explain the correction in 5 to 1,000 characters.' });
      if (!['Pending Verification', 'Verified'].includes(row.resolution_status)) return res.status(409).json({ error: 'Only submitted resolution evidence can be corrected.' });
      const evidenceQuery = new URLSearchParams({ select: '*', evidence_id: `eq.${evidenceId}`, complaint_id: `eq.${id}`, limit: '1' });
      replacementEvidence = (await request('database', `complaint_evidence?${evidenceQuery}`))?.[0];
      if (!replacementEvidence || replacementEvidence.evidence_owner_type !== 'admin' || replacementEvidence.evidence_status !== 'Active') return res.status(403).json({ error: 'Only active administrator resolution evidence can be replaced.' });
      const oldPaths = Array.isArray(row.after_image_paths) ? row.after_image_paths : [];
      if (!oldPaths.includes(replacementEvidence.evidence_image_path)) return res.status(409).json({ error: 'This image is no longer in the complaint’s active resolution evidence.' });
      replacementPath = await uploadImage(id, body.photo);
      uploadedPaths.push(replacementPath);
      let inserted;
      try {
        inserted = await request('database', 'complaint_evidence?select=evidence_id', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ complaint_id: id, evidence_owner_type: 'admin', evidence_owner_id: actorId(), evidence_image_path: replacementPath, evidence_description: `Correction: ${reason}`, evidence_submitted_at: now })
        });
      } catch (error) {
        try { await request('storage', `/object/${bucket}/${replacementPath.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); } catch (cleanupError) { console.error('Could not clean up unregistered replacement image:', cleanupError); }
        throw error;
      }
      replacementEvidenceId = inserted?.[0]?.evidence_id;
      if (!replacementEvidenceId) {
        try { await request('database', `complaint_evidence?${new URLSearchParams({ complaint_id: `eq.${id}`, evidence_image_path: `eq.${replacementPath}` })}`, { method: 'DELETE' }); } catch {}
        try { await request('storage', `/object/${bucket}/${replacementPath.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); } catch {}
        throw new Error('The replacement photo was uploaded but its evidence record could not be created.');
      }
      update = {
        after_image_paths: oldPaths.map(path => path === replacementEvidence.evidence_image_path ? replacementPath : path),
        resolution_description: `${String(row.resolution_description || '').trim()}\nCorrection: ${reason}`.trim(),
        resolution_status: 'Pending Verification', status: 'Pending Verification',
        submitted_by_admin_id: actorId(), submitted_at: now, verified_by_admin_id: null, verified_at: null
      };
      eventAction = 'evidence_replaced'; details = { evidence_id: evidenceId, replacement_evidence_id: replacementEvidenceId, reason };
    } else {
      return res.status(400).json({ error: 'Choose submit, verify, or return.' });
    }

    const query = new URLSearchParams({ id: `eq.${id}`, select: '*' });
    let updated;
    try {
      updated = await request('database', `complaints?${query}`, {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(update)
      });
      if (action === 'submit') await evidenceRows(id, uploadedPaths, details.description, actorId());
      if (action === 'replace') await request('database', `complaint_evidence?evidence_id=eq.${replacementEvidence.evidence_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ evidence_status: 'Replaced', replaced_by_evidence_id: replacementEvidenceId }) });
    } catch (error) {
      if (action === 'submit' && uploadedPaths.length) {
        await removeEvidenceRows(id, uploadedPaths);
        try { await request('database', `complaints?${query}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: row.status, resolution_status: row.resolution_status, before_image_path: row.before_image_path, after_image_paths: row.after_image_paths, resolution_description: row.resolution_description, resolution_completed_at: row.resolution_completed_at, resolution_department: row.resolution_department, submitted_by_admin_id: row.submitted_by_admin_id, submitted_at: row.submitted_at, verified_by_admin_id: row.verified_by_admin_id, verified_at: row.verified_at }) }); }
        catch (rollbackError) { console.error('Could not roll back complaint after evidence registration failure:', rollbackError); }
      }
      if (action === 'replace') {
        if (updated?.[0]) try { await rollbackComplaint(id, query, row); } catch (rollbackError) { console.error('Could not roll back replacement complaint:', rollbackError); }
        if (replacementEvidenceId) {
          try { await request('database', `complaint_evidence?evidence_id=eq.${replacementEvidenceId}`, { method: 'DELETE' }); } catch (rollbackError) { console.error('Could not remove incomplete replacement ledger row:', rollbackError); }
        }
        if (replacementEvidence?.evidence_id) {
          try { await request('database', `complaint_evidence?evidence_id=eq.${replacementEvidence.evidence_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ evidence_status: 'Active', replaced_by_evidence_id: null }) }); } catch (rollbackError) { console.error('Could not restore replaced photo record:', rollbackError); }
        }
      }
      for (const path of uploadedPaths) {
        try { await request('storage', `/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); }
        catch (cleanupError) { console.error('Could not clean up resolution photo:', cleanupError); }
      }
      throw error;
    }
    if (!updated?.[0]) return res.status(404).json({ error: 'Complaint not found.' });
    try {
      await audit(id, eventAction, details);
    } catch (error) {
      await rollbackComplaint(id, query, row);
      if (action === 'submit') await removeEvidenceRows(id, uploadedPaths);
      if (action === 'replace') {
        try {
          await request('database', `complaint_evidence?evidence_id=eq.${replacementEvidence.evidence_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ evidence_status: 'Active', replaced_by_evidence_id: null }) });
          if (replacementEvidenceId) await request('database', `complaint_evidence?evidence_id=eq.${replacementEvidenceId}`, { method: 'DELETE' });
        } catch (rollbackError) { console.error('Could not restore replacement evidence after audit failure:', rollbackError); }
      }
      for (const path of uploadedPaths) {
        try { await request('storage', `/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }); }
        catch (cleanupError) { console.error('Could not clean up resolution photo after audit rollback:', cleanupError); }
      }
      throw error;
    }
    return res.status(200).json({ ...await adminRecord(updated[0]), status: updated[0].status, resolutionStatus: updated[0].resolution_status });
  } catch (error) {
    if (!error.statusCode) console.error('Resolution API failed:', error);
    return res.status(error.statusCode || 503).json({ error: error.message || 'Resolution service is unavailable.' });
  }
};
