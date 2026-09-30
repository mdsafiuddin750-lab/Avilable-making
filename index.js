require('dotenv').config();
const fs = require('fs');
const express = require('express');
const cron = require('node-cron');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require('@whiskeysockets/baileys');

// ---------- helpers ----------
const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const bool = (k, d) => env(k, String(d)).toLowerCase() === 'true';
const digits = (s) => String(s || '').replace(/\D/g, '');
const list = (k) => env(k).split(',').map(digits).filter(Boolean);
const json = (k, d) => {
  try { return env(k) ? JSON.parse(env(k)) : d; }
  catch (e) { console.error(`[config] ${k} valid JSON nahi hai:`, e.message); return d; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- config (sab kuch env variables se) ----------
const cfg = {
  pairingNumber: digits(env('PAIRING_NUMBER')),
  adminKey: env('ADMIN_KEY'),
  replyMessage: env('REPLY_MESSAGE', 'Namaste {name}! Main abhi busy hoon, baad me reply karunga.'),
  replyGroups: bool('REPLY_TO_GROUPS', false),
  delay: Number(env('REPLY_DELAY_SECONDS', '2')) * 1000,
  cooldownMs: Number(env('COOLDOWN_MINUTES', '60')) * 60000,
  tz: env('TIMEZONE', 'Asia/Kolkata'),
  allowed: list('ALLOWED_NUMBERS'),
  blocked: list('BLOCKED_NUMBERS'),
  customReplies: json('CUSTOM_REPLIES', {}),
  keywordReplies: json('KEYWORD_REPLIES', {}),
  activeHours: env('ACTIVE_HOURS'),
  activeDays: env('ACTIVE_DAYS').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean),
  offlineMessage: env('OFFLINE_MESSAGE'),
  scheduled: json('SCHEDULED_MESSAGES', []),
  owner: digits(env('OWNER_NUMBER')) || digits(env('PAIRING_NUMBER')),
  authDir: env('AUTH_DIR', 'auth'),
  port: Number(env('PORT', '3000')),
};
if (!cfg.pairingNumber) console.warn('[config] PAIRING_NUMBER set nahi hai, pairing code nahi ban payega.');

const state = { enabled: bool('AUTO_REPLY_ENABLED', true), status: 'starting', pairingCode: null, sock: null };
const lastReplied = new Map();
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ---------- time / schedule ----------
function nowInTz() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: cfg.tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return { minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), day: get('weekday').toLowerCase().slice(0, 3), text: `${get('hour')}:${get('minute')}` };
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + (m || 0); };
function isActiveNow() {
  const n = nowInTz();
  if (cfg.activeDays.length && !cfg.activeDays.includes(n.day)) return false;
  if (!cfg.activeHours) return true;
  const [a, b] = cfg.activeHours.split('-').map((s) => toMin(s.trim()));
  return a <= b ? n.minutes >= a && n.minutes < b : n.minutes >= a || n.minutes < b; // midnight cross support
}
const fill = (tpl, ctx) => tpl.replace(/\{name\}/g, ctx.name || 'dost').replace(/\{time\}/g, nowInTz().text);

// ---------- reply logic ----------
function pickReply(number, text, name) {
  if (number === cfg.owner) return null;
  if (cfg.blocked.includes(number)) return null;
  if (cfg.allowed.length && !cfg.allowed.includes(number)) return null;

  const last = lastReplied.get(number) || 0;
  if (Date.now() - last < cfg.cooldownMs) return null;

  let reply = null;
  if (cfg.customReplies[number]) reply = cfg.customReplies[number];
  else if (isActiveNow()) {
    const t = (text || '').toLowerCase();
    const hit = Object.keys(cfg.keywordReplies).find((k) => t.includes(k.toLowerCase()));
    reply = hit ? cfg.keywordReplies[hit] : cfg.replyMessage;
  } else reply = cfg.offlineMessage || null;

  return reply ? fill(reply, { name }) : null;
}

function getText(m) {
  const x = m.message || {};
  return x.conversation || x.extendedTextMessage?.text || x.imageMessage?.caption || x.videoMessage?.caption || '';
}

