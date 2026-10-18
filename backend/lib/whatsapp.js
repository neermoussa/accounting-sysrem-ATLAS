const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const db = require('../db/init');

const CHROMIUM_PATH = process.env.WHATSAPP_CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');

// One WhatsApp session per company, never shared — a Map keyed by
// companyId instead of the single module-level client this used to be
// (single-tenant days). Each entry mirrors the old module state exactly,
// just namespaced: { client, status, qr, connectedNumber }.
const sessions = new Map();

function sessionFor(companyId) {
  if (!sessions.has(companyId)) {
    sessions.set(companyId, { client: null, status: 'disconnected', qr: null, connectedNumber: null });
  }
  return sessions.get(companyId);
}

function getState(companyId) {
  const s = sessionFor(companyId);
  const latestRequest = db
    .prepare('SELECT status FROM whatsapp_link_requests WHERE company_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(companyId);
  return {
    status: s.status,
    qr: s.qr,
    connectedNumber: s.connectedNumber,
    approvalStatus: latestRequest?.status || 'none',
  };
}

// Step 1 of the two-step flow this feature requires: a company admin asks to
// link a number, which only ever creates a pending request — it never
// touches the WhatsApp client. Only a platform admin approving the request
// (routes/platformAdmin.js) unlocks `connect()` below for this company.
function requestLink(companyId, requestedNumber, user) {
  db.prepare(
    `INSERT INTO whatsapp_link_requests (company_id, requested_number, requested_by_id, requested_by_name)
     VALUES (?, ?, ?, ?)`
  ).run(companyId, requestedNumber || null, user?.id ?? null, user?.name ?? null);
  return getState(companyId);
}

function latestApprovedRequest(companyId) {
  return db
    .prepare(
      `SELECT * FROM whatsapp_link_requests WHERE company_id = ? AND status = 'approved' ORDER BY reviewed_at DESC LIMIT 1`
    )
    .get(companyId);
}

// Lazy: nothing touches WhatsApp (no browser launch, no network call) until
// an admin explicitly clicks "connect" from Settings, AND only once a
// platform admin has approved that company's link request — the app must
// work fully without WhatsApp ever being linked, and a company can never
// self-approve its own sensitive number link.
function connect(companyId) {
  const approved = latestApprovedRequest(companyId);
  if (!approved) {
    return { ...getState(companyId), error: 'not_approved_yet' };
  }

  const s = sessionFor(companyId);
  if (s.client || s.status === 'initializing' || s.status === 'connected') return getState(companyId);

  s.status = 'initializing';
  s.qr = null;

  s.client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(AUTH_DIR, `company-${companyId}`) }),
    puppeteer: {
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  s.client.on('qr', async (qr) => {
    s.status = 'qr_pending';
    try {
      s.qr = await QRCode.toDataURL(qr);
    } catch (err) {
      console.error('[whatsapp] failed to render QR code', err.message);
    }
  });

  s.client.on('ready', () => {
    s.status = 'connected';
    s.qr = null;
    s.connectedNumber = s.client.info?.wid?.user || null;
    console.log(`[whatsapp] company ${companyId} connected as`, s.connectedNumber);
  });

  // Every inbound message now goes through the bot's intent router
  // (lib/whatsappBot.js): "تكرار" replies with the last order for
  // reference, a recognized keyword gets an automatic reply, and a
  // candidate order still only ever lands in whatsapp_orders for a rep to
  // review/approve (never becomes a real order on its own) — same
  // guarantee as before, just routed through one place instead of always
  // assuming every message is order text. fromMe is skipped so the
  // company's own outgoing messages never loop back in as "incoming".
  s.client.on('message', (msg) => {
    if (msg.fromMe || !msg.body?.trim()) return;
    try {
      const { handleIncomingMessage } = require('./whatsappBot');
      const fromPhone = String(msg.from || '').replace(/@c\.us$/, '');
      handleIncomingMessage(companyId, {
        fromPhone,
        body: msg.body.trim(),
        sendReply: (text) => msg.reply(text),
      }).catch((err) => console.error('[whatsapp] bot handling failed:', err.message));
    } catch (err) {
      console.error('[whatsapp] failed to route incoming message through the bot:', err.message);
    }
  });

  s.client.on('auth_failure', (msg) => {
    s.status = 'auth_failed';
    console.error(`[whatsapp] company ${companyId} auth failure:`, msg);
  });

  s.client.on('disconnected', (reason) => {
    console.log(`[whatsapp] company ${companyId} disconnected:`, reason);
    s.status = 'disconnected';
    s.connectedNumber = null;
    s.client = null;
  });

  s.client.initialize().catch(async (err) => {
    console.error(`[whatsapp] company ${companyId} initialize failed:`, err.message);
    s.status = 'disconnected';
    const failedClient = s.client;
    s.client = null;
    // initialize() failing (e.g. no network route to WhatsApp) leaves the
    // Puppeteer browser it already launched running — destroy() closes it,
    // otherwise every failed connect attempt leaks a Chromium process tree.
    try {
      await failedClient.destroy();
    } catch (destroyErr) {
      console.error('[whatsapp] cleanup after failed initialize also failed:', destroyErr.message);
    }
  });

  return getState(companyId);
}

