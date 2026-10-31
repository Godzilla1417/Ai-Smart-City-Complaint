const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const resolutionHandler = require('../api/resolution');
const complaintsHandler = require('../api/complaints');
const originalFetch = global.fetch;

const complaintId = 'CF-123456789012';
const originalComplaint = {
  id: complaintId, user_id: 'resident-1', title: 'Broken neighborhood water pipe',
  description: 'Water has been leaking from the pipe for several days.', category: 'Water',
  address: 'Main Street', location: 'Main Street', zone: 'Citywide', latitude: 1, longitude: 2,
  status: 'In Progress', department: 'Water Utilities', created_at: '2026-01-01T10:00:00.000Z',
  image_path: 'original/citizen.jpg', before_image_path: null, after_image_paths: [],
  resolution_status: 'Awaiting Resolution Evidence'
};

function adminToken() {
  const payload = Buffer.from(String(Date.now() + 60_000)).toString('base64url');
  const signature = createHmac('sha256', process.env.ADMIN_ACCESS_KEY).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function responseStub() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    setHeader() {},
    json(data) { this.data = data; return this; }
  };
}

function jpegData(byte = 0x44) {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, byte, byte, 0xff, 0xd9]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function installSupabaseMock(row = { ...originalComplaint }, observed = {}) {
  global.fetch = async (input, options = {}) => {
    const url = String(input), method = options.method || 'GET';
    if (url.includes('/rest/v1/complaints') && method === 'GET') return httpResponse(200, [structuredClone(row)]);
    if (url.includes('/rest/v1/complaints') && method === 'PATCH') {
      const update = JSON.parse(options.body);
      observed.update = update;
      Object.assign(row, update);
      return httpResponse(200, [structuredClone(row)]);
    }
    if (url.includes('/rest/v1/complaint_resolution_audit') && method === 'POST') {
      observed.audit = JSON.parse(options.body);
      return httpResponse(201, null);
    }
    if (url.includes('/storage/v1/object/sign/') && method === 'POST') {
      const pathname = new URL(url).pathname;
      return httpResponse(200, { signedURL: `${pathname.replace('/storage/v1', '')}?token=test-expiring` });
    }
    if (url.includes('/storage/v1/object/') && method === 'POST') {
      observed.uploads = (observed.uploads || 0) + 1;
      return httpResponse(200, { Key: 'private-object' });
    }
    if (url.includes('/storage/v1/object/') && method === 'DELETE') return httpResponse(200, {});
    throw new Error(`Unexpected mock request: ${method} ${url}`);
  };
}

function httpResponse(status, data) {
  return { ok: status >= 200 && status < 300, status, async text() { return data == null ? '' : JSON.stringify(data); } };
}

test.beforeEach(() => {
  process.env.ADMIN_ACCESS_KEY = 'test-admin-key';
  process.env.SUPABASE_URL = 'https://unit-test.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'unit-test-secret';
  process.env.ADMIN_ACTOR_ID = 'test-reviewer';
});

test.afterEach(() => { global.fetch = originalFetch; });

test('resolution endpoint rejects callers without an admin token', async () => {
  const res = responseStub();
  await resolutionHandler({ method: 'GET', query: { id: complaintId }, headers: {} }, res);
  assert.equal(res.statusCode, 401);
});

test('admin submission validates image bytes and rejects spoofed formats', async () => {
  installSupabaseMock();
  const res = responseStub();
  await resolutionHandler({
    method: 'POST', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() },
    body: { action: 'submit', description: 'The pipe joint was replaced and tested.', department: 'Water Utilities', completedAt: new Date().toISOString(), photos: ['data:image/jpeg;base64,bm90YW5pbWFnZQ=='] }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.data.error, /contents do not match/);
});

test('server rejects a resolution photo above the per-image size limit', async () => {
  installSupabaseMock();
  const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1_500_001)]);
  const res = responseStub();
  await resolutionHandler({
    method: 'POST', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() },
    body: { action: 'submit', description: 'The pipe joint was replaced and tested.', department: 'Water Utilities', completedAt: new Date().toISOString(), photos: [`data:image/jpeg;base64,${oversized.toString('base64')}`] }
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.data.error, /1.5 MB or smaller/);
});