async function handleOwnerCommand(sock, jid, text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const say = (t) => sock.sendMessage(jid, { text: t });
  if (cmd === '!on') { state.enabled = true; return say('Auto reply ON'); }
  if (cmd === '!off') { state.enabled = false; return say('Auto reply OFF'); }
  if (cmd === '!status') return say(`Auto reply: ${state.enabled ? 'ON' : 'OFF'}\nActive abhi: ${isActiveNow()}\nTime (${cfg.tz}): ${nowInTz().text}`);
  if (cmd === '!send') {
    const num = digits(rest.shift());
    if (!num || !rest.length) return say('Use: !send 919999999999 message');
    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: rest.join(' ') });
    return say('Bhej diya.');
  }
  return say('Commands: !on, !off, !status, !send <number> <msg>');
}

// ---------- scheduled messages ----------
let cronJobs = [];
function setupSchedules() {
  cronJobs.forEach((j) => j.stop());
  cronJobs = [];
  for (const s of Array.isArray(cfg.scheduled) ? cfg.scheduled : []) {
    const num = digits(s.number);
    if (!num || !s.time || !s.message) continue;
    const [h, m] = s.time.split(':').map(Number);
    let dow = '*';
    if (Array.isArray(s.days) && s.days.length) {
      dow = s.days.map((d) => DAYS.indexOf(String(d).toLowerCase().slice(0, 3))).filter((i) => i >= 0).join(',') || '*';
    }
    const job = cron.schedule(`${m} ${h} * * ${dow}`, async () => {
      if (!state.sock || state.status !== 'connected') return console.log('[schedule] bot connected nahi, skip');
      try {
        await state.sock.sendMessage(`${num}@s.whatsapp.net`, { text: fill(s.message, {}) });
        console.log(`[schedule] bheja -> ${num}`);
      } catch (e) { console.error('[schedule] error:', e.message); }
    }, { timezone: cfg.tz });
    cronJobs.push(job);
  }
  console.log(`[schedule] ${cronJobs.length} job(s) set`);
}

// ---------- WhatsApp connection ----------
async function start() {
  const { state: auth, saveCreds } = await useMultiFileAuthState(cfg.authDir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, logger) },
    markOnlineOnConnect: false,
  });
  state.sock = sock;
  sock.ev.on('creds.update', saveCreds);

  if (!sock.authState.creds.registered && cfg.pairingNumber) {
    state.status = 'waiting_pairing';
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cfg.pairingNumber);
        state.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n==== PAIRING CODE:', state.pairingCode, '====\n');
      } catch (e) { console.error('[pairing] error:', e.message); }
    }, 4000);
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      state.status = 'connected'; state.pairingCode = null;
      console.log('[wa] connected');
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      state.status = 'disconnected';
      if (code === DisconnectReason.loggedOut) {
        console.log('[wa] logout ho gaya, session delete karke naya pairing code bana raha hoon');
        fs.rmSync(cfg.authDir, { recursive: true, force: true });
      }
      await sleep(3000);
      start();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        const jid = m.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const isGroup = jid.endsWith('@g.us');
        if (isGroup && !cfg.replyGroups) continue;
        const number = digits(jid.split('@')[0].split(':')[0]);
        const text = getText(m);

        // owner commands (apne number se, self chat me ya owner ke message se)
        if (text.startsWith('!') && number === cfg.owner && !isGroup) { await handleOwnerCommand(sock, jid, text); continue; }
        if (m.key.fromMe) continue;
        if (!state.enabled) continue;

        const reply = pickReply(number, text, m.pushName);
        if (!reply) continue;
        lastReplied.set(number, Date.now());
        await sock.sendPresenceUpdate('composing', jid);
        await sleep(cfg.delay);
        await sock.sendMessage(jid, { text: reply }, { quoted: m });
        await sock.sendPresenceUpdate('paused', jid);
      } catch (e) { console.error('[msg] error:', e.message); }
    }
  });
}

// ---------- web server (Render/Railway ke liye zaroori) ----------
const app = express();
app.get('/health', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.json({ status: state.status, autoReply: state.enabled, activeNow: isActiveNow() }));
app.get('/pair', (req, res) => {
  if (cfg.adminKey && req.query.key !== cfg.adminKey) return res.status(401).send('Unauthorized');
  const body = state.pairingCode
    ? `<h1 style="font-size:48px;letter-spacing:6px">${state.pairingCode}</h1><p>WhatsApp > Linked devices > Link with phone number instead > ye code daalo</p>`
    : `<p>Status: <b>${state.status}</b>${state.status === 'connected' ? ' (already linked)' : ' - thodi der baad refresh karo'}</p>`;
  res.send(`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:sans-serif;text-align:center;padding:40px">${body}</body>`);
});
app.listen(cfg.port, () => console.log(`[web] port ${cfg.port}`));

setupSchedules();
start();
