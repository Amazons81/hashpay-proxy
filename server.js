// server.js
// Proxy for the Aurix Capital Flutter app.
// Keeps the HashBack API key server-side and handles CORS for web builds.
//
// Flutter POSTs to /api/deposit with { amount, msisdn, reference, description }.
// The proxy attaches the API key + Aurix account ID and forwards to HashBack.
//
// Requires Node 18+ (built-in fetch).

const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());

// ── Env helpers ──
// Trim values: a stray space or newline pasted into Render env vars
// is a very common cause of "invalid / expired account" errors.
const env = (name, fallback = '') => (process.env[name] || fallback).trim();

// ── CORS ──
// Only affects browser/web builds. Android/iOS apps ignore CORS.
const DEFAULT_ORIGINS = [
  'https://tala-plum-one.vercel.app',
  'https://inukahela-eight.vercel.app',
  'https://web-hazel-beta-66.vercel.app',
  'https://tala1.vercel.app',
  'https://tala2.vercel.app',
  'https://tala3.vercel.app',
  'https://tala4.vercel.app',
  'https://fxone-theta.vercel.app',
  'https://talamkopo-murex.vercel.app',
  'https://www.aurixcapital.capital',
  'https://aurixcapital.vercel.app',
];

const allowedOrigins = env('ALLOWED_ORIGINS')
  ? env('ALLOWED_ORIGINS')
      .split(',')
      .map((o) => o.trim().replace(/\/$/, ''))
      .filter(Boolean)
  : DEFAULT_ORIGINS;

app.use(
  cors({
    origin: (origin, cb) => {
      // No Origin header = mobile app, curl, server-to-server → allow.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      console.warn('CORS blocked origin:', origin);
      return cb(new Error('Not allowed by CORS'));
    },
  })
);

// ── HashBack config (server-side only) ──
const HASHBACK_BASE_URL = env('HASHBACK_BASE_URL', 'https://api.hashback.co.ke');
const HASHBACK_API_KEY = env('HASHBACK_API_KEY');
const AURIX_ACCOUNT_ID = env('HASHBACK_ACCOUNT_ID_AURIX');
const CALLBACK_URL = env('CALLBACK_URL');

// Startup diagnostics (masked) — compare these with your HashBack dashboard.
console.log('── Aurix proxy config ──');
console.log('Base URL       :', HASHBACK_BASE_URL);
console.log('Account ID     :', AURIX_ACCOUNT_ID || '(MISSING)');
console.log(
  'API key        :',
  HASHBACK_API_KEY
    ? `${HASHBACK_API_KEY.slice(0, 4)}…${HASHBACK_API_KEY.slice(-4)} (len ${HASHBACK_API_KEY.length})`
    : '(MISSING)'
);
console.log('Callback URL   :', CALLBACK_URL || '(not set)');
console.log('Allowed origins:', allowedOrigins.length);

if (!HASHBACK_API_KEY) console.error('Missing HASHBACK_API_KEY in environment.');
if (!AURIX_ACCOUNT_ID) console.error('Missing HASHBACK_ACCOUNT_ID_AURIX in environment.');
if (!CALLBACK_URL) {
  console.warn(
    'Missing CALLBACK_URL. STK push will work but you will not receive payment confirmations.'
  );
}

// ── Call HashBack and always return { status, data } safely ──
async function callHashback(path, payload) {
  const resp = await fetch(`${HASHBACK_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { success: false, message: 'Non-JSON response from HashBack', raw: text.slice(0, 300) };
  }

  console.log(`HashBack ${path} → ${resp.status}`, JSON.stringify(data).slice(0, 400));
  return { status: resp.status, data };
}

// Health check
app.get('/health', (req, res) =>
  res.json({
    ok: true,
    service: 'aurix-proxy',
    configured: Boolean(HASHBACK_API_KEY && AURIX_ACCOUNT_ID),
  })
);

// ── STEP 1: initiate STK push ──
app.post('/api/deposit', async (req, res) => {
  try {
    const { amount, msisdn, reference, description } = req.body || {};

    if (!amount || !msisdn) {
      return res.status(400).json({ success: false, message: 'amount and msisdn are required' });
    }
    if (!HASHBACK_API_KEY || !AURIX_ACCOUNT_ID) {
      return res
        .status(500)
        .json({ success: false, message: 'Payment service is not configured on the server' });
    }

    const { status, data } = await callHashback('/initiatestk', {
      api_key: HASHBACK_API_KEY,
      account_id: AURIX_ACCOUNT_ID,
      amount,
      msisdn,
      reference: reference || `AURIX_${Date.now()}`,
      callback_url: CALLBACK_URL || undefined,
      description: description || 'Trading Account Deposit',
    });

    // Surface billing problems clearly in server logs.
    if (status === 403) {
      console.error(
        `HashBack 403 for account ${AURIX_ACCOUNT_ID}: "${data.message}". ` +
          'Check the subscription/expiry for THIS account ID in the HashBack dashboard, ' +
          'and that the API key belongs to the same login.'
      );
    }

    res.status(status).json(data);
  } catch (err) {
    console.error('Deposit proxy error:', err);
    res
      .status(502)
      .json({ success: false, message: 'Failed to reach HashBack', error: String(err) });
  }
});

// ── STEP 2: poll transaction status ──
app.post('/api/status', async (req, res) => {
  try {
    const { transaction_id } = req.body || {};

    if (!transaction_id) {
      return res.status(400).json({ success: false, message: 'transaction_id is required' });
    }
    if (!HASHBACK_API_KEY || !AURIX_ACCOUNT_ID) {
      return res
        .status(500)
        .json({ success: false, message: 'Payment service is not configured on the server' });
    }

    const { status, data } = await callHashback('/transactionstatus', {
      api_key: HASHBACK_API_KEY,
      account_id: AURIX_ACCOUNT_ID,
      transaction_id,
    });

    res.status(status).json(data);
  } catch (err) {
    console.error('Status proxy error:', err);
    res
      .status(502)
      .json({ success: false, message: 'Failed to reach HashBack', error: String(err) });
  }
});

// ── STEP 3: HashBack async callback ──
//   https://hashpay-proxy.onrender.com/api/hashpay-callback
app.post('/api/hashpay-callback', (req, res) => {
  console.log('HashBack callback received:', JSON.stringify(req.body));
  // TODO: verify signature (if provided), then credit the user's account in your DB.
  res.status(200).json({ received: true });
});

// ── Error handler (e.g. CORS rejections) ──
app.use((err, req, res, next) => {
  res.status(err.message === 'Not allowed by CORS' ? 403 : 500).json({
    success: false,
    message: err.message || 'Server error',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aurix HashBack proxy listening on port ${PORT}`);
});