test('multiple real-format photo uploads stay pending until a separate verification', async () => {
  const observed = {};
  installSupabaseMock({ ...originalComplaint }, observed);
  const res = responseStub();
  await resolutionHandler({
    method: 'POST', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() },
    body: { action: 'submit', description: 'The pipe joint was replaced and flow tested.', department: 'Water Utilities Crew 2', completedAt: '2026-01-02T12:30:00.000Z', photos: [jpegData(0x10), jpegData(0x20)] }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(observed.uploads, 2);
  assert.equal(observed.update.status, 'Pending Verification');
  assert.equal(observed.update.resolution_status, 'Pending Verification');
  assert.equal(observed.update.after_image_paths.length, 2);
  assert.equal(observed.update.submitted_by_admin_id, 'test-reviewer');
  assert.equal(observed.audit.action, 'evidence_submitted');
  assert.equal(res.data.resolutionStatus, 'Pending Verification');
});

test('verification records the reviewer and is the only path to Resolved', async () => {
  const row = { ...originalComplaint, status: 'Pending Verification', resolution_status: 'Pending Verification', after_image_paths: ['proof/repair.jpg'] };
  const observed = {};
  installSupabaseMock(row, observed);
  const res = responseStub();
  await resolutionHandler({ method: 'POST', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() }, body: { action: 'verify' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(observed.update.status, 'Resolved');
  assert.equal(observed.update.resolution_status, 'Verified');
  assert.equal(observed.update.verified_by_admin_id, 'test-reviewer');
  assert.equal(observed.audit.action, 'verified');
});

test('verification refuses evidence that is not pending review', async () => {
  installSupabaseMock();
  const res = responseStub();
  await resolutionHandler({ method: 'POST', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() }, body: { action: 'verify' } }, res);
  assert.equal(res.statusCode, 409);
});

test('admin can return pending evidence with an audit note without resolving it', async () => {
  const row = { ...originalComplaint, status: 'Pending Verification', resolution_status: 'Pending Verification', after_image_paths: ['proof/repair.jpg'] };
  const observed = {};
  installSupabaseMock(row, observed);
  const res = responseStub();
  await resolutionHandler({ method: 'POST', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() }, body: { action: 'return', note: 'The leak is still visible near the pipe joint.' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(observed.update.status, 'Returned for Additional Work');
  assert.equal(observed.update.resolution_status, 'Returned for Additional Work');
  assert.equal(observed.audit.action, 'returned_for_work');
  assert.match(observed.audit.details.note, /still visible/);
});

test('general complaint patch cannot mark a complaint Resolved', async () => {
  installSupabaseMock();
  const res = responseStub();
  await complaintsHandler({ method: 'PATCH', query: { id: complaintId }, headers: { 'x-admin-token': adminToken() }, body: { status: 'Resolved' } }, res);
  assert.equal(res.statusCode, 409);
});

test('citizen tracking receives no resolution photos until evidence is verified', async () => {
  const pending = { ...originalComplaint, status: 'Pending Verification', resolution_status: 'Pending Verification', after_image_paths: ['private/after.jpg'], resolution_description: 'Repair details' };
  const observed = {};
  installSupabaseMock(pending, observed);
  const res = responseStub();
  await complaintsHandler({ method: 'GET', query: { id: complaintId }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data.afterImageUrls, []);
  assert.equal(res.data.resolutionDescription, null);
  assert.equal(res.data.beforeImageUrl, 'https://unit-test.supabase.co/storage/v1/object/sign/civic-complaint-images/original/citizen.jpg?token=test-expiring');
});

test('citizen tracking receives signed resolution photos only after verification', async () => {
  const verified = { ...originalComplaint, status: 'Resolved', resolution_status: 'Verified', before_image_path: 'original/citizen.jpg', after_image_paths: ['proof/repair.jpg'], resolution_description: 'The pipe joint was replaced.', resolution_completed_at: '2026-01-02T12:30:00.000Z', resolution_department: 'Water Utilities', submitted_at: '2026-01-02T13:00:00.000Z', verified_at: '2026-01-03T09:00:00.000Z' };
  installSupabaseMock(verified);
  const res = responseStub();
  await complaintsHandler({ method: 'GET', query: { id: complaintId }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.afterImageUrls.length, 1);
  assert.equal(res.data.resolutionDescription, 'The pipe joint was replaced.');
  assert.equal(res.data.submittedAt, verified.submitted_at);
  assert.equal(res.data.verifiedAt, verified.verified_at);
});
