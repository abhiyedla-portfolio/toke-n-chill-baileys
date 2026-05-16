/**
 * baileys-service/index.js
 *
 * Persistent Node.js service that maintains a WhatsApp connection
 * and forwards alert messages to a WhatsApp group.
 *
 * How it works:
 *   1. First run: visit GET /qr in your browser to scan the QR code
 *   2. Session is saved to ./auth_info/ so you only scan once
 *   3. Exposes a simple HTTP API for the Cloudflare Worker to call
 *
 * Endpoints:
 *   GET  /health         — connection status check (no auth)
 *   GET  /qr             — scan this in browser to link WhatsApp (no auth while unlinked)
 *   GET  /groups         — list all groups (to find your group JID)
 *   POST /send           — send a message to the configured group
 *
 * Environment variables (see .env.example):
 *   PORT            — HTTP port (default 3001)
 *   GROUP_JID       — WhatsApp group JID (e.g. 120363XXXXXXXXXX@g.us)
 *   SERVICE_SECRET  — shared secret for request authentication
 *   AUTH_INFO_PATH  — path to session files (use /app/auth_info on Railway)
 */

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const express  = require('express');
const pino     = require('pino');
const QRCode   = require('qrcode');

// ── Config ────────────────────────────────────────────────────

const PORT           = process.env.PORT || 3001;
const GROUP_JID      = process.env.GROUP_JID || '';
const SERVICE_SECRET = process.env.SERVICE_SECRET || 'change-me';
const AUTH_INFO_PATH = process.env.AUTH_INFO_PATH || 'auth_info';

// ── State ─────────────────────────────────────────────────────

let sock        = null;
let isConnected = false;
let latestQR    = null; // raw QR string from Baileys

// ── WhatsApp connection ───────────────────────────────────────

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_INFO_PATH);
  const { version }          = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' }); // suppress Baileys internal noise

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    keepAliveIntervalMs: 30_000,
    downloadHistory: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log(`[Baileys] QR code ready — open /qr in your browser to scan`);
    }

    if (connection === 'close') {
      isConnected = false;
      latestQR    = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut  = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.error('[Baileys] Logged out. Delete the auth_info/ folder and restart to re-scan.');
      } else {
        console.log(`[Baileys] Connection closed (${statusCode}) — reconnecting in 5s…`);
        setTimeout(connectToWhatsApp, 5_000);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      latestQR    = null; // QR no longer needed
      console.log('[Baileys] ✓ Connected to WhatsApp');

      if (!GROUP_JID) {
        console.log('[Baileys] ⚠  GROUP_JID is not set.');
        console.log('[Baileys]    Call GET /groups?secret=YOUR_SECRET to list your groups.');
      } else {
        console.log(`[Baileys]    Sending alerts to group: ${GROUP_JID}`);
      }
    }
  });
}

// ── HTTP server ───────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Simple auth check — reads secret from body, X-Secret header, or query param. */
function checkSecret(req, res) {
  const secret = req.headers['x-secret'] || req.body?.secret || req.query?.secret;
  if (secret !== SERVICE_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/**
 * GET /health
 * Returns connection status. No auth required.
 */
app.get('/health', (req, res) => {
  res.json({
    ok:       isConnected,
    groupJid: GROUP_JID || 'not configured',
    qrReady:  !!latestQR,
  });
});

/**
 * GET /qr
 * Serves the QR code as a scannable image in the browser.
 * No auth required (only works before the device is linked).
 * After linking, returns a "connected" message.
 */
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"><title>WhatsApp Status</title></head>
        <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#25D366;">
          <div style="text-align:center">
            <div style="font-size:72px">&#10003;</div>
            <h1>WhatsApp Connected</h1>
            <p style="color:#aaa">This device is already linked. No QR needed.</p>
          </div>
        </body>
      </html>
    `);
  }

  if (!latestQR) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="3">
          <title>Waiting for QR&hellip;</title>
        </head>
        <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff;">
          <div style="text-align:center">
            <div style="font-size:48px">&#8987;</div>
            <h1>Waiting for QR code&hellip;</h1>
            <p style="color:#aaa">This page auto-refreshes every 3 seconds.</p>
          </div>
        </body>
      </html>
    `);
  }

  try {
    const dataUrl = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta http-equiv="refresh" content="30">
          <title>Scan WhatsApp QR</title>
        </head>
        <body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#111;color:#fff;">
          <div style="text-align:center">
            <h1 style="color:#25D366">Scan with WhatsApp</h1>
            <p style="color:#aaa">Settings &rarr; Linked Devices &rarr; Link a Device</p>
            <img src="${dataUrl}" style="border:12px solid white;border-radius:12px;display:block;margin:24px auto;" />
            <p style="color:#888;font-size:13px">QR expires in ~60s &mdash; page auto-refreshes every 30s</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Failed to generate QR image: ' + err.message);
  }
});

/**
 * GET /groups?secret=YOUR_SECRET
 * Lists all WhatsApp groups the connected account is a member of.
 */
app.get('/groups', async (req, res) => {
  if (!checkSecret(req, res)) return;
  if (!isConnected || !sock) return res.status(503).json({ error: 'WhatsApp not connected yet' });

  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.entries(groups).map(([jid, g]) => ({
      jid,
      name:         g.subject,
      participants: g.participants.length,
    }));
    list.sort((a, b) => a.name.localeCompare(b.name));
    res.json(list);
  } catch (err) {
    console.error('[Baileys] /groups error:', err);
    res.status(500).json({ error: String(err) });
  }
});

/**
 * POST /send
 * Body: { secret: string, message: string }
 * Sends the message to the configured WhatsApp group.
 */
app.post('/send', async (req, res) => {
  if (!checkSecret(req, res)) return;

  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  if (!isConnected || !sock) {
    console.warn('[Baileys] /send called but not connected');
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  if (!GROUP_JID) {
    return res.status(500).json({ error: 'GROUP_JID is not configured — set it in your environment variables' });
  }

  try {
    await sock.sendMessage(GROUP_JID, { text: message });
    console.log(`[Baileys] ✓ Message sent to group`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Baileys] Send failed:', err);
    res.status(500).json({ error: String(err) });
  }
});

// ── Boot ──────────────────────────────────────────────────────

console.log('[Baileys] Starting WhatsApp service…');
connectToWhatsApp();

app.listen(PORT, () => {
  console.log(`[Baileys] HTTP server listening on port ${PORT}`);
  console.log(`[Baileys] Health: http://localhost:${PORT}/health`);
  console.log(`[Baileys] QR page: http://localhost:${PORT}/qr`);
});
