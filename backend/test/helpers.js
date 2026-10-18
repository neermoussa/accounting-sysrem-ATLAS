// backend/test/helpers.js
//
// Shared harness for the focused regression tests in this directory. Each
// test file boots its own real backend HTTP server (the actual
// backend/server.js, as a child process) against its own throwaway SQLite
// file (via the ATLAS_DB_PATH env override in db/init.js) on a scratch
// port, drives it with real fetch() calls through the real API (company
// creation, registration, permission grants — never direct DB writes), and
// tears the process + scratch files down afterward. This deliberately does
// not depend on any manually-seeded state left over from prior QA sessions.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const net = require('net');

// Test files run in parallel processes; a fixed/random port range let two of
// them pick the same port. Ask the OS for a free one instead.
function allocPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/auth/me`);
      if (res.status === 401 || res.status === 200) return true;
    } catch (err) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on port ${port} did not become ready in time`);
}

// Boots a fresh backend instance. Returns { port, baseUrl, dbPath, stop() }.
// dbPath lets a test open its own raw SQLite connection (e.g. to prove a
// database trigger blocks a write the API would never attempt).
async function startServer() {
  const port = await allocPort();
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
  const dbPath = path.join(scratchDir, 'data.sqlite');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ATLAS_DB_PATH: dbPath,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderrBuf = '';
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString();
  });

  await waitForServer(port).catch((err) => {
    throw new Error(`${err.message}\nstderr so far:\n${stderrBuf}`);
  });

  const baseUrl = `http://localhost:${port}`;

  function stop() {
    child.kill('SIGTERM');
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch (err) {
      // best-effort cleanup
    }
  }

  return { port, baseUrl, dbPath, stop };
}

// A tiny fetch wrapper that remembers a single session cookie, since
// Node's built-in fetch has no automatic cookie jar.
function makeClient(baseUrl) {
  let cookie = null;

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        json = text;
      }
    }
    return { status: res.status, body: json };
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    del: (path) => request('DELETE', path),
    login: async (contact, password) => {
      const res = await request('POST', '/api/auth/login', { contact, password });
      if (res.status !== 200) throw new Error(`login failed for ${contact}: ${JSON.stringify(res.body)}`);
      return res.body.user;
    },
  };
}

// Creates a fresh company + auto-approved manager (every permission) via
// the real POST /api/companies bootstrap endpoint. Returns
// { companyId, manager: client, managerContact, managerPassword }.
async function createCompany(baseUrl, { name = 'شركة الاختبار', contact, password = 'Something1234!' } = {}) {
  const managerContact = contact || `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const client = makeClient(baseUrl);
  const res = await client.post('/api/companies', {
    companyName: name,
    adminName: 'مدير الاختبار',
    adminContact: managerContact,
    adminPassword: password,
    currency: 'SYP',
    acceptedPrivacyPolicy: true,
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`company creation failed: ${JSON.stringify(res.body)}`);
  }
  return {
    companyId: res.body.user.company_id,
    manager: client,
    managerContact,
    managerPassword: password,
  };
}

// Creates an approved rep user (via the manager's own POST /api/admin/users,
// which auto-approves) and grants exactly the given permissions via the
// real permissions API. Returns a fresh logged-in client for that user
// plus their id/contact/password.
async function createRep(baseUrl, managerClient, { permissions = [], contact, password = 'Something1234!', name = 'مندوب اختبار' } = {}) {
  const repContact = contact || `rep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
  const created = await managerClient.post('/api/admin/users', { name, contact: repContact, password });
  if (created.status !== 201) throw new Error(`rep creation failed: ${JSON.stringify(created.body)}`);
  const userId = created.body.id;

  const granted = await managerClient.put(`/api/permissions/users/${userId}/permissions`, { permissions });
  if (granted.status !== 200) throw new Error(`permission grant failed: ${JSON.stringify(granted.body)}`);

  const client = makeClient(baseUrl);
  await client.login(repContact, password);
  return { client, userId, contact: repContact, password };
}

module.exports = { startServer, makeClient, createCompany, createRep };
