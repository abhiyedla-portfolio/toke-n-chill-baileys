/**
 * baileys-service/index.js
 *
 * Persistent Node.js service that maintains a WhatsApp connection
 * and forwards alert messages to a WhatsApp group.
 *
 * How it works:
 *   1. First run: prints a QR code in the terminal — scan with WhatsApp
 *   2. Session is saved to ./auth_info/ so you only scan once
 *   3. Exposes a simple HTTP API for the Cloudflare Worker to call
 *
 * Endpoints:
 *   GET  /health         — connection status check
 *   GET  /groups         — list all groups (to find your group JID)
 *   POST /send           — send a message to the configured group
 *
 * Environment variables (see .env.example):
 *   PORT            — HTTP port (default 3001)
 *   GROUP_JID       — WhatsApp group JID (e.g. 1234567890-1234567@g.us)
 *   SERVICE_SECRET  — shared secret for request authentication
 */

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino    = require('pino');
const qrcode  = require('qrcode-terminal');

// ── Config ────────────────────────────────────────────────────

const PORT           = process.env.PORT || 3001;
const GROUP_JID      = process.env.GROUP_JID || '';
const SERVICE_SECRET = process.env.SERVICE_SECRET || 'change-me';
// On Railway, point this to the mounted volume path so session survives redeploys
const AUTH_INFO_PATH = process.env.AUTH_INFO_PATH || 'auth_info';

// ── State ─────────────────────────────────────────────────────

let sock        = null;
let isConnected = false;

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
    // Keep connection alive
    keepAliveIntervalMs: 30_000,
    // Don't download media — we only send text
    downloadHistory: false,
    syncFullHistory: false,
  });

  // Persist credentials whenever they update
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code with WhatsApp (Settings → Linked Devices → Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
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
      console.log('[Baileys] ✓ Connected to WhatsApp');

      if (!GROUP_JID) {
        console.log('[Baileys] ⚠  GROUP_JID is not set.');
        console.log('[Baileys]    Call GET /groups?secret=YOUR_SECRET to list your groups and find the JID.');
      } else {
        console.log(`[Baileys]    Sending alerts to group: ${GROUP_JID}`);
      }
    }
  });
}

// ── HTTP server ───────────────────────────────────────────────

const app = express();
app.use(express.json());

/** Simple auth check — reads secret from body or X-Secret header. */
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
 * Returns connection status. No auth required — safe to use as a health check.
 */
app.get('/health', (req, res) => {
  res.json({
    ok:       isConnected,
    groupJid: GROUP_JID || 'not configured',
  });
});

/**
 * GET /groups?secret=YOUR_SECRET
 * Lists all WhatsApp groups the connected account is a member of.
 * Use this to find your group's JID after scanning the QR code.
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
    // Sort alphabetically by name
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
});