async function disconnect(companyId) {
  const s = sessionFor(companyId);
  if (s.client) {
    try {
      await s.client.logout();
    } catch (err) {
      console.error('[whatsapp] logout error:', err.message);
    }
    s.client = null;
  }
  s.status = 'disconnected';
  s.qr = null;
  s.connectedNumber = null;
}

function getManagerNumber(companyId) {
  const row = db
    .prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'manager_whatsapp_number'")
    .get(companyId);
  return (row?.value || '').replace(/[^\d]/g, ''); // digits only, e.g. 963991234567
}

// The ONLY recipient this ever messages automatically for a manager alert is
// that company's own manager number from Settings — never a customer or
// rep, and never another company's number. Returns true only on confirmed
// send, so callers can decide whether to mark an alert as handled.
async function sendToManager(companyId, message) {
  const s = sessionFor(companyId);
  if (s.status !== 'connected' || !s.client) {
    console.log(`[whatsapp] skip send company=${companyId} (not connected):`, message.slice(0, 60));
    return false;
  }
  const number = getManagerNumber(companyId);
  if (!number) {
    console.log(`[whatsapp] skip send company=${companyId} (no manager number configured)`);
    return false;
  }
  try {
    await s.client.sendMessage(`${number}@c.us`, message);
    return true;
  } catch (err) {
    console.error('[whatsapp] send failed:', err.message);
    return false;
  }
}

function isCustomerNotifyEnabledGlobally(companyId) {
  const row = db
    .prepare("SELECT value FROM settings WHERE company_id = ? AND key = 'whatsapp_customer_notify_enabled'")
    .get(companyId);
  return row?.value === '1';
}

// Customer-facing send: gated by BOTH this company's own global switch
// (Settings) and the shop's own opt-out, unlike sendToManager which only
// checks connection state — a customer never gets a message just because
// WhatsApp happens to be linked. Returns false (and sends nothing) whenever
// any gate is closed, same "quiet no-op, not an error" contract as
// sendToManager.
async function sendToCustomer(companyId, shop, message) {
  if (!isCustomerNotifyEnabledGlobally(companyId)) {
    console.log(`[whatsapp] skip customer send company=${companyId} (disabled globally):`, message.slice(0, 60));
    return false;
  }
  if (!shop || shop.whatsapp_customer_notify_enabled === 0) {
    console.log('[whatsapp] skip customer send (disabled for this shop):', message.slice(0, 60));
    return false;
  }
  const s = sessionFor(companyId);
  if (s.status !== 'connected' || !s.client) {
    console.log(`[whatsapp] skip customer send company=${companyId} (not connected):`, message.slice(0, 60));
    return false;
  }
  const number = String(shop.phone || '').replace(/[^\d]/g, '');
  if (!number) {
    console.log('[whatsapp] skip customer send (shop has no phone)');
    return false;
  }
  try {
    await s.client.sendMessage(`${number}@c.us`, message);
    return true;
  } catch (err) {
    console.error('[whatsapp] customer send failed:', err.message);
    return false;
  }
}

// Raw send to an arbitrary number, gated only by connection state — used
// for one-off transactional sends (OTP verification codes) that aren't
// covered by the customer-notify opt-in/opt-out (a phone being verified
// isn't a "customer notification" yet). Never used for anything but a
// number the caller has an explicit, immediate reason to message.
async function sendToNumber(companyId, rawNumber, message) {
  const s = sessionFor(companyId);
  if (s.status !== 'connected' || !s.client) {
    console.log(`[whatsapp] skip send company=${companyId} (not connected):`, message.slice(0, 60));
    return false;
  }
  const number = String(rawNumber || '').replace(/[^\d]/g, '');
  if (!number) return false;
  try {
    await s.client.sendMessage(`${number}@c.us`, message);
    return true;
  } catch (err) {
    console.error('[whatsapp] send failed:', err.message);
    return false;
  }
}

module.exports = {
  connect,
  sendToNumber,
  disconnect,
  getState,
  requestLink,
  sendToManager,
  sendToCustomer,
  isCustomerNotifyEnabledGlobally,
};
